# Deployment (requirements 3.1 and 3.2)

The infrastructure is in `infra/terraform/`. It has been validated (`terraform fmt`, `validate`, run in CI) but **never applied to a real AWS account**: no account was used for this exercise. Treat it as a reviewed starting point, and expect to adjust it on the first real `plan`.

## What gets deployed

```
Internet -> ALB (HTTPS) -> ECS Fargate: api (N tasks, autoscaled)
                           ECS Fargate: worker (embeddings, scheduled retention)
                           ECS one-off task: migrate (per release)
                                |-> RDS PostgreSQL 16 + pgvector (private, TLS, KMS)
                                |-> ElastiCache Redis (private, TLS, auth token, KMS)
                                |-> OpenAI / Anthropic over HTTPS through the NAT gateway
```

The task security group only allows outbound 443, PostgreSQL and Redis. The data stores accept connections only from that group.

## Where the AI API keys live

In **AWS Secrets Manager**, one secret per provider (`docuchat/<env>/openai-api-key`, `…/anthropic-api-key`), encrypted with a customer-managed KMS key.

- Terraform creates the empty secret and the IAM permission to read it. **It never sees the value.** A person stores it once with `infra/scripts/put-secret.sh`, which reads it from a hidden prompt or stdin (never a command-line argument, a file, a `.tfvars` or shell history).
- ECS injects the value into the container as an environment variable at start (`secrets`, not `environment`), using the **execution role**. That role can read only the listed secret ARNs and decrypt with the one key.
- The **task role** (what the application code runs as) has **no permissions at all**. The app talks to Postgres, Redis and the providers, none of which use IAM, so a compromised container cannot read any other secret.
- Nothing is baked into the image and nothing is in the repository. CI runs `infra/scripts/check-no-secrets.sh` to fail on committed keys, key blocks, tracked `.env`/`.tfvars`/state files or literal secrets in Terraform.

Every other secret is also generated rather than typed:

| Secret | How it gets its value | In Terraform state |
|---|---|---|
| Database master password | RDS generates it and keeps it in Secrets Manager (`manage_master_user_password`) | no |
| Redis auth token, JWT secrets | `ephemeral "random_password"` written through write-only arguments (Terraform 1.11+) | no |
| Provider API keys | a person, with `put-secret.sh` | no (never given to Terraform) |

Configuration that is not secret (provider choice, budgets, prompt versions, retention) is plain `environment`, set from Terraform variables (`var.app_environment`). Config and code are separate: the same image runs in every environment.

## Rotation

| Secret | Procedure | Downtime |
|---|---|---|
| **Provider API key** | 1. Create a new key at the provider. 2. `put-secret.sh <secret>` with the new value. 3. `aws ecs update-service --force-new-deployment` for `api` and `worker`: new tasks start with the new key while old tasks drain with the old one. 4. Revoke the old key at the provider. The overlap window is the deployment, so nothing fails in between. | none |
| **Database password** | RDS manages it. Enable automatic rotation on the managed secret (every 7 to 30 days) and force a new deployment afterwards, or keep tasks short-lived. Tasks read it at start, so they pick up the new value on their next start. A task that started before a rotation keeps working until its connections are recycled, because Postgres accepts the old password until the rotation completes. | none if deployments are rolling |
| **Redis auth token** | Raise `redis_auth_token_version` and apply: the new token is written to ElastiCache and to the secret in the same run, then redeploy. | brief reconnects (rate limits fail open, see `docs/COSTS.md`) |
| **JWT secrets** | Raise `jwt_secret_version`. **This signs every user out** (access tokens stop verifying, refresh tokens too). Acceptable for a leak, avoid it routinely. A no-logout rotation needs a key id and two verifying keys; it is listed as a next step. | all sessions end |

If a provider key leaks: revoke it first, then rotate. The per-user budget (spec 006) limits how much anyone can spend through the app in the meantime, but not what a stolen key can spend directly at the provider, so set a **hard spend limit in the provider console** too.

## Bursty AI usage

What actually limits a burst, in order:

1. **The provider's rate limits** (requests and tokens per minute). More tasks do not raise them. Past a point, more concurrency only produces 429s. Hence `autoscaling_max_capacity` is a cost and quota decision, not a capacity one.
2. **Per-user and global limits in the app** (spec 006): Redis rate limits, a daily token budget per user reserved before the call and settled after, and bounded request sizes. A single user cannot absorb the provider quota.
3. **Retry with backoff and `Retry-After`, then a fallback provider** for completions (spec 002), so a provider 429/5xx degrades instead of failing.
4. **A queue in front of slow work.** Embedding runs on BullMQ workers, off the request path, so a bulk upload cannot starve chat.
5. **Autoscaling the API** on **requests per task** (primary) and CPU (safety net). An API task mostly waits for the model, so CPU stays low while connections accumulate: CPU alone would scale too late. Scale out after 60 s, scale in after 300 s, because a burst usually returns and streams are in flight.

## ECS Fargate, EKS or serverless

**Chosen: ECS Fargate.** Reasons specific to this workload:

- **Long-lived streaming connections.** An answer streams for seconds to a minute. That fits a long-running container behind an ALB, and fits Lambda badly: you pay for the whole time the function waits on the model, response streaming adds constraints, and the maximum duration and API Gateway timeouts get in the way.
- **A steady worker** consuming a queue and running a scheduled job is natural as a service, awkward as functions.
- **No cluster to operate.** For one backend, EKS adds a control plane, node upgrades, add-ons and ingress controllers with no benefit yet.
- **Connection-heavy dependencies.** Postgres and Redis prefer a small number of long-lived connections; Lambda concurrency multiplies them and needs RDS Proxy.

**When the answer changes:** EKS when there are many services, a platform team, GPU or self-hosted models, or portability needs; Lambda (or Lambda plus a queue) for spiky, short, non-streaming work such as document processing at low volume.

## Scaling constraints specific to AI workloads

- **Provider quotas are the real ceiling** (see above), per key and per model. Plan for quota increases or multiple keys/accounts before traffic arrives, not after.
- **Latency is dominated by the model**, so scale on concurrency, not CPU. A slow provider also raises concurrency for the same traffic.
- **Streaming holds capacity.** Each open stream occupies a connection on a task for its whole duration. The ALB idle timeout is raised to 120 s (the API sends a heartbeat every 15 s) and deployments drain tasks for 60 s so answers in flight finish (`SHUTDOWN_GRACE_MS`, `stopTimeout`, target deregistration delay).
- **Cost scales with tokens, not requests.** Alarms on AWS spend (`monitoring.tf`) do not see the provider bill. The application budget, the cache and the cost model in `docs/COSTS.md` do.
- **Embedding throughput** is a batch problem with its own provider limits; it runs on workers and can be scaled separately from the API.
- **pgvector grows with data.** HNSW search quality and memory depend on index size; the database, not the API, becomes the bottleneck first. Move to a larger instance class, read replicas for search, or a dedicated vector store when it does (ADR in `docs/adr/`).
- **Cold starts**: a new task takes about 30 to 60 s to be healthy, so autoscaling reacts after a burst has started. Keep `autoscaling_min_capacity` at the baseline you can afford, and the per-user limits protect the window in between.

## Release procedure

1. Build and push the image tagged with the git SHA. Never deploy `latest`.
2. Run the migration task once (`terraform output migrate_command`) and wait for exit code 0. Migrations are forward-only and written to be compatible with the previous release, so old tasks keep running during the rollout.
3. Update `app_image` and apply. ECS starts new tasks, waits for health checks, and drains old ones. The **deployment circuit breaker rolls back automatically** if the new tasks never become healthy.

## Remote state and first apply

State holds resource IDs and some configuration, so it must be encrypted and locked. Create an S3 bucket (versioned, encrypted, public access blocked) and a DynamoDB lock table, then uncomment the `backend "s3"` block in `main.tf`. Generated secrets do not reach the state (write-only/ephemeral), but treat it as sensitive anyway.

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # edit; no secrets belong here
terraform init
terraform plan
terraform apply
infra/scripts/put-secret.sh docuchat/prod/openai-api-key      # for each name in: terraform output secret_names_to_fill
aws ecs update-service --cluster <cluster> --service api --force-new-deployment   # tasks wait for the key until it exists
eval "$(terraform output -raw migrate_command)"
```

## Data protection notes

- Backups (`db_backup_retention_days`, 7 by default) contain data that a user later deleted with `DELETE /auth/me`. It leaves the backups when they expire. State this when answering an erasure request; shorten retention if the policy requires it.
- Logs go to CloudWatch for `log_retention_days` and contain no prompt or document content (`docs/AI-DATA.md`).
- Encryption: RDS and ElastiCache at rest with the CMK, TLS in transit everywhere (database `rds.force_ssl` plus certificate verification in the app, Redis TLS, ALB HTTPS).

## Known gaps

- Not applied to a real account. Costs, quotas and names were not exercised.
- No WAF in front of the ALB, no CDN, single region, no cross-region backup copies.
- JWT rotation without logging users out, and automatic rotation of the provider keys, are not implemented.
- `tflint`/`checkov` are not run in CI; adding them is a cheap next step.

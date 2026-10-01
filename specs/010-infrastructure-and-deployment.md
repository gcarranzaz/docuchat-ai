# 010 — Infrastructure (Terraform/AWS), secrets, containers, deployment

**Brief:** 3.1 "Infrastructure definition (Terraform or CloudFormation)", "Secure handling of secrets (no plaintext keys)", "Separation of config vs code", "Explain: where AI API keys live, how you would rotate them, how you'd scale under bursty AI usage". 3.2 "Dockerize backend", "Show how you'd deploy it: ECS, EKS, or serverless", "Explain scaling constraints specific to AI workloads".

## Current state (before this spec)
- `infra/terraform/main.tf` (787 lines) had the plaintext-secret pattern the brief warns about: database password, JWT secrets and API keys were Terraform variables, so they ended up in `.tfvars` and in state; the task role could read more than it needed; no HTTPS, no idle timeout for streaming, no autoscaling signal that fits AI traffic, no migration path.
- Backend and frontend Dockerfiles build.

## Scope
- **Audit `main.tf` against the brief** and fix gaps:
  - API keys (OpenAI/Anthropic) and JWT secrets in AWS Secrets Manager; injected into the ECS task as `secrets` (not `environment`); Terraform creates the secret *containers*, values are set out of band and never appear in `.tfvars` or state in plaintext.
  - Database password generated and stored in Secrets Manager (not a variable default).
  - Non-secret config via variables, none baked into the image.
  - Least-privilege task execution role limited to the specific secret ARNs.
  - RDS encrypted with KMS, in private subnets, not publicly accessible; pgvector extension enabled by migration.
  - ALB idle timeout raised for streaming; health check on `/health`.
  - ECS service autoscaling (CPU and request count) with sensible min/max; worker service separate from the API service.
- **`docs/DEPLOYMENT.md`** answering the brief:
  - *Where keys live:* Secrets Manager, injected by the execution role.
  - *Rotation:* overlap window per secret type.
  - *Bursty usage:* autoscaling on request count, a queue in front of the slow work, per-user limits (spec 006), provider rate limits as the real ceiling, retry with backoff and fallback, graceful degradation.
  - *ECS Fargate vs EKS vs serverless:* why Fargate here; when EKS or Lambda would win.
  - *Scaling constraints specific to AI workloads:* provider quotas, long-lived streams, latency dominated by the model, cost scales with tokens, embedding throughput, pgvector growth.
- Compose file runs the whole stack locally with the mock provider (`docker compose up`).
- CI: `terraform fmt -check`, `init -backend=false`, `validate`, plus a committed-secrets check.

## Result

Rewritten as one file per concern (`infra/terraform/*.tf`, map in its README). Verified: `terraform fmt -check` and `terraform validate` pass (Terraform 1.11+, AWS provider 6); the backend image builds with the RDS CA bundle and contains `dist/workers/start-worker.js` and `dist/config/migrate.js`; `infra/scripts/check-no-secrets.sh` passes and runs in CI.

- No secret is a Terraform input. DB password: RDS-managed. Redis token and JWT secrets: ephemeral values through write-only arguments (not in state). Provider keys: empty containers filled by `infra/scripts/put-secret.sh` (hidden prompt or stdin).
- Execution role reads only the listed secret ARNs plus `kms:Decrypt` on one key; the task role has no permissions.
- One customer-managed KMS key (rotation on) for RDS, ElastiCache and secrets; RDS `rds.force_ssl`, the app verifies the certificate (`DB_SSL=verify` with the CA bundle shipped in the image); Redis TLS and auth token.
- ALB: HTTPS required in prod (precondition), redirect, `/health`, idle timeout 120 s for streaming, 60 s deregistration delay, task `stopTimeout` 60 s and `SHUTDOWN_GRACE_MS` 45 s.
- API and worker are separate services; migrations are a one-off task (`terraform output migrate_command`); deployment circuit breaker with rollback.
- Autoscaling on requests per task (primary) and CPU; alarms and a monthly AWS budget when `alert_email` is set.
- Task security group egress is limited to 443, PostgreSQL and Redis. The PostgreSQL and Redis rules are separate resources: inline they formed a dependency cycle with the data stores' groups (found by `terraform validate`).
- `docs/DEPLOYMENT.md` answers: where keys live, rotation per secret, bursty usage, ECS vs EKS vs serverless, AI-specific scaling constraints.

**Honest limits.** Never applied to a real account, so resource names, quotas and the first `plan` are unproven. No WAF/CDN/multi-region. JWT rotation signs users out. `tflint`/`checkov` not run. Egress on 443 goes to anywhere (provider endpoints have no stable IPs).

## Acceptance criteria
- [x] No secret value appears in any `.tf`, `.tfvars.example`, Dockerfile or compose file (grep check in CI).
- [x] `terraform validate` passes.
- [x] `docs/DEPLOYMENT.md` answers every bullet of 3.1 and 3.2.
- [x] The full stack runs locally with the mock provider (`docker compose up`; re-checked in the final verification).

## Out of scope
Applying the infrastructure to a real AWS account, multi-region, CDN.

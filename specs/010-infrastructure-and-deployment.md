# 010 — Infrastructure (Terraform/AWS), secrets, containers, deployment

**Brief:** 3.1 "Infrastructure definition (Terraform or CloudFormation)", "Secure handling of secrets (no plaintext keys)", "Separation of config vs code", "Explain: where AI API keys live, how you would rotate them, how you'd scale under bursty AI usage". 3.2 "Dockerize backend", "Show how you'd deploy it: ECS, EKS, or serverless", "Explain scaling constraints specific to AI workloads".

## Current state
- `infra/terraform/main.tf` (about 787 lines) covers VPC, ECS Fargate, RDS, ElastiCache and ALB per the README. **Not yet audited:** how secrets are created and injected, whether any value is in plaintext, autoscaling, SSE support on the ALB.
- Backend and frontend Dockerfiles build (verified after fixing `.dockerignore`).
- `terraform` is not installed locally; validation runs in CI.

## Scope
- **Audit `main.tf` against the brief** and fix gaps:
  - API keys (OpenAI/Anthropic) and JWT secrets in AWS Secrets Manager; injected into the ECS task as `secrets` (not `environment`); Terraform creates the secret *containers*, values are set out of band and never appear in `.tfvars` or state in plaintext (document the `ignore_changes` approach).
  - Database password generated and stored in Secrets Manager (not a variable default).
  - Non-secret config via variables/SSM, none baked into the image.
  - Least-privilege task execution role limited to the specific secret ARNs.
  - RDS encrypted with KMS, in private subnets, not publicly accessible; pgvector extension enabled by migration.
  - ALB idle timeout raised for streaming; health check on `/health`.
  - ECS service autoscaling (CPU and request count) with sensible min/max; worker service separate from the API service.
- **`docs/DEPLOYMENT.md`** answering the brief:
  - *Where keys live:* Secrets Manager, read only by the task role.
  - *Rotation:* dual-key overlap window (create new key at the provider, add as `…_NEXT`, deploy, switch, revoke old); Secrets Manager rotation Lambda for the DB; JWT secret rotation with key ID.
  - *Bursty usage:* autoscaling on request count, a queue in front of the slow work (embedding already async), per-user limits (spec 006), provider TPM/RPM as the real ceiling, retry with backoff and circuit breaker, graceful degradation.
  - *ECS Fargate vs EKS vs serverless:* why Fargate here (no cluster to run, long-lived SSE connections, steady worker); when EKS or Lambda would win.
  - *Scaling constraints specific to AI workloads:* provider rate limits and quotas, long-lived streaming connections tie up capacity, latency dominated by the model so scale on concurrency not CPU, cost scales with tokens, embedding batch throughput, pgvector index size and recall as data grows.
- Compose file runs the whole stack locally with the mock provider (`docker compose up`).
- CI: `terraform fmt -check`, `init -backend=false`, `validate`; optional `tflint`/`checkov` noted as next steps.

## Acceptance criteria
- [ ] No secret value appears in any `.tf`, `.tfvars.example`, Dockerfile or compose file (grep check added to CI).
- [ ] `terraform validate` passes in CI.
- [ ] `docs/DEPLOYMENT.md` answers every bullet of 3.1 and 3.2.
- [ ] `docker compose up` brings up API, worker, frontend, Postgres/pgvector and Redis; `/health` is green.

## Out of scope
Applying the infrastructure to a real AWS account, multi-region, CDN.

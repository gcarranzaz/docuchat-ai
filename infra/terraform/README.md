# DocuChat infrastructure (Terraform, AWS)

Validated with `terraform fmt -check` and `terraform validate`; **not applied to a real account**.
The reasoning, rotation procedures, scaling and the ECS-vs-EKS-vs-serverless comparison are in
[`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md). This file is the map.

| File | Contents |
|---|---|
| `main.tf` | Providers, versions (Terraform 1.11+, AWS provider 6), optional S3 backend |
| `network.tf` | VPC, public/private subnets, NAT, security groups (tasks may only reach 443, Postgres, Redis) |
| `kms.tf` | One customer-managed key with rotation |
| `database.tf` | RDS PostgreSQL 16, encrypted, private, TLS enforced, RDS-managed master password |
| `cache.tf` | ElastiCache Redis replication group, TLS, auth token, encrypted at rest |
| `secrets.tf` | Secrets Manager: generated (write-only) and person-provided (empty container) secrets |
| `iam.tf` | Execution role (reads listed secrets only) and a task role with no permissions |
| `alb.tf` | HTTPS listener (required in prod), redirect, `/health` check, raised idle timeout |
| `ecs.tf` | Cluster, API service, worker service, one-off migration task, circuit breaker |
| `autoscaling.tf` | Scaling on requests per task and CPU |
| `monitoring.tf` | Alarms, SNS and a monthly AWS budget (when `alert_email` is set) |

```bash
cp terraform.tfvars.example terraform.tfvars   # configuration only, no secrets
terraform init && terraform plan
```

Secrets are never Terraform inputs. Provider API keys are stored with `../scripts/put-secret.sh`.
`../scripts/check-no-secrets.sh` runs in CI.

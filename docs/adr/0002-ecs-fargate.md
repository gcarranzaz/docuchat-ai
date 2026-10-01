# ADR 0002: ECS Fargate instead of EKS or Lambda

**Status:** accepted

## Context
The backend is one containerised API with long-lived streaming responses, a queue worker and a scheduled job, with bursty traffic that is limited by an external provider's rate limits.

## Decision
Run the API and the worker as ECS Fargate services behind an Application Load Balancer, with a one-off Fargate task for migrations. Details and the other options are in [DEPLOYMENT.md](../DEPLOYMENT.md).

## Consequences
- No cluster or nodes to patch; deployments roll with health checks and an automatic rollback (circuit breaker).
- Streaming fits: a task holds a connection for as long as the model generates, behind an ALB with a raised idle timeout.
- Scaling is by task count on requests per task. A new task takes tens of seconds, so a sharp burst is absorbed first by per-user limits and the provider's own queueing, not by new capacity.
- Less portable than Kubernetes and no fine control over placement. Acceptable for one service.

## Alternatives considered
- **EKS:** worth it with many services, a platform team, GPUs or self-hosted models. Its control plane and upgrade burden is pure overhead here.
- **Lambda:** pays for the whole time a function waits on the model, response streaming and duration limits add friction, and concurrency multiplies database connections (needs RDS Proxy). It would suit short, bursty, non-streaming work.

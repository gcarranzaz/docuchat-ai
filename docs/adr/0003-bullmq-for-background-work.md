# ADR 0003: BullMQ on Redis for background work instead of SQS

**Status:** accepted

## Context
Embedding a document is slow and bursty, and must not run inside an HTTP request. The app also needs Redis for rate limits and the answer cache, and a daily retention job.

## Decision
Use BullMQ (Redis) for the embedding queue and the scheduled retention job.

## Consequences
- **No extra infrastructure:** Redis is already there (ElastiCache in AWS), and the same stack runs locally with `docker compose`, with no emulator.
- Retries with backoff, per-job status (the UI polls `/jobs/documents/:id`) and repeatable jobs come built in.
- **Durability is only as good as Redis.** Redis is configured with AOF locally and replication with automatic failover in AWS, but it is not a managed durable queue. A document whose job is lost can be re-embedded, because the text is stored in PostgreSQL; there is no automatic reconciliation sweep yet.
- Workers must connect to Redis directly, so the worker runs in the VPC (it does).

## Alternatives considered
**SQS** is more durable and fully managed, with a dead-letter queue. It adds an AWS-only dependency that cannot run locally without an emulator, and needs a separate scheduler for the retention job. Reasonable choice if queue durability becomes critical.

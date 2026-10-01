# Specs

Each spec cites the line of the assessment brief it answers, states the verified current state, and ends with checkable acceptance criteria. Tier: MUST = required by the brief; BONUS = optional section we chose; OPTIONAL = only if time allows.

| # | Spec | Brief | Tier | Status |
|---|---|---|---|---|
| [001](001-tests-ci.md) | Tests, CI, green build | Engineering judgment | MUST | done (CI unverified until pushed) |
| [002](002-llm-provider-switching.md) | Switchable LLM providers | 1.2 | MUST | todo |
| [003](003-prompts-and-input-safety.md) | Prompt registry, separation, injection safety | 1.2 | MUST | todo |
| [004](004-streaming-and-ai-aware-ux.md) | Streaming + AI-aware UX | 1.3, bonus | MUST + BONUS | todo |
| [005](005-refine-feedback-uncertainty.md) | Re-ask, feedback, uncertainty | 1.3 | MUST | todo |
| [006](006-cost-and-rate-limits.md) | Cost control and rate limits | 1.2 | MUST | todo |
| [007](007-auth-refresh-and-integration-tests.md) | Auth hardening + integration tests | 1.2 | MUST | todo |
| [008](008-data-pii-audit-retention.md) | Data, retention, PII, audit | 2.1 | MUST | todo |
| [009](009-evaluation-and-reliability.md) | Evaluation and reliability | 2.2 | MUST | todo |
| [010](010-infrastructure-and-deployment.md) | Terraform, secrets, containers | 3.1, 3.2 | MUST | todo |
| [011](011-tool-calling-optional.md) | Tool calling | bonus | OPTIONAL | todo |
| [012](012-tenant-isolation.md) | Tenant isolation | bonus | BONUS | todo |
| [013](013-docs-readme-costs.md) | README, architecture, costs, ADRs | Deliverables, bonus | MUST + BONUS | todo |

Already covered by the imported base and only documented/tested here: RAG with pgvector (2.1 bonus) and background processing with BullMQ (bonus).

Suggested order: 002 → 003 → 007 → 006 → 004 → 005 → 012 → 008 → 009 → 010 → 013 → 011 (if time).

# Specs

Each spec cites the requirement it covers, states the verified current state, and ends with checkable acceptance criteria. Tier: CORE = required; EXTRA = optional section we chose; OPTIONAL = only if time allows.

| # | Spec | Req | Tier | Status |
|---|---|---|---|---|
| [001](001-tests-ci.md) | Tests, CI, green build | Engineering judgment | CORE | done (CI unverified until pushed) |
| [002](002-llm-provider-switching.md) | Switchable LLM providers | 1.2 | CORE | done (live-verified against Anthropic) |
| [003](003-prompts-and-input-safety.md) | Prompt registry, separation, injection safety | 1.2 | CORE | done (live-verified against Anthropic) |
| [004](004-streaming-and-ai-aware-ux.md) | Streaming + AI-aware UX | 1.3, extra | CORE + EXTRA | done (browser-verified) |
| [005](005-refine-feedback-uncertainty.md) | Re-ask, feedback, uncertainty | 1.3 | CORE | done (browser-verified) |
| [006](006-cost-and-rate-limits.md) | Cost control and rate limits | 1.2 | CORE | done |
| [007](007-auth-refresh-and-integration-tests.md) | Auth verification + integration tests | 1.2 | CORE | done |
| [008](008-data-pii-audit-retention.md) | Data, retention, PII, audit | 2.1 | CORE | done (leak check mutation-verified) |
| [009](009-evaluation-and-reliability.md) | Evaluation and reliability | 2.2 | CORE | done (live 14/14 on a real model) |
| [010](010-infrastructure-and-deployment.md) | Terraform, secrets, containers | 3.1, 3.2 | CORE | done (validated, not applied) |
| [011](011-tool-calling-optional.md) | Tool calling | extra | OPTIONAL | done (off by default) |
| [012](012-tenant-isolation.md) | Tenant isolation | extra | EXTRA | done (mutation-checked) |
| [013](013-docs-readme-costs.md) | README, architecture, costs, ADRs | Docs, extra | CORE + EXTRA | done |

Already covered by the imported base and only documented/tested here: RAG with pgvector (2.1 extra) and background processing with BullMQ (extra).

Suggested order: 002 → 003 → 007 → 006 → 004 → 005 → 012 → 008 → 009 → 010 → 013 → 011 (if time).

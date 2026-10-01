# Compliance matrix

Maps each item of the assessment brief to evidence in this repo.
Tier: **MUST** (required by the brief), **BONUS** (optional section we chose), **OPTIONAL** (only if time allows), **DROPPED** (out of scope, reason given).
Status: ✅ done, 🟡 partial, ⬜ todo.

| Brief | Requirement | Tier | Evidence | Spec | Status |
|---|---|---|---|---|---|
| 1.1 | Submit content, chat with AI, structured output | MUST | `documents`, `chat`, `extractions` routes | base | 🟡 |
| 1.2 | REST API, AI endpoint, Postgres, JWT | MUST | `backend/src/routes`, `migrations/` | base, 007 | 🟡 |
| 1.2 | Separate prompt / invocation / post-processing | MUST | `ai/prompts`, `ai/providers`, `ai/postprocessing` | base, 003 | 🟡 |
| 1.2 | Switch LLM providers | MUST | `providerFactory.ts` | 002 | ⬜ |
| 1.2 | Prompt versioning/config | MUST | `promptBuilder.ts`, `messages.prompt_version` | 003 | 🟡 |
| 1.2 | Explain prompt injection | MUST | `docs/SECURITY.md` | 003, 013 | ⬜ |
| 1.2 | Explain cost and rate limits | MUST | `docs/SECURITY.md`, `docs/COSTS.md` | 006, 013 | ⬜ |
| 1.3 | ≥2 pages, form, readable output, loading/error/empty | MUST | `frontend/src/pages` | 004 | 🟡 |
| 1.3 | Model status, re-ask, uncertainty handling | MUST | streaming, confidence badge, regenerate | 004, 005 | ⬜ |
| 2.1 | Stored vs not stored, retention, PII, logging, audit | MUST | `docs/AI-DATA.md`, `audit_log` | 008 | ⬜ |
| 2.1 | Vector store + RAG | BONUS | pgvector, `rag/` | base | ✅ |
| 2.2 | Quality, regressions, wrong answers | MUST | `docs/EVALUATION.md`, small golden set + `npm run eval` | 009 | ⬜ |
| 3.1 | Terraform, no plaintext secrets, config vs code | MUST | `infra/terraform` | 010 | 🟡 |
| 3.1 | Key location, rotation, bursty scaling | MUST | `docs/DEPLOYMENT.md` | 010 | ⬜ |
| 3.2 | Docker + ECS/EKS/serverless + AI scaling limits | MUST (strong signal) | Dockerfiles, `docs/DEPLOYMENT.md` | 010 | 🟡 |
| Bonus | Streaming responses | BONUS | SSE endpoint + hook | 004 | ⬜ |
| Bonus | Background processing | BONUS | BullMQ worker (document and test only) | base | 🟡 |
| Bonus | Cost estimation 1k/10k/100k | BONUS | `docs/COSTS.md` | 013 | ⬜ |
| Bonus | Multi-tenant isolation | BONUS | `user_id` filters + cross-user tests | 012 | ⬜ |
| Bonus | Tool/function calling | OPTIONAL | read-only tool; if skipped, explained in README | 011 | ⬜ |
| Deliverable | README: architecture, AI choices, trade-offs, run locally | MUST | `README.md` | 013 | 🟡 |
| Extra | Architecture diagram, ADRs, limitations section, demo data | extra | `docs/ARCHITECTURE.md`, `docs/adr/` | 013 | ⬜ |

## Dropped on purpose
- bcrypt → argon2 migration: no security gain worth the churn for this scope.
- Next.js, GraphQL, EKS: the brief marks them optional; Vite + REST + ECS Fargate already meet the requirements.
- Full evaluation framework, OCR, multi-org: brief says a short explanation is enough.

# Compliance matrix

Maps each item of the assessment brief to evidence in this repo, with the limits stated.
Tier: **MUST** (required by the brief), **BONUS** (optional section chosen), **OPTIONAL** (only if time allows), **DROPPED** (out of scope, reason given).
Status: ✅ done and verified, 🟡 done with a limit that is stated, ⬜ not done.

| Brief | Requirement | Tier | Evidence | Spec | Status |
|---|---|---|---|---|---|
| 1.1 | Submit content, chat with AI, structured output | MUST | `documents`, `chat`, `extractions` routes; React app; chat answers validated against a schema | base, 003 | ✅ |
| 1.2 | REST API, AI endpoint, Postgres, JWT | MUST | `backend/src/routes`, `backend/migrations`, `tests/integration/auth.test.ts` (login, refresh rotation, reuse detection) | base, 007 | ✅ |
| 1.2 | Separate prompt / invocation / post-processing | MUST | `ai/prompts`, `ai/providers`, `ai/postprocessing`, `ai/pipeline/chatPipeline.ts`; [ARCHITECTURE.md](ARCHITECTURE.md) | 003 | ✅ |
| 1.2 | Switch LLM providers | MUST | `ai/providers/` (OpenAI, Anthropic, mock; retry, fallback), provider unit tests; Anthropic run live (`npm run smoke:anthropic`) | 002 | 🟡 OpenAI not run live |
| 1.2 | Prompt versioning/config | MUST | `ai/prompts/{templates,registry}.ts`, `PROMPT_VERSION_*`, `prompt_version` and `model_used` stored per answer | 003 | ✅ |
| 1.2 | Explain prompt injection | MUST | [SECURITY.md](SECURITY.md); injection cases in the golden set | 003 | 🟡 defense in depth, not a guarantee (stated) |
| 1.2 | Explain cost and rate limits | MUST | [SECURITY.md](SECURITY.md) (cost section), [COSTS.md](COSTS.md); `budget.service.ts`, Redis limits, `tests/integration/{budget,cost-control,ratelimit}.test.ts` | 006, 013 | 🟡 upload summary call not budgeted (stated) |
| 1.3 | ≥2 pages, form, readable output, loading/error/empty | MUST | `frontend/src/pages` (Login, Documents/History, Chat); frontend tests; browser-verified | 004 | ✅ |
| 1.3 | Model status, re-ask, uncertainty handling | MUST | streaming status, citations, LOW/NONE warning, `grounded`, regenerate, thumbs; `feedback-and-uncertainty.test.ts`; browser-verified | 004, 005 | ✅ |
| 2.1 | Stored vs not stored, retention, PII, logging, audit | MUST | [AI-DATA.md](AI-DATA.md); `audit_log` (append-only), retention job, `DELETE /auth/me`, PII masking; `data-governance.test.ts` (log leak check mutation-verified) | 008 | 🟡 PII masking is pattern-based (stated) |
| 2.1 | Vector store + RAG | BONUS | pgvector HNSW, `rag/`, [ADR 1](adr/0001-pgvector-for-vector-search.md) | base | ✅ |
| 2.2 | Quality, regressions, wrong answers | MUST | [EVALUATION.md](EVALUATION.md), golden set, `npm run eval`, stored baselines; live 14/14 on a real model | 009 | 🟡 small set (stated) |
| 3.1 | Terraform, no plaintext secrets, config vs code | MUST | `infra/terraform` (`secrets.tf`, `iam.tf`), `infra/scripts/check-no-secrets.sh` in CI; `terraform validate` passes | 010 | 🟡 validated, never applied |
| 3.1 | Key location, rotation, bursty scaling | MUST | [DEPLOYMENT.md](DEPLOYMENT.md), `autoscaling.tf` | 010 | ✅ |
| 3.2 | Docker + ECS/EKS/serverless + AI scaling limits | MUST | Dockerfiles, `docker-compose.yml` (full stack verified), [DEPLOYMENT.md](DEPLOYMENT.md), [ADR 2](adr/0002-ecs-fargate.md) | 010 | ✅ |
| Bonus | Streaming responses | BONUS | `/chat/stream` (SSE), `chatStream.ts`, `streaming.test.ts`, graceful shutdown test | 004 | ✅ |
| Bonus | Background processing | BONUS | BullMQ worker, job status endpoint, [ADR 3](adr/0003-bullmq-for-background-work.md) | base | 🟡 no reconciliation sweep for lost jobs (stated) |
| Bonus | Cost estimation 1k/10k/100k | BONUS | [COSTS.md](COSTS.md) with stated assumptions | 013 | 🟡 estimate; AWS figures not checked against the calculator |
| Bonus | Multi-tenant isolation | BONUS | `user_id` scoping, composite FKs (migration 005), `tenant-isolation.test.ts` (mutation-checked) | 012 | ✅ |
| Bonus | Tool/function calling | OPTIONAL | `ai/tools/`, read-only `get_document_info`, off by default; unit and integration tests; [SECURITY.md](SECURITY.md) | 011 | 🟡 Anthropic tool path tested against faked HTTP only; OpenAI mapping untested |
| Deliverable | README: architecture, AI choices, trade-offs, run locally | MUST | [README.md](../README.md) | 013 | ✅ |
| Extra | Architecture diagram, ADRs, limitations, demo data | extra | [ARCHITECTURE.md](ARCHITECTURE.md), `docs/adr/` (5), `samples/`, `npm run seed:demo`, [api-examples.http](api-examples.http) | 013 | ✅ |

## Not verified

- **GitHub Actions has not run.** The workflow's steps were run locally one by one (typecheck, tests, integration against containers, build, Docker builds, `terraform fmt/validate`, the secrets check). The first push is its real test.
- **Terraform has not been applied** to an AWS account.
- **OpenAI** (chat, embeddings, tool calling) has not been exercised against the live API.
- **A real embedding model** was not used end to end in the browser (the zero-key demo uses mock embeddings, which are not semantic).

## Dropped on purpose
- bcrypt → argon2 migration: no security gain worth the churn for this scope.
- Next.js, GraphQL, EKS: the brief marks them optional; Vite + REST + ECS Fargate already meet the requirements.
- Full evaluation framework, OCR, multi-org: the brief says a short explanation is enough.

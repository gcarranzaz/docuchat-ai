# DocuChat: AI document Q&A, built for production questions

Upload documents, ask questions, get answers that cite the passages they come from, with a confidence level the interface does not hide. A second feature extracts structured data (invoices, resumes, contracts) as validated JSON.

**Stack:** TypeScript, Node 20, Express, PostgreSQL 16 with pgvector, Redis and BullMQ, React 18 with Vite and Tailwind, Docker, Terraform (AWS).

This README says what I chose, what I left out and what I would do next. Every claim here has a pointer to code, a test or a document; the table at the end maps the requirements to evidence, including the parts that are only partly done.

## Where this comes from (read this first)

The project **starts from an earlier personal prototype of mine**, [`fullstack-ai-rag-docuchat`](https://github.com/gcarranzaz/fullstack-ai-rag-docuchat). I used it as the base on purpose, so the time went into production concerns instead of scaffolding. What existed and what I added in this iteration:

| Already in the prototype | Added or fixed in this iteration |
|---|---|
| Upload (text, PDF), chunking, pgvector HNSW search, BullMQ embedding worker | Tests: unit, integration (real Postgres and Redis) and a CI pipeline. The prototype had none |
| JWT auth with refresh-token rotation and reuse detection | Verified by tests; a crash in reuse detection fixed |
| OpenAI and mock providers, prompt builder v1/v2, citation parser, confidence score | Anthropic provider, retry/backoff, fallback, streaming (SSE), prompt registry with immutable versions, schema-validated output with one repair, PII masking option |
| Extraction feature (invoice, resume, contract) | Prompt and output hardening shared with chat |
| React app: login, documents, chat, history | Streaming states, citations, uncertainty warnings, regenerate, thumbs up/down |
| Docker files and a Terraform draft | Terraform rewritten (no secret as an input), compose that actually runs the full stack, secrets check in CI |
| | Cost control (atomic per-user budget, Redis rate limits, answer cache), tenant isolation tests, audit log, retention, account erasure, evaluation set and regression check, optional read-only tool calling |

Things the prototype did not do that I found while testing it: it did not compile (TypeScript errors in backend and frontend), the backend Docker image could not be built (`.dockerignore` excluded the lockfile), one route let any user read another user's embedding-job status, async route errors left requests hanging, and `docker compose --profile full` never ran migrations. All are fixed and have tests or a verified run.

## Quick start (2 minutes, no API keys)

Prerequisites: Docker with Compose, and Node 20+ for the demo seed.

```bash
# 1. Start everything with the mock AI provider (no keys needed)
docker compose --profile full up -d --build
#    If port 5432 or 6379 is taken on your machine:
#    POSTGRES_PORT=55432 REDIS_HOST_PORT=56379 docker compose --profile full up -d --build

# 2. Create a demo user and upload three sample documents
cd backend && npm ci && npm run seed:demo

# 3. Open http://localhost:5173 and sign in with demo@example.com / DemoPassw0rd
```

Try: *"How many days of remote work are allowed?"*, *"What caused the checkout outage?"*, or ask about the `Poisoned Document` to watch it ignore the instructions hidden inside.

**About the mock provider.** It makes the stack run with no keys and no cost, and the tests and CI depend on it. It is **not an AI model**: embeddings are built from the words of the text, so retrieval finds the passages that share terms with the question, and answers quote the closest sentences from your documents, labelled "Demo mode". That is enough to see the whole flow (upload, retrieval, citations, streaming, confidence, feedback) and to judge the interface. It cannot paraphrase, summarize or match synonyms, so **to judge answer quality, use a real provider**.

### With a real provider

Create a `.env` next to `docker-compose.yml` (it is git-ignored):

```bash
AI_PROVIDER=anthropic            # or openai
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...               # needed for embeddings: Anthropic has no embeddings API
MIN_SIMILARITY_THRESHOLD=0.6     # the 0.0 default is only for mock embeddings
```

then `docker compose --profile full up -d`. Settings are documented in `backend/.env.example`. Other useful switches: `AI_FALLBACK_PROVIDER`, `REDACT_PII_BEFORE_LLM`, `TOOLS_ENABLED`.

### Local development without containers for the app

```bash
docker compose up -d postgres redis
cd backend && cp .env.example .env && npm ci && npm run migrate
npm run dev            # API on :3001
npm run dev:worker     # embeddings worker (second terminal)
cd ../frontend && npm ci && npm run dev    # :5173 (third terminal)
```

### Tests

```bash
cd backend && npm run typecheck && npm test            # unit tests, no services needed
docker compose -f docker-compose.test.yml up -d        # Postgres and Redis on ports 55432 and 56379
cd backend && npm run test:integration                 # real database and Redis, mock AI
npm run eval                                           # golden set (see docs/EVALUATION.md)
cd ../frontend && npm test && npm run build
```

API examples for the VS Code REST Client are in [docs/api-examples.http](docs/api-examples.http).

## What I built and what I simplified

**Use case:** questions over the user's own documents, with citations. It is concrete enough to have real failure modes (wrong answers, fabricated sources, injected instructions, cost) and small enough to do properly in the time.

**Simplified on purpose**
- A tenant is a user. No organizations, roles or sharing.
- Text and PDF only; no OCR, no scanned documents, no images.
- One region, one database instance, no CDN or WAF.
- bcrypt stays (no argon2 migration), Express stays, REST stays. Nothing in the requirements needed them changed.

## Architecture decisions

Diagrams and component responsibilities: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Decision records: [docs/adr/](docs/adr/).

```
React app ──REST/SSE──► API (Express) ──► PostgreSQL + pgvector   users, documents, chunks, vectors, usage, audit
                              │      └──► Redis                    rate limits, answer cache, job queue
                              └──► LLM providers (OpenAI, Anthropic, Mock)
Worker (BullMQ) ──► chunk, embed, store     │     retention job (daily)
```

| Decision | Why | Cost of the choice |
|---|---|---|
| pgvector inside PostgreSQL ([ADR 1](docs/adr/0001-pgvector-for-vector-search.md)) | One store to secure, back up and erase from; tenant filter in the same SQL | Search shares CPU with the database; revisit past low millions of chunks |
| Embeddings on a worker queue ([ADR 3](docs/adr/0003-bullmq-for-background-work.md)) | Uploads return fast; embedding scales separately | Redis durability is not SQS durability |
| ECS Fargate ([ADR 2](docs/adr/0002-ecs-fargate.md)) | Long-lived streams, steady worker, no cluster to run | Less portable than Kubernetes |
| One provider interface with decorators ([ADR 4](docs/adr/0004-provider-abstraction-and-decorators.md)) | Switching provider is configuration; retries, fallback and PII masking in one place each | A hand-written Anthropic client is code to maintain |
| JWT access token (15 min) and rotating refresh token | Stateless API for horizontal scaling; reuse of a refresh token revokes the family | The refresh token travels in the response body and lives in browser storage, which an XSS bug could read. Production should use httpOnly cookies |

## AI design choices

**Prompt, invocation and post-processing are separate** (requirement 1.2). Prompt construction (`ai/prompts/`) is a pure function over versioned, immutable templates. Invocation (`ai/providers/`) is behind one interface, with retry, fallback and PII masking as wrappers. Post-processing (`ai/postprocessing/`) is pure and schema-validated. `ai/pipeline/chatPipeline.ts` only wires them; the eval runner and the tests use it directly.

- **Switching providers:** `AI_PROVIDER` and `AI_FALLBACK_PROVIDER`. Completions fall back after retries on 429, 5xx and timeouts; embeddings never fall back (vectors from different models cannot share an index). After the first streamed token there is no retry or fallback.
- **Prompt versioning:** `PROMPT_VERSION_CHAT` and `PROMPT_VERSION_EXTRACT` pick a version from the registry; an unknown version fails at startup. Every stored answer records its `prompt_version` and `model`, so a bad answer can be traced. A released template is never edited, only superseded.
- **Structured output you can trust:** the model must return JSON; it is validated, repaired once if broken, and otherwise fails with a typed 502. Raw model text never reaches the user. Citations the model invents are dropped and counted ([ADR 5](docs/adr/0005-schema-validated-output-and-grounding.md)).
- **Retrieval:** 1,000-character chunks with 200 overlap, `text-embedding-3-small` (1536 dimensions), HNSW index with cosine distance, top 5 chunks above a similarity threshold. If nothing is relevant the model is not called at all (no cost, no invented answer).
- **Confidence and grounding:** a score combines retrieval similarity, the model's own claim and citation support, mapped to HIGH, MEDIUM, LOW, NONE. Whether an answer is `grounded` is decided by a rule over citations and level, not by the model. It is a heuristic, not a calibrated probability; the eval set tracks how well it separates right from wrong.
- **Streaming:** answers stream over Server-Sent Events. What streams is a draft; the final `result` event carries the validated answer and the UI replaces the draft. Closing the page aborts the provider call and charges an estimate for what was generated.
- **Tool calling (optional, off by default):** `TOOLS_ENABLED=true` lets the model call one **read-only** tool, `get_document_info`. The user id comes from the server and never from the model's arguments, arguments are validated, the loop is bounded to two rounds, every call is audited, and a foreign document is indistinguishable from a missing one. Tools with side effects are excluded on purpose: a steered model should only be able to write a wrong sentence, not take an action. It is not offered on the streaming endpoint. Details: [docs/SECURITY.md](docs/SECURITY.md).

## What the interface does about AI uncertainty (requirement 1.3)

Streaming shows the model's status (searching your documents, then writing the answer, with a Stop button) and marks the text as a draft. When the final answer arrives: citations open to show the source passage; a LOW or NONE confidence shows a warning; an answer without valid citations is flagged as not grounded; a stopped answer says it was not verified. **Regenerate** asks again, thumbs up and down are stored with the prompt version and model (down-votes go to a review queue that grows the golden set, a manual step), and conversation history is sent as context for follow-ups.

## Security and cost

- **Prompt injection** ([docs/SECURITY.md](docs/SECURITY.md)): untrusted text (question, documents, history, tool results) goes inside per-request random delimiters that the system prompt names as data; input is normalized and length-limited; a heuristic detector flags attempts for review without blocking. This is defense in depth, not a guarantee, and the document says what it does not stop.
- **Cost and rate limits**: Redis rate limits per user and IP; an atomic per-user daily token budget and monthly cost cap, reserved before each call and settled after; configurable prices (an unknown model is never free); an answer cache; bounded input and output. Estimate for 1k, 10k and 100k requests: [docs/COSTS.md](docs/COSTS.md).
- **Tenant isolation:** every query is scoped by `user_id`, composite foreign keys stop cross-tenant references, foreign resources return 404, and a test fails if a route is added without isolation coverage. Mutation-checked: removing the filter makes the tests fail.
- **Secrets:** none in the repository; in AWS they live in Secrets Manager ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Data and evaluation

- **What is stored, retention, PII, logging, audit:** [docs/AI-DATA.md](docs/AI-DATA.md). Logs carry sizes, ids and timings, never prompts, answers or documents (a test fails if content leaks). Append-only audit log. Retention job. `DELETE /auth/me` erases an account and its data. Optional masking of personal data before anything reaches a provider.
- **Quality, regressions, wrong answers in production:** [docs/EVALUATION.md](docs/EVALUATION.md). A golden set (answerable, unanswerable, near-miss, multi-chunk, injection) with a runner and a stored baseline; changing a prompt or model means running `npm run eval` and comparing. The CI run is structural (mock provider); the quality baseline was recorded on a live model.

## Infrastructure

Terraform for AWS (ECS Fargate, RDS with pgvector, ElastiCache, ALB, Secrets Manager, KMS, autoscaling, alarms) in [infra/terraform](infra/terraform). **Validated, not applied:** I did not deploy it to an account. How keys are stored and rotated, how it scales under bursty usage, why Fargate rather than EKS or Lambda, and the scaling limits specific to AI workloads: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Trade-offs and known limitations

- **The zero-key demo is not a language model.** Its retrieval is lexical (shared words, no synonyms) and its answers are extracted sentences, so it shows the plumbing and the interface, not answer quality.
- **The OpenAI path was not run against the live API.** The Anthropic path was (a smoke test and the evaluation set, both against a real model); its tool-calling path was tested only against a simulated HTTP layer.
- **Evaluation is small.** 14 cases catch gross regressions, not subtle ones, and the confidence score is not calibrated. A larger set built from real feedback is the next step.
- **Injection defense is layered but not complete.** A model can still follow a clever instruction and write a misleading, well-formed answer; confidence and citations are the mitigation.
- **PII masking is pattern-based**: it misses names and addresses.
- **The upload summary call is not counted against the per-user budget.** It is bounded by input truncation and the upload rate limit; routing it through the budget service is a known next step.
- **Streaming shows a draft before validation**, so a user can briefly see text that is later corrected or rejected.
- **Fixed-size chunking and vector-only retrieval.** No re-ranking, no hybrid keyword search, no semantic chunking.
- **CI has not run on GitHub** (the workflow was checked locally, piece by piece). **Terraform has not been applied.**
- Tokens live in browser storage; registration reveals whether an email exists (409). Both are documented trade-offs for a prototype.

**What I would do next:** a larger evaluation set from thumbs-down feedback with a CI gate on the live baseline; budget accounting for the summary call; httpOnly cookies; hybrid search and re-ranking; the first real `terraform plan` and a staging deploy; JWT rotation with key ids so rotating does not sign everyone out.

## How the work was organized

The work followed spec-driven development: [docs/constitution.md](docs/constitution.md) holds the principles, [specs/](specs/) holds one spec per concern (each cites the requirement it covers, the verified starting state, and checkable criteria) and [AGENTS.md](AGENTS.md) the rules for AI-assisted sessions. I used an AI coding assistant throughout, with the specs as the contract, and I list its limits where they matter. [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) is the live checklist.

## Requirements coverage

| Req | Where |
|---|---|
| 1.1 Submit content, chat with AI, structured output | Documents, chat and extractions routes; React app |
| 1.2 REST API, AI endpoint, PostgreSQL, JWT | `backend/src/routes`, `backend/migrations`, auth tests |
| 1.2 Prompt / invocation / post-processing separated | `ai/prompts`, `ai/providers`, `ai/postprocessing`, `ai/pipeline` |
| 1.2 Switch providers; prompt versioning | `AI_PROVIDER`, `ai/providers/*`, `ai/prompts/registry.ts` |
| 1.2 Prompt injection; cost and rate limits | [SECURITY.md](docs/SECURITY.md), [COSTS.md](docs/COSTS.md) |
| 1.3 Pages, loading/error/empty states, model status, re-ask, uncertainty | `frontend/src`, [spec 004](specs/004-streaming-and-ai-aware-ux.md), [005](specs/005-refine-feedback-uncertainty.md) |
| 2.1 Data stored, retention, PII, logging, audit | [AI-DATA.md](docs/AI-DATA.md) |
| 2.2 Quality, regressions, wrong answers | [EVALUATION.md](docs/EVALUATION.md) |
| 3.1 Terraform, secrets, config vs code, rotation, bursts | [infra/terraform](infra/terraform), [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| 3.2 Docker, ECS/EKS/serverless, AI scaling limits | Dockerfiles, `docker-compose.yml`, [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Extra: vector store and RAG | pgvector, `backend/src/rag` |
| Extra: streaming | `/chat/stream`, `frontend/src/api/chatStream.ts` |
| Extra: tool calling | `backend/src/ai/tools`, off by default |
| Extra: background processing | BullMQ worker, [ADR 3](docs/adr/0003-bullmq-for-background-work.md) |
| Extra: cost estimate 1k / 10k / 100k | [COSTS.md](docs/COSTS.md) |
| Extra: multi-tenant isolation | [spec 012](specs/012-tenant-isolation.md), `tests/integration/tenant-isolation.test.ts` |
| Documentation: README, decisions, trade-offs, run locally | this file |

## License

MIT

# 013 — README, architecture, costs, ADRs, demo

**Brief:** Deliverables "README covering architecture decisions, AI design choices, trade-offs and known limitations, clear instructions to run locally"; 1.1 "You are free to simplify scope, but explain your choices"; Bonus "Cost estimation for 1k / 10k / 100k requests".

## Scope
- **README (the main deliverable), in this order:**
  1. What it is and the use case chosen (Q&A over uploaded documents with structured outputs) and why; what was deliberately simplified.
  2. Honest provenance: the project starts from an earlier personal prototype (`fullstack-ai-rag-docuchat`); a table lists what existed and what was added for this assessment.
  3. Quick start: prerequisites, `cp .env.example .env`, `docker compose up`, demo user and sample documents, with `AI_PROVIDER=mock` (no keys) and how to switch to a real provider.
  4. Architecture decisions (diagram, link to `docs/ARCHITECTURE.md`).
  5. AI design choices: separation of prompt/invocation/post-processing, provider abstraction, prompt versioning, RAG settings, confidence and grounding, structured output.
  6. Security and cost (links to `SECURITY.md`, `COSTS.md`).
  7. Data and evaluation (links to `AI-DATA.md`, `EVALUATION.md`).
  8. Infrastructure (link to `DEPLOYMENT.md`).
  9. Trade-offs and known limitations; what I would do next.
  10. Brief-to-evidence table (from `docs/COMPLIANCE.md`).
- **`docs/ARCHITECTURE.md`:** Mermaid diagram of upload → async chunk/embed → retrieve → prompt → model → post-process → UI, plus component responsibilities.
- **`docs/COSTS.md`:** per-request token assumptions (question, retrieved context, answer, embeddings per document upload), price table from config, a table for 1k / 10k / 100k requests with low/typical/high scenarios, infra cost notes, and the levers that reduce spend (cache, smaller model for extraction, top-k, truncation). Assumptions are stated; no invented precision.
- **`docs/adr/`:** 3–5 short decision records (pgvector vs a separate vector store; ECS Fargate vs EKS; BullMQ vs SQS; keeping Express; provider abstraction).
- **Demo:** seed script creating a demo user and two sample documents; `.http` file with curl examples.
- Update `docs/COMPLIANCE.md` with real evidence and statuses.

## Result

- `README.md` rewritten in the order above. It leads with provenance (what the earlier prototype already had, what was added, and the defects found in it), then the quick start, decisions, AI choices, uncertainty handling, security and cost, data and evaluation, infrastructure, an explicit limitations section and next steps, and a brief-to-evidence table.
- `docs/ARCHITECTURE.md` (Mermaid flows for ingestion and for a streamed answer), `docs/COSTS.md` (tokens per request, three model tiers, 1k/10k/100k, infrastructure, levers, what is left out), `docs/adr/0001..0005`.
- Demo: `samples/` (handbook, incident postmortem, a document with a deliberate injection), `npm run seed:demo` (idempotent, through the public API), `docs/api-examples.http`.
- Making the quick start true required fixing the full-stack compose, which had never worked: no migration step (new one-off `migrate` service the API and worker wait for), worker rejected by config validation (missing JWT settings), API using TLS to a Postgres that has none (`DB_SSL=disable` locally), frontend container crashing as non-root (nginx pid file) and failing its own health check (IPv6 `localhost`), nginx buffering streamed answers and limiting uploads to 1 MB, worker marked unhealthy by the API's health probe, and host port conflicts (now `POSTGRES_PORT` and `REDIS_HOST_PORT`). Verified: all services healthy, seed completes, a streamed answer arrives through the nginx proxy.
- `docs/COMPLIANCE.md` rewritten with real evidence, per-row limits and a "not verified" list.

**Honest limits.** The AWS figures in `COSTS.md` are order-of-magnitude, from memory, and not checked against the AWS calculator; model prices in the tables are illustrative inputs. Reading time of the README was not measured; the quick-start steps were executed as written.

## Acceptance criteria
- [x] A new reader can run the app and complete the upload, ask, citations flow following only the README (steps executed: compose up, seed, sign in, ask).
- [x] Every bullet of the brief's Deliverables section is answered in the README or a linked document.
- [x] `docs/COSTS.md` shows 1k/10k/100k with stated assumptions.
- [x] Statements in the README were checked against the code while writing (limits and unverified parts are listed rather than implied).
- [x] The earlier prototype is credited in the provenance table.

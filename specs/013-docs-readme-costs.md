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

## Acceptance criteria
- [ ] A new reader can run the app and complete the upload → ask → see citations flow in under 5 minutes following only the README.
- [ ] Every bullet of the brief's Deliverables section is answered in the README or linked doc.
- [ ] `docs/COSTS.md` shows 1k/10k/100k with stated assumptions.
- [ ] No statement in the README is untrue about the current code (checked against `COMPLIANCE.md`).
- [ ] The earlier prototype is credited in the provenance table.

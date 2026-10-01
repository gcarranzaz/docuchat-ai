# 012 — Multi-tenant data isolation

**Brief:** Bonus "Multi-tenant prompt or data isolation".

## Current state (verified)
- Repositories take `userId` (for example `documentRepo.exists(id, userId)`, `chatRepo.findSessionById(id, userId)`).
- An isolation bug was found and fixed in spec 001: `GET /api/jobs/documents/:id` did not check ownership. This shows isolation needs tests, not just convention.
- To verify: vector search in `rag/retriever.ts` and `chunk.repository.ts` filters by `user_id`, including when `documentIds` is supplied by the client.

## Scope
- Audit every route and repository function that reads or writes user data; list them in a table in this spec with the ownership check used.
- Vector search always filters by `user_id` in SQL; `documentIds` from the client are intersected with the user's documents, never trusted.
- Prompt isolation: the context for a request contains only the caller's chunks; the cache key (spec 006) and chat history are scoped per user.
- Defence in depth: Postgres row-level security on user-owned tables with `app.current_user_id` set per request, documented as an option; implement it if time allows, otherwise explain the trade-off (complexity vs guarantee) in the README.
- A cross-user test suite.

## Acceptance criteria
- [ ] Integration tests with two users: B cannot read, list, delete, chat over, extract from, rate, or fetch job status for A's documents/sessions/messages (each returns 404).
- [ ] Test: B passes A's `documentIds` to chat → no chunks from A are retrieved.
- [ ] Test: identical questions by A and B never share a cached answer.
- [ ] The audit table of routes is complete and matches the code.

## Out of scope
Organisation-level tenancy with shared documents and roles.

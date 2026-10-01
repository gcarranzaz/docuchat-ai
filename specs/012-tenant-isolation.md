# 012 — Multi-tenant data isolation

**Brief:** Bonus "Multi-tenant prompt or data isolation".

## Threat
One user reading, changing or deleting another user's documents, conversations, extractions or feedback; or the AI being shown one user's text while answering another (prompt isolation). The usual causes are a missing `WHERE user_id = ...`, an identifier taken from the request instead of the token, or a shared cache.

## Layers (each one tested)
1. **Identity comes from the verified token.** `req.userId` is set by the auth middleware; no route reads a user id from the body or URL.
2. **Every query is scoped in SQL.** Each repository function takes the caller's id and puts it in the `WHERE` (audit below). A resource that exists but belongs to someone else is indistinguishable from one that does not exist: **404 for both**, so ids cannot be probed.
3. **Vector search is scoped inside the query**, not filtered after it: `WHERE user_id = $1` precedes the similarity ordering, and a client-supplied `documentIds` list is *intersected* with the caller's data, never trusted.
4. **Prompt isolation.** The model only ever receives chunks the caller owns; conversation history is loaded per owned session; the answer cache key includes the user id; a document id belonging to someone else yields "no evidence", without calling the model.
5. **The database refuses cross-owner references** (migration `005_tenant_integrity.sql`): a child row references its parent by `(id, user_id)`, so a chunk, message, extraction or vote cannot be owned by one user while pointing at another user's document, session or message. This catches the one bug the other layers would not: a code path that supplies the wrong owner on insert.

## Audit: route inventory
`tenant-isolation.test.ts` lists every route the app exposes and fails if one is added without being listed, so "who can call this, on whose data?" is always answered deliberately. A second test calls every non-public route without credentials and expects 401.

| Route | Scope |
|---|---|
| `GET /health`, `GET /health/ready`, `POST /auth/register|login|refresh|logout` | public by design |
| `GET /auth/me` | own profile |
| `DELETE /auth/me` | the caller's own account, password required; cascades to their data only |
| `GET /documents`, `GET|DELETE /documents/:id`, `POST /documents`, `POST /documents/upload` | own documents (`id` and `user_id`); chunks and extractions cascade on delete |
| `POST /chat`, `POST /chat/stream` | retrieval filters on the caller; a session id must belong to the caller |
| `GET /chat/sessions`, `GET|PATCH|DELETE /chat/sessions/:id` | own sessions (`id` and `user_id`) |
| `DELETE /chat/sessions` | all of the caller's sessions, nobody else's |
| `PUT|DELETE /chat/messages/:id/feedback` | own assistant messages |
| `POST /extractions` | own document; extraction stored under the caller |
| `GET /extractions`, `GET /extractions/:id`, `GET /extractions/document/:documentId`, `DELETE /extractions/:id` | own extractions |
| `DELETE /extractions` | all of the caller's extractions, nobody else's |
| `GET /extractions/schemas` | static list, no user data |
| `GET /jobs/documents/:documentId` | own document's job status |

## Defects found
- `GET /jobs/documents/:id` had no ownership check at all (any signed-in user could read any document's job status) and then, once fixed, crashed on a different bug; both are covered by tests (specs 001 and 007).
- Duplicate `DELETE /extractions` handler (a copy-paste); removed.

## Acceptance criteria
- [x] Two-user tests: B cannot read, list, delete, chat over, extract from, rate, or fetch job status for A's documents, sessions, messages or extractions; each returns 404 and A's data is verified unchanged afterwards.
- [x] B passes A's `documentIds` to chat: no chunks are retrieved, no text of A's reaches B, the model is not called.
- [x] Identical questions by A and B never share a cached answer.
- [x] Vector search returns none of A's chunks to B for an identical embedding, with or without A's document id; with several users each sees only their own.
- [x] The database rejects cross-owner chunk, message, extraction and feedback rows, and still accepts the normal case.
- [x] The route table is complete and matches the code (inventory test).

## How the tests were checked
A mutation check: with the owner filter removed from the vector search the suite fails (4 tests, at both API and SQL level), and passes again when restored. A green isolation suite that cannot fail would prove nothing.

## Decision: no Postgres row-level security (yet)
RLS would add a database-enforced filter on every query. It was not adopted here: with a connection pool it needs the request's user id set on the connection inside a transaction for every request (`SET LOCAL`), the application must connect as a non-owner role, and a mistake silently returns zero rows instead of failing. Given application-level scoping on every query, composite foreign keys, and the tests above, the extra layer was judged not worth the operational complexity for this scope. It is the natural next step for a larger tenant model; the composite keys already added are compatible with it.

## Known limits
- Isolation is per user. Organisations with shared documents, roles or sharing links are not modelled.
- The object store/filesystem is not used (documents are stored as text in Postgres), so there is no per-tenant storage prefix to protect.
- `usage_logs` and `audit_log` (spec 008) are written for every user but there is no user-facing endpoint reading them.

## Out of scope
Organisation-level tenancy with shared documents and roles.

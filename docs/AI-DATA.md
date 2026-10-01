# Data handling: what is stored, for how long, and how personal data is treated

This covers requirement 2.1: what data is stored versus not, how long AI inputs and outputs are retained, and how PII, logging and auditability are handled. Every statement below is backed by code and, where marked, by a test.

## 1. What is stored, and what is not

| Data | Stored? | Where | Kept | Who can read it | How it is removed |
|---|---|---|---|---|---|
| Account: email, password | email yes; password as a **bcrypt hash only** | `users` | until the user deletes the account | the user (own profile) | `DELETE /auth/me` |
| Documents (full text) | yes, as uploaded text. PDFs are converted to text; **the original file is not kept** | `documents` | until the user deletes it | owner only | `DELETE /documents/:id`, cascades to chunks and extractions |
| Chunks and embeddings | yes (the vectors are derived from the text) | `doc_chunks` (pgvector) | with the document | owner only (SQL-scoped search) | with the document |
| Questions and answers | yes: text, citations, confidence, model, prompt version, token counts | `chat_messages` | until the user deletes the conversation (optional expiry `RETENTION_CONVERSATION_DAYS`) | owner only | `DELETE /chat/sessions/:id` or `DELETE /chat/sessions` |
| Structured extractions | yes | `extractions` | with the document | owner only | `DELETE /extractions/:id` or with the document |
| Thumbs up/down and reason | yes | `message_feedback` | with the message | owner (and the operator review queue) | with the message or the account |
| Per-call usage: tokens, estimated cost, model | yes, **no text** | `usage_logs` | 90 days | operators | retention job |
| Daily/monthly budget counters | yes | `user_budgets` | 400 days | operators | retention job |
| Audit trail | yes, **facts only, no text** (see 5) | `audit_log` | 365 days | operators | retention job only |
| Refresh tokens | **SHA-256 hash only**, never the token | `refresh_tokens` | until expiry + 1 day | nobody (hash) | retention job, logout, reuse detection |
| Answer cache | yes: the answer for one user and question | Redis | 5 minutes (`AI_CACHE_TTL_SECONDS`) | owner only (key contains the user id) | expires on its own |
| Provider API keys, JWT secrets | **not in the database, the repo or the image**; environment / AWS Secrets Manager (`docs/DEPLOYMENT.md`) | secret store | n/a | the running task | rotation |
| Prompt text and model replies in **logs** | **never** (see 4) | n/a | n/a | n/a | n/a |

Not stored at all: the original uploaded PDF, raw model replies when they fail validation, request bodies, IP addresses in the audit trail, and any plaintext credential.

## 2. How long AI inputs and outputs are retained

- **By us:** a question and its answer live as long as the conversation, which the user controls. They can delete one conversation, all conversations, one document, or the whole account at any time, and the deletion is real (a `DELETE` with `ON DELETE CASCADE`, covered by tests; there is no soft delete). An operator can additionally expire idle conversations with `RETENTION_CONVERSATION_DAYS`.
- **Operational records** (usage, budgets, audit) follow the table above and are removed by a daily job (`retention.service.ts`, scheduled in the worker at 03:00 UTC). The audit log is append-only; the job is the only code allowed to delete from it, and only by opting in for one transaction.
- **By the AI provider:** out of our control and depends on the account agreement. Providers commonly keep API inputs for a limited abuse-monitoring period unless a zero-data-retention agreement is in place. For production this must be settled contractually; the application can reduce what is exposed with PII masking (section 3) but cannot recall what was sent.

## 3. Personal data (PII)

What exists: users' emails; anything personal inside the documents and questions they submit (names, phone numbers, ids, account numbers).

What the application does:

1. **Minimise what is stored.** Passwords and refresh tokens are only hashed. The audit trail records an opaque user id, never an email or a name. Failed logins record a short hash of the address (`emailRef`), enough to see repeated attempts against one account without storing the address.
2. **Keep it out of logs and the audit trail** (sections 4 and 5), with a test that checks the real log output.
3. **Optional masking before a third party sees it** (`REDACT_PII_BEFORE_LLM=true`). Every call to an AI provider (chat, extraction, summaries, and the embeddings of documents and questions) passes through a decorator that masks emails, phone numbers, card numbers (Luhn-validated), national ids (US SSN, Argentine CUIT and keyword-anchored DNI), IBANs (mod-97 validated) and IP addresses. Stored text, citations and answers shown to the user keep the original: the user's own data is theirs.
   - Limits, stated plainly: pattern matching does **not** find names, addresses or personal facts in prose; the model cannot reason about a masked value ("what is the customer's email?" returns the placeholder); and it is off by default because it costs answer quality. For stronger guarantees use a provider under a zero-retention agreement, an in-region endpoint, or a self-hosted model.
   - Precision is tested as much as recall: ordinary numbers, dates, amounts and versions are left alone (`pii.test.ts`).
4. **Isolation.** One user's data is never shown to another (`docs`, spec 012), including in prompts, retrieval and the cache.
5. **Erasure.** `DELETE /auth/me` (password required) removes the account and everything it owns. Only the audit record that the deletion happened remains, with no personal data.
6. **Encryption.** In transit: TLS at the load balancer and to RDS. At rest: RDS storage encryption with KMS (`infra/terraform`, spec 010). Application-level field encryption is not implemented (see limits).

## 4. Logging

Policy: **log identifiers, sizes, timings, token counts, model and prompt version. Never content.**

- Questions, answers, document text, titles, summaries and retrieved passages are not logged at any level. What is logged instead: lengths (`questionLength`), ids (`chunkIds`), counts. (Earlier code logged a 100-character question preview, chunk previews, the raw model reply on a parse failure and document titles; all removed.)
- A test runs a real request containing an email, a phone number, a question and document text with debug logging on, reads the log file the application wrote, and asserts none of it appears (and that the log is not simply empty). It was checked by re-introducing the leak: the test fails.
- Every log line of a request carries its `requestId` (taken from `x-request-id` or generated, returned in the response header, propagated with `AsyncLocalStorage`). The same id is stored on the audit rows, so one id joins the access log, application logs and audit trail.
- Credentials are redacted by the logger configuration (`authorization`, `cookie`, `password`, tokens, `apiKey`).
- Production logs go to stdout as JSON for CloudWatch (30-day retention, `docs/DEPLOYMENT.md`).

## 5. Auditability

`audit_log` answers: who did what, to which resource, when, with what outcome, and with which model.

- **Events:** register, login, failed login, token refresh, detected token theft, logout, account deletion; document create and delete; each chat answer (model, prompt version, token counts, cached, grounded, injection signals) and each refused one (budget); feedback set and cleared; session deletions; extraction create and delete.
- **No content, enforced twice:** callers pass facts only, and the service redacts personal data in every string and truncates long ones before storing (`sanitizeMetadata`, tested).
- **Append-only, enforced by the database:** a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` (error `42501`), verified by test. The retention job opts in for its own transaction. In production the application role should hold `INSERT`/`SELECT` only on this table and retention should run under a separate maintenance role.
- **Outlives the account:** `actor_user_id` has no foreign key, so erasing a user does not erase the record that the account existed and was deleted.
- **Failure policy:** best effort. If the insert fails, the failure is logged loudly (`AUDIT WRITE FAILED`) and the user's request continues. A regulated deployment might choose to fail closed; that is a one-line change and a product decision.
- **Next step for production:** ship rows to immutable storage (S3 Object Lock) so that even a database administrator cannot rewrite history.

## 6. Retrieval and vector store (extra)

Documents are chunked (1,000 characters, 20 % overlap), embedded, and stored in Postgres with pgvector (HNSW index, cosine distance). Search is scoped to the caller inside the SQL; the top-k chunks, bounded by `MAX_CHUNKS_PER_QUERY`, are the only document text the model sees. Choosing pgvector over a separate vector store keeps documents, embeddings, ownership and deletion in one transactional system, which is what makes the erasure guarantee above simple and testable.

## 7. Known limits

- No field-level encryption of documents or messages in the database, and no customer-managed keys per tenant.
- No data export endpoint (portability); erasure is implemented, export is not.
- PII masking is pattern-based (see 3). Names and free-text personal facts are not detected.
- The audit trail and usage log have no user-facing endpoint; operators query them in SQL.
- Backups: RDS automated backups keep deleted data until they expire (`backup_retention_period`, `docs/DEPLOYMENT.md`); an erasure is complete in the live system immediately and in backups after that period.

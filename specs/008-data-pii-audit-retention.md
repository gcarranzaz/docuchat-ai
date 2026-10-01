# 008 — Data handling: what we store, retention, PII, logging, audit

**Brief:** 2.1 "What data you store vs what you don't", "How long AI inputs/outputs are retained", "How you would handle PII, Logging, Auditability". Bonus: vector store and RAG.

## Current state before this spec (verified)
- Stored: users, documents (full text), chunks with embeddings (pgvector), conversations with citations and confidence, extractions, usage records.
- Logging: the code logged a 100-character preview of every question, previews of retrieved passages, the raw model reply when parsing failed, document titles and summaries, and the query text in the retriever. All of that is user content.
- No retention, no audit trail, no PII handling, no way for a user to delete their account (so "right to erasure" was not possible), and no request id on application log lines.

## Result (explanation in `docs/AI-DATA.md`)
- **Logs carry ids, sizes and timings, never content.** All content-bearing log statements removed. Every line of a request carries its `requestId` (`AsyncLocalStorage`), echoed in the `x-request-id` header and stored on audit rows.
- **PII masking before a third party sees it** (`REDACT_PII_BEFORE_LLM`, off by default): a decorator on the provider boundary masks emails, phones, Luhn-valid card numbers, US SSN, Argentine CUIT and keyword-anchored DNI, mod-97-valid IBANs and IPs in every prompt and every embedded text, covering chat, extraction, summaries and embeddings at once. Stored text, citations and answers keep the original. Tested for precision too (ordinary numbers, dates, amounts and versions untouched), and prompt delimiters are protected so a random code that looks like a card number cannot break them.
- **Audit trail** (`audit_log`, migration 006): register, login and failed login (pseudonymous reference, never the address), refresh, token theft, logout, account deletion, document create/delete, every chat answer (model, prompt version, tokens, cached, grounded, injection signals) and every refused one, feedback, session and extraction deletions. Facts only: strings are redacted and truncated before storage. **Append-only enforced by the database** (trigger refuses UPDATE, DELETE, TRUNCATE; only the retention job may delete, by opting in for one transaction). No foreign key to users, so the record survives the account.
- **Right to erasure:** new `DELETE /auth/me` (password required) removes the account and everything it owns through cascades; only the audit record that it happened remains. Document deletion removes chunks, embeddings and extractions.
- **Retention** (`retention.service.ts`, daily at 03:00 UTC in the worker via a BullMQ scheduler): usage 90 days, audit 365, budgets 400, expired refresh tokens after one day, optional idle-conversation expiry. Documents and conversations stay until the user deletes them.

## Defects found on the way
- The code had no way to delete an account at all, which made the erasure story impossible; added.
- Content leaks in logs listed above; each is removed and the removal is guarded by a test that reads the real log output.
- The route table gained `DELETE /auth/me`, which the route-audit test (spec 012) forced to be declared.

## Acceptance criteria
- [x] Unit tests for the redactor: each pattern, checksum validation, 12 kinds of ordinary text that must not match, delimiter protection (`pii.test.ts`, 29 tests) and the provider decorator (`redactingProvider.test.ts`, 8).
- [x] A real request containing an email, a phone number, a question and document text produces a log with none of them, and the log is not empty; **checked by re-introducing the leak: the test fails** (`data-governance.test.ts`).
- [x] Each audited action writes exactly one row, attributed to the right user, with the request id of the response header; chat rows hold model and prompt version and no text.
- [x] The database refuses UPDATE, DELETE and TRUNCATE on `audit_log` and still accepts INSERT; the retention job deletes old rows and the door closes again.
- [x] Deleting a document and deleting an account remove chunks, embeddings, messages, extractions, feedback, budgets and tokens; the erased user cannot sign in; a wrong password or a stolen token alone cannot erase an account; only the requester's data is touched.
- [x] Retention deletes what is past its window and keeps the rest, honours 0 as "off", and the schedule is registered once.
- [x] `docs/AI-DATA.md` answers every bullet of 2.1.

## Known limits
- Masking is pattern-based: names, addresses and personal facts in prose are not detected, and the model cannot reason about a masked value.
- No field-level or per-tenant encryption of content, no data export endpoint (portability), no user-facing audit view.
- Audit writes are best effort (logged loudly on failure); a regulated deployment may prefer to fail closed. Immutable off-database storage for the trail (S3 Object Lock) is the production next step.
- Backups keep deleted data until they expire; an erasure is complete in the live system immediately and in backups after the backup retention period.
- The provider's own retention of API inputs is outside the application; it needs a contractual answer.

## Out of scope
Legal compliance claims (GDPR/HIPAA certification), data residency beyond documenting it.

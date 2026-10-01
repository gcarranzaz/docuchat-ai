# 008 — Data handling: what we store, retention, PII, logging, audit

**Brief:** 2.1 "What data you store vs what you don't", "How long AI inputs/outputs are retained", "How you would handle PII, Logging, Auditability". Bonus: vector store and RAG (already present).

## Current state (verified)
- Stored: users, documents (full text), chunks with embeddings (pgvector), chat sessions/messages with citations and confidence, extractions, usage records.
- Logging: Pino. `chat.service.ts` logs the first 100 characters of the user's question and retrieved chunk previews at debug level, which can leak personal data into logs.
- No retention policy, no audit trail, no PII handling.

## Scope
- **`docs/AI-DATA.md`** (the required explanation), with a table: data item → stored? → where → retention → who can read → deletion path. Explicitly lists what is *not* stored: provider API keys, raw system prompts in logs, full prompts/completions in application logs, plaintext refresh tokens.
- **Retention (configurable):** messages and documents kept until the user deletes them or the account is removed; `usage` records 90 days; application logs 30 days; audit log 1 year. A scheduled cleanup job (BullMQ repeatable job) enforces the usage and session TTLs.
- **Right to delete:** deleting a document removes its chunks and embeddings; deleting an account cascades everything (tested).
- **PII:** detector/redactor (email, phone, card-like numbers, national-ID-like patterns) applied to anything written to logs and audit metadata. Optional `REDACT_PII_BEFORE_LLM` masks values before sending to the provider; the trade-off (answer quality vs privacy) and the production alternative (provider with zero-retention agreement, in-region endpoint) are documented.
- **Logging policy:** log IDs, sizes, durations, token counts, model and prompt version; never content at info level. Request ID on every log line.
- **Audit:** append-only `audit_log` (actor, action, resource, request id, model, prompt version, tokens, timestamp) written for auth events, document upload/delete, chat calls, feedback, quota blocks. No UPDATE/DELETE path from the app; documented how it would move to immutable storage in production.
- Remove content-bearing debug logs in `chat.service.ts`.

## Acceptance criteria
- [ ] Unit tests for the redactor (cases per pattern, no false redaction of ordinary numbers in a sample).
- [ ] Test: log output for a chat request containing an email/phone contains neither.
- [ ] Test: each audited action writes one `audit_log` row; the app role cannot update or delete it.
- [ ] Test: deleting a document and an account removes chunks/messages/embeddings.
- [ ] `docs/AI-DATA.md` answers every bullet of brief 2.1.

## Out of scope
Legal compliance claims (GDPR/HIPAA certification), data residency beyond documenting it.

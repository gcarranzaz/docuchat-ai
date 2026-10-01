# 004 — Streaming responses and AI-aware UX

**Brief:** 1.3 "At least 2 pages", "A form to submit data", "Display AI responses in a user-friendly way", "Loading, error, and empty states", "Show model status (thinking, partial results, errors)"; Bonus "Streaming AI responses (token-by-token UX)".

## Current state (verified)
- Pages exist: Login, Chat, History (sessions and extractions). `useChat.ts` does one request and waits for the full answer.
- No streaming endpoint (`text/event-stream` not found in the code).
- Not yet audited: empty and error states on every page.

## Scope
- `POST /api/chat/stream` (authenticated) returns Server-Sent Events with a provider-independent format:
  - `status` events: `retrieving` → `generating` → `done`.
  - `token` events with text deltas.
  - one final `result` event with the same structured payload as the non-streaming endpoint (answer, citations, confidence, grounded, metadata).
  - `error` event with a typed code; the stream always ends.
- `LlmProvider.stream()` is added on the interface; the mock and the real providers implement it. A provider that cannot stream falls back to one chunk.
- Streaming respects spec 006 (quota and rate limit checked before the stream opens) and aborts the upstream call if the client disconnects.
- Frontend: `useChat` consumes the stream and shows the model status ("Searching your documents…", "Writing the answer…"), partial text, then citations and the confidence badge when `result` arrives. A stop button cancels the request.
- Empty, loading and error states are audited and fixed on Login, Chat and History (no documents yet, no sessions yet, network error with retry).
- The non-streaming endpoint stays, for tests and clients without SSE.

## Acceptance criteria
- [ ] Integration test: the SSE stream emits statuses, tokens and exactly one `result`, in order, using the mock provider.
- [ ] Integration test: an error mid-stream produces an `error` event and closes the connection.
- [ ] Client disconnect cancels the provider call (unit test with an abort signal).
- [ ] Manual check in the browser: tokens appear progressively; stop works; each page shows loading, empty and error states.
- [ ] Reverse proxy and ALB settings needed for SSE (buffering off, idle timeout) are documented in spec 010.

## Out of scope
WebSockets, resumable streams.

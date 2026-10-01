# 004 — Streaming responses and AI-aware UX

**Requirement:** 1.3 "At least 2 pages", "A form to submit data", "Display AI responses in a user-friendly way", "Loading, error, and empty states", "Show model status (thinking, partial results, errors)"; Extra "Streaming AI responses (token-by-token UX)".

## Current state before this spec (verified)
- Pages: Login, Chat, History. `ChatPage` duplicated all the logic of `useChat.ts`, which nothing used. One blocking request; no status, no partial output.
- The page read `confidenceScore`/`confidenceLevel` at the top of the response, but the backend sends `confidence: { score, level }`: the confidence badge never rendered.
- The API client's token refresh stored the whole response body as the token pair, so after the first expired access token the app saved the string `"undefined"` and every later request failed.
- Renaming a conversation used `PUT`; the route is `PATCH`, so it answered 404 (and CORS did not allow `PATCH`).

## Result

### Backend
- `POST /chat/stream` (SSE). Events: `status` → `token`* → `result` (or `error`). Anything that can be refused (bad input, unknown session, rate limit, budget) is decided **before** the stream opens, so it is an ordinary HTTP 400/404/429 rather than an error hidden inside a 200 stream. `result` carries the same body as `POST /chat` and is the source of truth.
- `LlmProvider.stream()` on every provider (mock, OpenAI, Anthropic) and on the retry/fallback wrapper. Policy: before the first token the usual retry and fallback apply; after the first token a failure is final, because a retry would stack a second answer on the first.
- The model replies with JSON, so what streams is a **draft**: `AnswerStreamExtractor` pulls only the text of the `answer` field out of the JSON as it arrives (handles escapes and surrogate pairs split across chunks). Full validation still runs at the end; if it fails, one repair attempt (not streamed) replaces the draft, and if that fails the client discards the draft.
- Client disconnect aborts the provider call. The budget is not refunded for what was already generated: an estimate is charged, so "start a stream and close the tab" is not free.
- 15 s heartbeat comment lines keep an idle-timeout proxy (ALB) from cutting a slow answer; `X-Accel-Buffering: no`.

### Frontend (`useChatStream`, `ChatPage`, `MessageBubble`, `api/chatStream.ts`)
- Model status line: "Searching your documents…" → "Thinking…" → "Writing the answer…", with a Stop button.
- The draft is shown as a draft (caret, "sources and confidence appear when the answer is complete"); the final result replaces it. A failed answer is removed, never left looking like a result. A stopped answer keeps its partial text, labelled unverified, without sources.
- Errors have wording and a way forward: rate limit (with the wait time), spending limit (with the reset time, no pointless retry), dropped connection, unusable model output; "Try again" re-asks without duplicating the question.
- Empty states: no documents (upload prompt), no conversation yet (what to expect), failed document load (retry). Loading state while documents load.
- Fixed the defects listed above (confidence fields, token refresh, `PATCH`); `useChat.ts` is now the single owner of the conversation logic.

## Verification
- Backend: 17 unit tests (SSE parsing of the real Anthropic event format at every chunk boundary, retry rules, abort) and 9 integration tests against Postgres/Redis: event order and headers, draft equals final answer, conversation saved, cached and no-evidence answers without tokens, real 400/404/401/429 before the stream, mid-stream failure becomes an `error` event and is still charged, **client disconnect stops the provider and charges only an estimate**.
- Live: `npm run smoke:anthropic` against the real API (`claude-sonnet-5-5`) streams text, reports usage, streams the answer draft equal to the validated answer, and aborts a live stream.
- Frontend: 51 component/hook/page tests (draft → result, stop, failure and retry, regenerate, feedback with revert, uncertainty notice, every state above).
- Browser: the real app (backend, worker, Postgres, Redis, Vite) driven with Playwright, screenshots reviewed: status while generating, draft, sources, rating saved on the server, regenerate, edit-and-re-ask, stop, and the no-evidence warning. The run script lives outside the repo.

## Known limits
- Under the mock provider the answers often show the low-confidence warning: its embeddings are hashes, so retrieval relevance is meaningless (about 19 %). A real embedding provider gives real scores.
- Heartbeats (15 s) are implemented but not covered by an automated test (too slow for the suite).
- OpenAI streaming is implemented against the SDK but was not exercised live (no OpenAI key was available).
- The History page still shows stored conversations with the older layout.

## Out of scope
WebSockets, resumable streams.

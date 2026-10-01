# 002 — Switchable LLM providers (OpenAI, Anthropic, Mock)

**Brief:** 1.2 "Ability to switch LLM providers (mocked or abstracted is fine)".

## Current state (verified)
- `LlmProvider` interface, `providerFactory.ts`, `OpenAIProvider` and `MockProvider` exist.
- `AI_PROVIDER=anthropic` logs "not yet implemented" and silently falls back to the mock.
- The factory falls back to the mock whenever a real provider has no key, which can hide a misconfiguration in production.
- The default Anthropic model in `config/index.ts` is an old one.

## Scope
- Implement `AnthropicProvider` against the same `LlmProvider` interface (`complete`; `embed`/`embedBatch` throw a typed "unsupported" error, since embeddings stay on OpenAI or the mock).
- Separate the chat provider from the embedding provider in config (`AI_PROVIDER` for completions, `EMBEDDING_PROVIDER` for embeddings) so Anthropic completions can be combined with OpenAI embeddings.
- Retry with exponential backoff and jitter on 429/5xx/timeouts; never retry 4xx auth errors.
- Fallback: optional `AI_FALLBACK_PROVIDER`, used only on retryable failures after retries are exhausted.
- In production a missing key for the requested provider fails at startup (`validateAiConfig`) instead of silently using the mock.
- Model IDs and prices come from config/env, not constants buried in code.

## Acceptance criteria
- [x] `AI_PROVIDER=anthropic` returns a real `AnthropicProvider` instance (`providerFactory.test.ts`).
- [x] Unit tests with a fake HTTP layer: success path, 429 then success, 401 not retried, retries exhausted → fallback used, no fallback → typed error (`anthropicProvider`, `retry`, `resilientProvider` tests).
- [x] `AI_PROVIDER=mock` still runs the whole app with no keys (defaults; factory test).
- [x] Production start with `AI_PROVIDER=openai` and no key exits with a clear message. Checked by running the server: `OPENAI_API_KEY is required when AI_PROVIDER=openai`, exit code 1, before any database or Redis connection.
- [x] Token usage and model name are returned by every provider in the same shape (`CompletionResult`).

## Implementation notes
- `ai/providers/errors.ts`: `LlmProviderError` (`status`, `retryable`, `retryAfterMs`); OpenAI and Anthropic errors are normalised to it.
- `ai/providers/retry.ts`: `withRetry` (exponential backoff, jitter, cap, honours `Retry-After`).
- `ai/providers/resilient.provider.ts`: retries, plus fallback for completions only when the primary fails with a retryable error. Embeddings never fall back (vectors from different models are not comparable).
- `ai/providers/anthropic.provider.ts`: Messages API over `fetch`, no new dependency.
- Factory builds a chat provider and an embedding provider; `initProviders()` runs at API and worker startup.
- `AI_FALLBACK_PROVIDER=mock` is rejected: a mock fallback would return fake answers as real ones.
- The OpenAI SDK's own retries are turned off (`maxRetries: 0`) so there is a single retry policy.
- Backend `.env.example`, root `.env.example` and `docker-compose.yml` document the new variables; API keys in `.env.example` are now empty (a non-empty placeholder would count as "configured").

## Live verification (2026-10-01)
`npm run smoke:anthropic` against the real API with `claude-sonnet-5-5`: all 11 checks passed (auth, token usage, model name, JSON contract, citations, an unanswerable question, an injected document). It found a defect the faked HTTP tests could not: the API rejects the `temperature` parameter for this model with a 400 (`temperature is deprecated for this model`). The provider now omits it by default; `ANTHROPIC_TEMPERATURE` sets it explicitly for models that still accept it. Two unit tests cover both behaviours.

## Known limits
- Only `claude-sonnet-5-5` was exercised live. Other models may differ in accepted parameters.
- `MODEL_PRICING` has no entry for the new default Anthropic model, so its cost is recorded as 0 until spec 006 moves pricing to config and warns on unknown models.

## Out of scope
Provider-specific features (tool use, vision). Streaming is added in spec 004 on the same interface.

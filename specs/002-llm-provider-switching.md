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
- [ ] `AI_PROVIDER=anthropic` returns a real `AnthropicProvider` instance.
- [ ] Unit tests with a fake HTTP layer: success path, 429 then success, 401 not retried, retries exhausted → fallback used, no fallback → typed error.
- [ ] `AI_PROVIDER=mock` still runs the whole app with no keys.
- [ ] Production start with `AI_PROVIDER=openai` and no key exits with a clear message.
- [ ] Token usage and model name are returned by every provider in the same shape (`CompletionResult`).

## Out of scope
Provider-specific features (tool use, vision). Streaming is added in spec 004 on the same interface.

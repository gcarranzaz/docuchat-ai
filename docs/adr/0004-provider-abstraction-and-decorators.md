# ADR 0004: One provider interface; resilience and privacy as decorators

**Status:** accepted

## Context
The requirements ask that the model provider can be changed. Providers differ in request format, streaming format, error shape and what they support (Anthropic has no embeddings API). We also need retries, a fallback, and optional PII masking, without scattering those across call sites.

## Decision
- A small `LlmProvider` interface: `embed`, `embedBatch`, `complete`, `stream`, `isConfigured`.
- Implementations: OpenAI, Anthropic (plain `fetch`, no SDK), and a deterministic Mock used for local runs and tests.
- Cross-cutting behaviour wraps the interface instead of living in it: `ResilientProvider` (retry with backoff and `Retry-After`, fallback for completions) and `RedactingProvider` (masks PII before anything leaves the process).
- Embeddings are configured separately from chat (`EMBEDDING_PROVIDER`): changing the embedding model changes vector dimensions and requires re-embedding, so it must not follow the chat provider silently.

## Consequences
- Switching provider is configuration (`AI_PROVIDER`, `AI_FALLBACK_PROVIDER`); the pipeline, prompts and post-processing do not change.
- The Mock makes the whole stack, the integration tests and the CI eval run with no keys and no cost. It is not a model: its embeddings are hashed bags of words (retrieval by shared terms, no synonyms) and its answers are extracted sentences marked "Demo mode". That is enough to exercise retrieval, citations, streaming and the interface, and it proves plumbing, not quality.
- Only completions fall back. Embeddings do not, for the dimension reason above. After the first streamed token there is no retry or fallback, because the user has already seen output.
- Writing the Anthropic client by hand costs maintenance (streaming parser) but keeps the dependency list short and the behaviour visible; it was verified against the live API (`npm run smoke:anthropic`). The OpenAI path was not exercised live for this exercise.

## Alternatives considered
LangChain or the Vercel AI SDK would give many providers quickly, but hide retry, streaming and error behaviour that this project is explicitly about, and add a large dependency surface.

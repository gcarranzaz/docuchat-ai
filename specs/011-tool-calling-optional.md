# 011 — Tool/function calling (OPTIONAL bonus, do last)

**Brief:** Bonus "Tool/function calling with the LLM" (optional, pick any). Start only after every MUST spec is done. If time runs out, record the decision in the README instead.

## Scope (minimal)
- One read-only tool exposed to the model through `LlmProvider`: `get_document_info({ documentId })` → title, size, chunk count, created date, summary. No writes, no network, no access to other users.
- The tool executor receives the authenticated `userId` from the server, never from the model's arguments; arguments validated with zod; unknown tool or invalid arguments return a structured error to the model.
- Bounded loop: at most 2 tool rounds per answer; tool calls and results recorded in the audit log.
- Mock provider can emit a deterministic tool call so the path is testable without keys.

## Result

Implemented, **off by default** (`TOOLS_ENABLED=false`).

- `LlmProvider.completeWithTools?` (optional) with a provider-neutral transcript (`ToolTurn`); implemented for Anthropic (`tools`, `tool_use`/`tool_result`, `tool_choice`), OpenAI (`tools`, `tool_calls`, `tool` messages) and the Mock (deterministic: it asks for the tool when the question names a lookup or asks about the document itself, then answers from the result). `ResilientProvider` retries and falls back per step; `RedactingProvider` masks tool results.
- `ai/tools/registry.ts` (the single read-only tool `get_document_info`, zod-validated, user id from the server) and `ai/tools/toolLoop.ts` (bounded loop, usage summed, results in nonce delimiters).
- `chat.service` offers tools only on the non-streamed path, reserves budget for `1 + rounds` calls, and audits each call (`tool.call`).
- The context shows `document: <id>` only when tools are enabled, because the model needs an id to call the tool.
- Details and limits: `docs/SECURITY.md` (Tool calling).

Verified: unit tests for the loop (executes and feeds results back, stops after the maximum rounds, zero rounds, more than three calls in a round, audit hook, unsupported provider), for validation (unknown tool, five kinds of invalid arguments), and for the Anthropic request/response mapping; integration tests (a model asking for another user's document gets "not found", identical to a missing id, and the owner's data never appears; the call is audited as denied; disabled by default; absent on `/chat/stream`).

**Honest limits.** The OpenAI mapping has no automated test (the SDK is not faked) and, like the rest of the OpenAI path, was not run against the live API. The Anthropic tool path was tested only against a faked HTTP layer, not live. A mutation check of the user filter in the tool was not run (the denied lookup rests on `documentRepo.findById`, which is user-scoped in SQL and was mutation-tested in spec 012). With the mock provider the demo behaviour is scripted, not model reasoning.

## Acceptance criteria
- [x] Test: the model asks for another user's document → denied (same as not found).
- [x] Test: invalid arguments → error result, no crash.
- [x] Test: loop stops after the maximum rounds.
- [x] README states what is exposed and why side-effecting tools are excluded (constitution #2).

## Out of scope
Write tools, external APIs, agent-style multi-step planning.

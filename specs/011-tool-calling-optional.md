# 011 — Tool/function calling (OPTIONAL bonus, do last)

**Brief:** Bonus "Tool/function calling with the LLM" (optional, pick any). Start only after every MUST spec is done. If time runs out, record the decision in the README instead.

## Scope (minimal)
- One read-only tool exposed to the model through `LlmProvider`: `get_document_info({ documentId })` → title, size, chunk count, created date, summary. No writes, no network, no access to other users.
- The tool executor receives the authenticated `userId` from the server, never from the model's arguments; arguments validated with zod; unknown tool or invalid arguments return a structured error to the model.
- Bounded loop: at most 2 tool rounds per answer; tool calls and results recorded in the audit log.
- Mock provider can emit a deterministic tool call so the path is testable without keys.

## Acceptance criteria
- [ ] Test: the model asks for another user's document → denied (same as not found).
- [ ] Test: invalid arguments → error result, no crash.
- [ ] Test: loop stops after the maximum rounds.
- [ ] README states what is exposed and why side-effecting tools are excluded (constitution #2).

## Out of scope
Write tools, external APIs, agent-style multi-step planning.

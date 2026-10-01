# Constitution

Non-negotiable principles for this codebase. Every spec in `specs/` must respect them.

1. **Untrusted by default.** User input, document content and model output are all untrusted. They are delimited, validated (zod) and never executed.
2. **The LLM has no side effects.** Tools exposed to the model are read-only and scoped to the calling user.
3. **Tenant isolation is enforced in the data layer.** Every query that touches user data filters by `user_id`, including vector search. Tests prove it.
4. **No secrets in the repo or the image.** Config comes from the environment; production fails fast if a secret is missing or is a dev default.
5. **Provider-agnostic.** Business logic depends on `LlmProvider`, never on a vendor SDK.
6. **Every AI answer is traceable.** We persist model, prompt version and token usage per message.
7. **Prompt/model changes are gated by evals.** No change to a prompt or default model merges without `npm run eval` passing.
8. **Fail loudly, degrade gracefully.** Errors are typed. If the model is unavailable or unsure, the user sees an honest message, not an invented answer.
9. **Spec first, tests first.** One spec at a time, failing test, then implementation, then the whole suite.

## Working agreement (SDD)
- One spec per gap (`specs/NNN-*.md`) with verifiable acceptance criteria.
- Conventional commits, one commit (or small group) per spec.
- `docs/COMPLIANCE.md` maps every line of the assessment brief to its evidence.

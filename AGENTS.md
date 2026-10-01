# Working agreement for AI-assisted sessions

Read `docs/constitution.md` and the active spec in `specs/` before changing code.

1. One spec at a time. Don't start the next until the current one meets its acceptance criteria.
2. Tests first: write a failing test, then the implementation, then run the whole suite (`cd backend && npm run typecheck && npm test`, `cd frontend && npm run build`).
3. No secrets in the repo. Only `.env.example` with placeholders. Never read or copy `.env` files.
4. The LLM never gets tools with side effects, and every query on user data filters by `user_id`.
5. Prompt or default-model changes need `npm run eval` to pass (once spec 009 lands).
6. Update `docs/COMPLIANCE.md` when a spec changes the status of a brief item.
7. Git: commit as `gcarranzaz <carranzaz.gonzalo@gmail.com>` (set `git config --local` first). Don't add AI co-author trailers. Don't commit unless the maintainer asks.

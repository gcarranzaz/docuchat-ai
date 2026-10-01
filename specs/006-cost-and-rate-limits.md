# 006 — Cost control and rate limits

**Brief:** 1.2 "Explain: how you'd control costs and rate limits in production".

## Current state (verified)
- `express-rate-limit` is configured per route (`RATE_LIMIT_*`), in memory per process.
- `usage.repository.ts` records tokens and cost per operation; `MODEL_PRICING` is a hard-coded table dated 2024.
- Limits do not cap spend per user or per month, and in-memory counters do not work across several ECS tasks.

## Scope
- Use Redis (already in the stack) as the store for `express-rate-limit` so limits hold across tasks.
- Per-user budgets: daily token budget and monthly cost cap, enforced **before** calling the model. The check and the debit use one atomic SQL statement (`UPDATE … SET used = used + $1 WHERE used + $1 <= cap RETURNING …`), so concurrent requests cannot overspend.
- Hard bounds per request: max input characters, max chunks, `maxTokens` on output.
- Optional response cache for identical question + same document set, keyed by hash and `user_id`, short TTL (never shared across users).
- Pricing table moves to config (`MODEL_PRICING_JSON` or a versioned file) and is used by the cost estimate; unknown models log a warning instead of costing zero.
- Quota exceeded → HTTP 429 with a clear message and reset time; in the UI a friendly state, not a generic error.
- `docs/SECURITY.md` (cost section) explains what runs in the app vs. what belongs in AWS (Budgets and alarms, per-key limits at the provider).

## Acceptance criteria
- [ ] Integration test: N concurrent requests against a budget of M never exceed M (atomic debit).
- [ ] Test: request over the per-request bounds is rejected with 400/413 before any model call.
- [ ] Test: rate limit returns 429 with `Retry-After`, and the counter is shared through Redis.
- [ ] Test: cache hit does not call the provider and is not served to another user.
- [ ] Cost shown in usage records matches the configured price table.

## Out of scope
Billing/invoicing, per-organisation plans.

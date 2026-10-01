# 006 — Cost control and rate limits

**Requirement:** 1.2 "Explain: how you'd control costs and rate limits in production".

## Current state before this spec (verified)
- Limiters used `express-rate-limit` with in-memory counters, per process, and were skipped when `NODE_ENV=test`, so they were never exercised.
- They keyed on `req.user?.id`, which nothing sets: every limit was per IP, never per user (fixed in spec 007's harness work).
- The auth limiter was 100/min while its message and the README said 5 per 15 minutes.
- `usage.repository.ts` logged tokens and cost, but nothing capped spend per user or per month. Pricing was a hard-coded 2024 table, and an unknown model cost zero.

## Scope and result
- **Rate limits in Redis**, shared by all API tasks (`middleware/redisRateLimitStore.ts`, `ratelimit.middleware.ts`). Per user on chat/extract/upload/general, per IP on login. Configurable (`RATE_LIMIT_*`, `RATE_LIMIT_ENABLED`, `TRUST_PROXY`). 429 with `Retry-After` and the standard error shape.
- **Per-user budget, reserved atomically before the model call** (`services/budget.service.ts`, migration `003_user_budgets.sql`): daily token budget and monthly cost cap, reserve → settle → release, wired into chat and extraction. A refused request is not charged and never reaches the model.
- **Hard per-request bounds** before any model call (question length after normalisation, chunk count, max output tokens).
- **Answer cache** in Redis (`ai/responseCache.ts`): keyed by user, question, retrieved chunk ids, prompt version and model; first turn only; short TTL; Redis failure means a miss.
- **Pricing as configuration** (`ai/pricing.ts`, `MODEL_PRICING_JSON`); an unknown model uses a conservative fallback and warns once, never zero.
- `docs/SECURITY.md` covers the requirements (layers, how the budget works, what belongs in AWS).

## Defects found on the way
1. **Every error path of the chat and extraction routes hung.** Those handlers are `async` and `throw`, Express 4 does not forward the rejection, and no wrapper existed, so a 400, 404, 429 or 502 never reached the client (the request waited until the client gave up, and the error was logged as an unhandled rejection). This would have made every limit in this spec invisible to the user. Fixed with `express-async-errors`; `errors.test.ts` covers the paths.
2. **`rate-limit-redis` breaks permanently if Redis is down when it loads** (it caches a rejected startup promise), and its latest major needs a newer `express-rate-limit`. Replaced by a ~40-line store with no startup state.
3. **The shared Redis client waits forever when Redis is down** (`maxRetriesPerRequest: null`, required by BullMQ). Request-path calls now race a 500 ms timeout, so the limiter fails open and the cache misses instead of hanging.
4. A test helper leaked environment overrides between tests (an earlier test's tiny budget made a later one fail); fixed. Worth recording because it is the kind of bug that makes limit tests pass or fail for the wrong reason.

## Acceptance criteria
- [x] N concurrent requests against a budget of M never exceed M: 10 parallel reservations, room for 3, exactly 3 succeed (`budget.test.ts`).
- [x] A request over the per-request bounds is rejected with 400 before any model call (`errors.test.ts`, the model spy is never called).
- [x] Rate limit returns 429 with `Retry-After`, per user, and the counter is shared through Redis between two app instances (`ratelimit.test.ts`).
- [x] A cache hit does not call the provider, costs nothing against the budget, and is never served to another user (`cost-control.test.ts`).
- [x] Pricing comes from configuration; unknown models are never free (`pricing.test.ts`).
- [x] Limiter fails open and answers when Redis is unreachable (`ratelimit.test.ts`, cache variant in `cost-control.test.ts`).

## Known limits
- Reservation uses an estimate (about 4 characters per token); settlement uses the provider's numbers. A repair attempt can overshoot the reservation by one call.
- `claude-sonnet-5-5` has no built-in price: it triggers the fallback warning until `MODEL_PRICING_JSON` is set with the real price from the provider's price page. No price was invented here.
- Budgets are per user, one tier. Organisation budgets and paid plans are not built.
- The frontend does not yet show a friendly state for 429 responses (spec 004).

## Out of scope
Billing/invoicing, per-organisation plans.

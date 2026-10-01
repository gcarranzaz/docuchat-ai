-- Migration: per-user AI budgets
-- Purpose: cap spend per user (daily tokens, monthly cost) with an atomic reserve/settle.
--
-- One row per user and period. The period key is in UTC:
--   'd:YYYY-MM-DD'  daily usage (tokens are what is capped)
--   'm:YYYY-MM'     monthly usage (cost in USD is what is capped)
-- Reservations and settlements are single UPDATE/INSERT statements, so concurrent
-- requests cannot overspend (see src/services/budget.service.ts).

CREATE TABLE IF NOT EXISTS user_budgets (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period VARCHAR(16) NOT NULL,
    tokens BIGINT NOT NULL DEFAULT 0 CHECK (tokens >= 0),
    cost_usd NUMERIC(14, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, period)
);

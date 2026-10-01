/**
 * Per-user AI budget
 * ==================
 * Caps what one user can spend, enforced BEFORE the model is called.
 *
 * Reserve / settle:
 *  1. reserve(): worst-case estimate (input estimate + max output) is added to the
 *     user's daily and monthly counters in single statements that only succeed if
 *     the result stays within the caps. Two concurrent requests cannot both pass
 *     when only one fits: the row lock serialises them.
 *  2. settle(): after the call, the counters are corrected to the real usage.
 *  3. release(): if the call fails, the reservation is given back.
 *
 * Limits: a daily TOKEN budget and a monthly COST cap, both per user, 0 = off.
 * Known approximation: a repair attempt (spec 003) can make the real usage exceed
 * the reservation; settle() records it, so the next request sees it. Overshoot is
 * bounded by one extra model call.
 */

import type { PoolClient } from 'pg';
import { query, withTransaction } from '../config/database.js';
import { AppError } from '../middleware/error.middleware.js';

export interface BudgetLimits {
  /** Max tokens per user per UTC day; 0 disables */
  dailyTokens: number;
  /** Max estimated cost per user per UTC month, in USD; 0 disables */
  monthlyCostUsd: number;
}

export interface Estimate {
  tokens: number;
  costUsd: number;
}

export interface Reservation {
  userId: string;
  day: string;
  month: string;
  reserved: Estimate;
}

export class BudgetExceededError extends AppError {
  constructor(
    readonly kind: 'daily_tokens' | 'monthly_cost',
    readonly resetsAt: Date
  ) {
    super(
      kind === 'daily_tokens'
        ? `Daily AI usage limit reached. It resets at ${resetsAt.toISOString()}.`
        : `Monthly AI spending cap reached. It resets at ${resetsAt.toISOString()}.`,
      429,
      kind === 'daily_tokens' ? 'DAILY_TOKEN_BUDGET_EXCEEDED' : 'MONTHLY_COST_CAP_EXCEEDED'
    );
  }
}

// "Off" caps. NUMERIC(14,6) and BIGINT leave plenty of room.
const NO_TOKEN_CAP = Number.MAX_SAFE_INTEGER;
const NO_COST_CAP = 1e9;

export function periodKeys(now: Date): { day: string; month: string } {
  const iso = now.toISOString();
  return { day: `d:${iso.slice(0, 10)}`, month: `m:${iso.slice(0, 7)}` };
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Add `tokens`/`cost` to one period only if the new total stays within the caps.
 * One statement: the INSERT branch checks the caps through its WHERE clause, the
 * UPDATE branch through DO UPDATE ... WHERE. No row returned means "does not fit".
 */
async function addIfWithinCaps(
  client: PoolClient,
  userId: string,
  period: string,
  tokens: number,
  costUsd: number,
  capTokens: number,
  capCostUsd: number
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO user_budgets (user_id, period, tokens, cost_usd)
     SELECT $1::uuid, $2::varchar, $3::bigint, $4::numeric
     WHERE $3::bigint <= $5::bigint AND $4::numeric <= $6::numeric
     ON CONFLICT (user_id, period) DO UPDATE
       SET tokens = user_budgets.tokens + EXCLUDED.tokens,
           cost_usd = user_budgets.cost_usd + EXCLUDED.cost_usd,
           updated_at = NOW()
       WHERE user_budgets.tokens + EXCLUDED.tokens <= $5::bigint
         AND user_budgets.cost_usd + EXCLUDED.cost_usd <= $6::numeric
     RETURNING tokens`,
    [userId, period, Math.ceil(tokens), costUsd, capTokens, capCostUsd]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function reserve(
  userId: string,
  estimate: Estimate,
  limits: BudgetLimits,
  now: Date = new Date()
): Promise<Reservation> {
  const { day, month } = periodKeys(now);
  const dayCap = limits.dailyTokens > 0 ? limits.dailyTokens : NO_TOKEN_CAP;
  const monthCap = limits.monthlyCostUsd > 0 ? limits.monthlyCostUsd : NO_COST_CAP;

  // Both counters in one transaction: if either does not fit, neither is charged
  return withTransaction(async (client) => {
    const dayOk = await addIfWithinCaps(client, userId, day, estimate.tokens, estimate.costUsd, dayCap, NO_COST_CAP);
    if (!dayOk) throw new BudgetExceededError('daily_tokens', nextUtcMidnight(now));

    const monthOk = await addIfWithinCaps(client, userId, month, estimate.tokens, estimate.costUsd, NO_TOKEN_CAP, monthCap);
    if (!monthOk) throw new BudgetExceededError('monthly_cost', nextUtcMonth(now));

    return { userId, day, month, reserved: estimate };
  });
}

/** Correct the counters from the reserved estimate to the real usage (may go up or down) */
export async function settle(reservation: Reservation, actual: Estimate): Promise<void> {
  const deltaTokens = Math.ceil(actual.tokens) - Math.ceil(reservation.reserved.tokens);
  const deltaCost = actual.costUsd - reservation.reserved.costUsd;
  await adjust(reservation, deltaTokens, deltaCost);
}

/** Give the whole reservation back (the model call failed) */
export async function release(reservation: Reservation): Promise<void> {
  await adjust(reservation, -Math.ceil(reservation.reserved.tokens), -reservation.reserved.costUsd);
}

async function adjust(reservation: Reservation, deltaTokens: number, deltaCost: number): Promise<void> {
  await query(
    `UPDATE user_budgets
     SET tokens = GREATEST(0, tokens + $3::bigint),
         cost_usd = GREATEST(0, cost_usd + $4::numeric),
         updated_at = NOW()
     WHERE user_id = $1 AND period = ANY($2::varchar[])`,
    [reservation.userId, [reservation.day, reservation.month], deltaTokens, deltaCost]
  );
}

export interface BudgetUsage {
  dayTokens: number;
  monthTokens: number;
  monthCostUsd: number;
}

export async function getUsage(userId: string, now: Date = new Date()): Promise<BudgetUsage> {
  const { day, month } = periodKeys(now);
  const result = await query<{ period: string; tokens: string; cost_usd: string }>(
    'SELECT period, tokens, cost_usd FROM user_budgets WHERE user_id = $1 AND period = ANY($2::varchar[])',
    [userId, [day, month]]
  );
  const byPeriod = new Map(result.rows.map((r) => [r.period, r]));
  return {
    dayTokens: Number(byPeriod.get(day)?.tokens ?? 0),
    monthTokens: Number(byPeriod.get(month)?.tokens ?? 0),
    monthCostUsd: Number(byPeriod.get(month)?.cost_usd ?? 0),
  };
}

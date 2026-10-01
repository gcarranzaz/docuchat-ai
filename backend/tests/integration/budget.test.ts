import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetData, closeConnections } from './helpers.js';
import { getPool } from '../../src/config/database.js';
import * as userRepo from '../../src/repositories/user.repository.js';
import * as budget from '../../src/services/budget.service.js';
import { BudgetExceededError } from '../../src/services/budget.service.js';

beforeEach(resetData);
afterAll(closeConnections);

const NO_LIMITS = { dailyTokens: 0, monthlyCostUsd: 0 };
const NOON = new Date('2026-10-15T12:00:00Z');

async function newUser(email = `u${Math.random().toString(36).slice(2)}@example.com`) {
  return userRepo.create(email, 'not-a-real-hash');
}

describe('budget reserve / settle / release', () => {
  it('counts a reservation against the daily and monthly totals', async () => {
    const user = await newUser();
    await budget.reserve(user.id, { tokens: 500, costUsd: 0.02 }, { dailyTokens: 1000, monthlyCostUsd: 1 }, NOON);

    const usage = await budget.getUsage(user.id, NOON);
    expect(usage).toEqual({ dayTokens: 500, monthTokens: 500, monthCostUsd: 0.02 });
  });

  it('rejects a reservation that would exceed the daily token budget, with a reset time', async () => {
    const user = await newUser();
    const limits = { dailyTokens: 1000, monthlyCostUsd: 0 };
    await budget.reserve(user.id, { tokens: 700, costUsd: 0 }, limits, NOON);

    const err = await budget.reserve(user.id, { tokens: 400, costUsd: 0 }, limits, NOON).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('DAILY_TOKEN_BUDGET_EXCEEDED');
    expect(err.resetsAt.toISOString()).toBe('2026-10-16T00:00:00.000Z');
  });

  it('rejects a reservation that would exceed the monthly cost cap', async () => {
    const user = await newUser();
    const limits = { dailyTokens: 0, monthlyCostUsd: 0.01 };
    await budget.reserve(user.id, { tokens: 10, costUsd: 0.006 }, limits, NOON);

    const err = await budget.reserve(user.id, { tokens: 10, costUsd: 0.006 }, limits, NOON).catch((e) => e);
    expect(err.code).toBe('MONTHLY_COST_CAP_EXCEEDED');
    expect(err.resetsAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('charges neither counter when one of them rejects (all or nothing)', async () => {
    const user = await newUser();
    const limits = { dailyTokens: 10_000, monthlyCostUsd: 0.01 };
    await budget.reserve(user.id, { tokens: 100, costUsd: 0.006 }, limits, NOON);
    await budget.reserve(user.id, { tokens: 100, costUsd: 0.006 }, limits, NOON).catch(() => undefined);

    const usage = await budget.getUsage(user.id, NOON);
    expect(usage.dayTokens).toBe(100); // the rejected request left no trace
    expect(usage.monthCostUsd).toBeCloseTo(0.006, 6);
  });

  it('never lets concurrent requests overspend: 10 parallel reservations, room for 3', async () => {
    const user = await newUser();
    const limits = { dailyTokens: 1000, monthlyCostUsd: 0 };

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => budget.reserve(user.id, { tokens: 300, costUsd: 0 }, limits, NOON))
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(7);
    expect((await budget.getUsage(user.id, NOON)).dayTokens).toBe(900);
  });

  it('settle corrects the reservation to the real usage (down and up)', async () => {
    const user = await newUser();
    const reservation = await budget.reserve(user.id, { tokens: 5000, costUsd: 0.1 }, NO_LIMITS, NOON);

    await budget.settle(reservation, { tokens: 800, costUsd: 0.016 });
    expect(await budget.getUsage(user.id, NOON)).toMatchObject({ dayTokens: 800, monthCostUsd: 0.016 });

    const second = await budget.reserve(user.id, { tokens: 100, costUsd: 0.001 }, NO_LIMITS, NOON);
    await budget.settle(second, { tokens: 300, costUsd: 0.005 }); // a repair attempt used more than reserved
    expect(await budget.getUsage(user.id, NOON)).toMatchObject({ dayTokens: 1100 });
  });

  it('release gives the whole reservation back when the call fails', async () => {
    const user = await newUser();
    const reservation = await budget.reserve(user.id, { tokens: 4000, costUsd: 0.08 }, NO_LIMITS, NOON);
    await budget.release(reservation);
    expect(await budget.getUsage(user.id, NOON)).toEqual({ dayTokens: 0, monthTokens: 0, monthCostUsd: 0 });
  });

  it('a released reservation frees room for the next request', async () => {
    const user = await newUser();
    const limits = { dailyTokens: 1000, monthlyCostUsd: 0 };
    const first = await budget.reserve(user.id, { tokens: 900, costUsd: 0 }, limits, NOON);
    await expect(budget.reserve(user.id, { tokens: 900, costUsd: 0 }, limits, NOON)).rejects.toBeInstanceOf(BudgetExceededError);
    await budget.release(first);
    await expect(budget.reserve(user.id, { tokens: 900, costUsd: 0 }, limits, NOON)).resolves.toBeTruthy();
  });

  it('a limit of 0 means unlimited', async () => {
    const user = await newUser();
    await expect(budget.reserve(user.id, { tokens: 50_000_000, costUsd: 5000 }, NO_LIMITS, NOON)).resolves.toBeTruthy();
  });

  it('keeps users independent', async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const limits = { dailyTokens: 1000, monthlyCostUsd: 0 };
    await budget.reserve(a.id, { tokens: 900, costUsd: 0 }, limits, NOON);
    await expect(budget.reserve(b.id, { tokens: 900, costUsd: 0 }, limits, NOON)).resolves.toBeTruthy();
  });

  it('starts a fresh daily budget the next UTC day, but the month keeps accumulating', async () => {
    const user = await newUser();
    const limits = { dailyTokens: 1000, monthlyCostUsd: 0 };
    await budget.reserve(user.id, { tokens: 900, costUsd: 0.5 }, limits, NOON);

    const tomorrow = new Date('2026-10-16T00:00:01Z');
    await budget.reserve(user.id, { tokens: 900, costUsd: 0.5 }, limits, tomorrow);

    expect(await budget.getUsage(user.id, tomorrow)).toEqual({ dayTokens: 900, monthTokens: 1800, monthCostUsd: 1 });
  });

  it('deleting a user removes their budget rows', async () => {
    const user = await newUser();
    await budget.reserve(user.id, { tokens: 10, costUsd: 0 }, NO_LIMITS, NOON);

    await getPool().query('DELETE FROM users WHERE id = $1', [user.id]);

    const { rows } = await getPool().query('SELECT 1 FROM user_budgets WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(0);
  });
});

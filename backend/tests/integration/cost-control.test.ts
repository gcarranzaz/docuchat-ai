import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  api,
  bearer,
  registerUser,
  resetData,
  flushRedis,
  closeConnections,
  seedDocument,
  loadFreshApp,
  type FreshApp,
  type TestUser,
} from './helpers.js';
import { getPool } from '../../src/config/database.js';
import { MockProvider } from '../../src/ai/providers/mock.provider.js';
import * as budget from '../../src/services/budget.service.js';

const TIMEOUT = { response: 8000, deadline: 12000 };
const REPORT = 'Q3 revenue grew 20 percent compared with Q2, driven by enterprise contracts. Headcount stayed flat.';
const apps: FreshApp[] = [];

beforeEach(async () => {
  await resetData();
  await flushRedis('aicache:');
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const instance of apps) await instance.close();
  await closeConnections();
});

async function fresh(env: Record<string, string>): Promise<FreshApp> {
  const instance = await loadFreshApp(env);
  apps.push(instance);
  return instance;
}

const ask = (user: TestUser, question: string, extra: Record<string, unknown> = {}) =>
  api().post('/chat').set(bearer(user)).send({ question, ...extra }).timeout(TIMEOUT);

async function chatUsageRows(userId: string) {
  const { rows } = await getPool().query(
    "SELECT input_tokens, output_tokens, metadata FROM usage_logs WHERE user_id = $1 AND operation = 'chat' ORDER BY created_at",
    [userId]
  );
  return rows as Array<{ input_tokens: number; output_tokens: number; metadata: { cached?: boolean } }>;
}

describe('answer cache', () => {
  it('serves a repeated question without calling the model again', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    const first = await ask(user, 'How did revenue change?');
    const second = await ask(user, 'How did revenue change?'); // a brand new conversation

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.body.answer).toBe(first.body.answer);
    expect(second.body.citations).toEqual(first.body.citations);
  });

  it('records the cache hit in the usage log with zero model tokens', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    await ask(user, 'How did revenue change?');
    await ask(user, 'How did revenue change?');

    const rows = await chatUsageRows(user.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.metadata.cached).toBe(false);
    expect(rows[1]!.metadata.cached).toBe(true);
    expect(rows[1]!.output_tokens).toBe(0);
  });

  it('treats a different question as a miss', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    await ask(user, 'How did revenue change?');
    await ask(user, 'What happened to headcount?');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('never serves one user an answer cached for another, even for the same question and text', async () => {
    const [a, b] = [await registerUser(), await registerUser()];
    await seedDocument(a.id, 'Report A', REPORT);
    await seedDocument(b.id, 'Report B', REPORT);
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    await ask(a, 'How did revenue change?');
    const forB = await ask(b, 'How did revenue change?');

    expect(forB.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not cache follow-up questions: earlier turns change the answer', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    const first = await ask(user, 'How did revenue change?');
    await ask(user, 'How did revenue change?', { sessionId: first.body.sessionId });
    await ask(user, 'How did revenue change?', { sessionId: first.body.sessionId });

    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('is only a miss when Redis is down: the answer still arrives', async () => {
    const instance = await fresh({ REDIS_PORT: '1', RATE_LIMIT_ENABLED: 'false' });
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);

    const res = await instance.http().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);
    expect(res.status).toBe(200);
    expect(instance.modelCalls).toHaveBeenCalledTimes(1);
  });
});

describe('per-user budget through the API', () => {
  it('settles the budget to the real usage, not the worst-case reservation', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    await ask(user, 'How did revenue change?');

    const usage = await budget.getUsage(user.id);
    expect(usage.dayTokens).toBeGreaterThan(0);
    expect(usage.dayTokens).toBeLessThan(2000); // reserved ~4900 (800 prompt + 4096 output), real use is a few hundred
  });

  it('a cache hit costs nothing against the budget', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    await ask(user, 'How did revenue change?');
    const afterFirst = (await budget.getUsage(user.id)).dayTokens;

    await ask(user, 'How did revenue change?');
    expect((await budget.getUsage(user.id)).dayTokens).toBe(afterFirst);
  });

  it('refuses with 429 before calling the model when the daily token budget is exhausted', async () => {
    const instance = await fresh({ USER_DAILY_TOKEN_BUDGET: '3000', RATE_LIMIT_ENABLED: 'false' }); // less than one call's worst case
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);

    const res = await instance.http().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('DAILY_TOKEN_BUDGET_EXCEEDED');
    expect(res.body.error.message).toMatch(/resets at/i);
    expect(instance.modelCalls).not.toHaveBeenCalled();
    expect((await budget.getUsage(user.id)).dayTokens).toBe(0); // a refused request is not charged
  });

  it('refuses with 429 when the monthly cost cap would be exceeded', async () => {
    const instance = await fresh({
      USER_MONTHLY_COST_CAP_USD: '1',
      MODEL_PRICING_JSON: '{"mock":{"input":1000,"output":1000}}', // $1000 per 1M tokens: one worst-case call costs ~ $5
      RATE_LIMIT_ENABLED: 'false',
    });
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);

    const res = await instance.http().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('MONTHLY_COST_CAP_EXCEEDED');
    expect(instance.modelCalls).not.toHaveBeenCalled();
  });

  it('refuses extraction too when the budget is gone', async () => {
    const instance = await fresh({ USER_DAILY_TOKEN_BUDGET: '3000', RATE_LIMIT_ENABLED: 'false' });
    const user = await registerUser();
    const doc = await seedDocument(user.id, 'Invoice', 'Invoice number 42 from ACME Corp. Total due: 1200 USD.');

    const res = await instance
      .http()
      .post('/extractions')
      .set(bearer(user))
      .send({ documentId: doc.id, schemaName: 'invoice' })
      .timeout(TIMEOUT);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('DAILY_TOKEN_BUDGET_EXCEEDED');
    expect(instance.modelCalls).not.toHaveBeenCalled();
  });

  it('gives the reservation back when the model call fails', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    vi.spyOn(MockProvider.prototype, 'complete').mockRejectedValue(new Error('provider exploded'));

    const res = await ask(user, 'How did revenue change?');

    expect(res.status).toBe(500);
    expect((await budget.getUsage(user.id)).dayTokens).toBe(0);
  });

  it('one user exhausting the budget does not affect another', async () => {
    const instance = await fresh({ USER_DAILY_TOKEN_BUDGET: '6000', RATE_LIMIT_ENABLED: 'false' });
    const [a, b] = [await registerUser(), await registerUser()];
    await seedDocument(a.id, 'A', REPORT);
    await seedDocument(b.id, 'B', REPORT);
    const send = (user: TestUser, q: string) =>
      instance.http().post('/chat').set(bearer(user)).send({ question: q }).timeout(TIMEOUT);

    // 6000-token budget, ~4900 reserved per call: A's first call fits and settles to a few hundred tokens
    expect((await send(a, 'How did revenue change?')).status).toBe(200);
    expect((await send(b, 'How did revenue change?')).status).toBe(200);
  });
});

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { registerUser, bearer, resetData, flushRedis, closeConnections, loadFreshApp, type FreshApp } from './helpers.js';

const TIMEOUT = { response: 8000, deadline: 12000 };
const apps: FreshApp[] = [];

beforeEach(async () => {
  await resetData();
  await flushRedis('rl:');
});

afterAll(async () => {
  for (const fresh of apps) await fresh.close();
  await closeConnections();
});

async function fresh(env: Record<string, string>): Promise<FreshApp> {
  const instance = await loadFreshApp({ RATE_LIMIT_ENABLED: 'true', ...env });
  apps.push(instance);
  return instance;
}

const ask = (instance: FreshApp, token: string) =>
  instance.http().post('/chat').set('Authorization', `Bearer ${token}`).send({ question: 'Anything?' }).timeout(TIMEOUT);

describe('rate limiting', () => {
  it('returns 429 with Retry-After and the standard error shape once the limit is hit', async () => {
    const instance = await fresh({ RATE_LIMIT_CHAT_MAX: '2' });
    const user = await registerUser();

    expect((await ask(instance, user.accessToken)).status).toBe(200);
    expect((await ask(instance, user.accessToken)).status).toBe(200);
    const blocked = await ask(instance, user.accessToken);

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('limits per user, not per address: another user is not blocked', async () => {
    const instance = await fresh({ RATE_LIMIT_CHAT_MAX: '1' });
    const [a, b] = [await registerUser(), await registerUser()];

    expect((await ask(instance, a.accessToken)).status).toBe(200);
    expect((await ask(instance, a.accessToken)).status).toBe(429);
    expect((await ask(instance, b.accessToken)).status).toBe(200); // same IP, different user
  });

  it('shares the counter between API instances through Redis', async () => {
    const env = { RATE_LIMIT_CHAT_MAX: '2' };
    const instanceA = await fresh(env);
    const instanceB = await fresh(env);
    const user = await registerUser();

    expect((await ask(instanceA, user.accessToken)).status).toBe(200);
    expect((await ask(instanceA, user.accessToken)).status).toBe(200);
    // A second task serving the same user must see the two requests the first one counted
    expect((await ask(instanceB, user.accessToken)).status).toBe(429);
  });

  it('throttles repeated login attempts from one address', async () => {
    const instance = await fresh({ RATE_LIMIT_AUTH_MAX: '3' });
    const attempt = () =>
      instance.http().post('/auth/login').send({ email: 'nobody@example.com', password: 'Wrong-Password1' }).timeout(TIMEOUT);

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('fails open when Redis is unreachable: the API keeps answering instead of hanging', async () => {
    const instance = await fresh({ RATE_LIMIT_CHAT_MAX: '1', REDIS_PORT: '1' }); // nothing listens on port 1
    const user = await registerUser();

    const started = Date.now();
    const first = await ask(instance, user.accessToken);
    const second = await ask(instance, user.accessToken); // would be 429 if counters worked
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not limit anything when disabled', async () => {
    const instance = await fresh({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_CHAT_MAX: '1' });
    const user = await registerUser();
    for (let i = 0; i < 4; i++) {
      expect((await ask(instance, user.accessToken)).status).toBe(200);
    }
  });
});

// Keep `bearer` imported for parity with the other suites
void bearer;

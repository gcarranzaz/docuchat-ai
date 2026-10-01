import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { RedisRateLimitStore } from '../../src/middleware/redisRateLimitStore.js';
import { redis } from '../../src/config/redis.js';
import { flushRedis, closeConnections } from './helpers.js';
import type { Options } from 'express-rate-limit';

const PREFIX = 'rl:unit:';
const options = { windowMs: 2000 } as Options;

beforeEach(() => flushRedis(PREFIX));
afterAll(closeConnections);

function store() {
  const s = new RedisRateLimitStore(PREFIX);
  s.init(options);
  return s;
}

describe('RedisRateLimitStore', () => {
  it('counts hits per key within a window', async () => {
    const s = store();
    expect((await s.increment('a')).totalHits).toBe(1);
    expect((await s.increment('a')).totalHits).toBe(2);
    expect((await s.increment('b')).totalHits).toBe(1);
  });

  it('starts the window on the first hit and reports when it ends', async () => {
    const s = store();
    const before = Date.now();
    const { resetTime } = await s.increment('a');
    expect(resetTime.getTime()).toBeGreaterThanOrEqual(before + 1500);
    expect(resetTime.getTime()).toBeLessThanOrEqual(before + 2500);
    expect(await redis.pttl(`${PREFIX}a`)).toBeGreaterThan(0);
  });

  it('forgets the counter after the window', async () => {
    const s = store();
    await s.increment('a');
    await s.increment('a');
    await new Promise((resolve) => setTimeout(resolve, 2300));
    expect((await s.increment('a')).totalHits).toBe(1);
  });

  it('repairs a key that was left without a TTL so it cannot count forever', async () => {
    await redis.set(`${PREFIX}stuck`, '5'); // e.g. the process died between INCR and PEXPIRE
    const s = store();
    expect((await s.increment('stuck')).totalHits).toBe(6);
    expect(await redis.pttl(`${PREFIX}stuck`)).toBeGreaterThan(0);
  });

  it('decrements and resets', async () => {
    const s = store();
    await s.increment('a');
    await s.increment('a');
    await s.decrement('a');
    expect((await s.increment('a')).totalHits).toBe(2);
    await s.resetKey('a');
    expect((await s.increment('a')).totalHits).toBe(1);
  });

  it('is shared by anything talking to the same Redis (that is how several API tasks agree)', async () => {
    const one = store();
    const two = store();
    await one.increment('shared');
    expect((await two.increment('shared')).totalHits).toBe(2);
  });
});

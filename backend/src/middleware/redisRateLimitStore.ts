/**
 * Redis store for express-rate-limit
 * ==================================
 * A fixed-window counter shared by every API task: INCR the key, and give it a
 * TTL of one window on the first hit.
 *
 * Why not the rate-limit-redis package: it loads a Lua script when it is built and
 * caches that promise, so if Redis is down at that moment the store stays broken
 * until the process restarts. This store keeps no startup state: each call is
 * independent, so it recovers the moment Redis does.
 *
 * - Every Redis call is bounded by withRedisTimeout; the caller (express-rate-limit
 *   with passOnStoreError) then lets the request through instead of hanging.
 * - INCR and PEXPIRE are separate commands. If the process died between them the
 *   key would have no TTL and the counter would never reset, so every increment
 *   repairs a key that has none.
 */

import type { Redis } from 'ioredis';
import type { Store, Options, IncrementResponse } from 'express-rate-limit';
import { redis as sharedRedis, withRedisTimeout } from '../config/redis.js';

export class RedisRateLimitStore implements Store {
  readonly localKeys = false;
  private windowMs = 60_000;

  constructor(
    readonly prefix: string,
    private readonly client: Redis = sharedRedis
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const redisKey = this.prefix + key;

    const results = await withRedisTimeout(this.client.multi().incr(redisKey).pttl(redisKey).exec());
    if (!results || results.length < 2) throw new Error('Unexpected reply from Redis');

    const [incrResult, ttlResult] = results as [[Error | null, unknown], [Error | null, unknown]];
    if (incrResult[0]) throw incrResult[0];
    if (ttlResult[0]) throw ttlResult[0];

    const totalHits = Number(incrResult[1]);
    let ttlMs = Number(ttlResult[1]);

    // First hit of the window, or a key left without a TTL: (re)start the window
    if (totalHits === 1 || ttlMs < 0) {
      await withRedisTimeout(this.client.pexpire(redisKey, this.windowMs));
      ttlMs = this.windowMs;
    }

    return { totalHits, resetTime: new Date(Date.now() + ttlMs) };
  }

  async decrement(key: string): Promise<void> {
    await withRedisTimeout(this.client.decr(this.prefix + key));
  }

  async resetKey(key: string): Promise<void> {
    await withRedisTimeout(this.client.del(this.prefix + key));
  }
}

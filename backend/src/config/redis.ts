/**
 * Redis Configuration
 * ===================
 * Centralized Redis connection for job queues and caching
 */

import { Redis } from 'ioredis';
import { config } from './index.js';
import { logger } from '../utils/logger.js';

export const redis = new Redis({
  // host, port, password, db and (when REDIS_TLS=true) tls. The password was not passed before,
  // which could never have worked against a Redis that requires AUTH.
  ...config.redis,
  maxRetriesPerRequest: null, // Required for BullMQ
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  lazyConnect: true,
});

redis.on('connect', () => {
  logger.info({ host: config.redis.host, port: config.redis.port }, 'Redis connected');
});

redis.on('error', (error) => {
  logger.error({ err: error }, 'Redis connection error');
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

// Connect to Redis
export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to Redis');
    throw error;
  }
}

// Disconnect from Redis
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}

/**
 * Bound a Redis call used on the request path (rate limits, answer cache).
 *
 * The shared client keeps `maxRetriesPerRequest: null` because BullMQ requires it,
 * which means commands wait forever while Redis is down. Request-path code must not
 * inherit that: it races the call against a short timeout and treats a timeout like
 * any other Redis failure (rate limiter: fail open; cache: miss).
 */
export function withRedisTimeout<T>(call: Promise<T>, ms = 500): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis call timed out after ${ms}ms`)), ms);
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

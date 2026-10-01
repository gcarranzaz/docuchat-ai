/**
 * Redis Configuration
 * ===================
 * Centralized Redis connection for job queues and caching
 */

import { Redis } from 'ioredis';
import { config } from './index.js';
import { logger } from '../utils/logger.js';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
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

/**
 * Answer cache
 * ============
 * Saves a model call when the same user asks the same question over the same
 * retrieved passages. Deliberately conservative:
 *
 * - The key contains the user id, so an answer is never served to another user.
 * - It also contains the retrieved chunk ids, the prompt version and the model:
 *   if a document changes, the prompt changes or the model changes, it is a miss.
 * - Only the first turn of a conversation is cached (history changes the answer).
 * - Short TTL. Redis failures degrade to "no cache", never to a failed request.
 */

import { createHash } from 'node:crypto';
import { redis, withRedisTimeout } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import type { Citation } from '../types/index.js';

export interface CachedAnswer {
  answer: string;
  citations: Citation[];
  rawConfidence: string;
  reasoning: string | undefined;
  droppedCitations: number;
  model: string;
  promptVersion: string;
}

export interface CacheKeyParts {
  userId: string;
  question: string;
  chunkIds: string[];
  promptVersion: string;
  model: string;
}

export function buildCacheKey(parts: CacheKeyParts): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([parts.question.trim().toLowerCase(), parts.chunkIds, parts.promptVersion, parts.model]))
    .digest('hex');
  return `aicache:chat:${parts.userId}:${digest}`;
}

export async function getCachedAnswer(key: string): Promise<CachedAnswer | null> {
  try {
    const raw = await withRedisTimeout(redis.get(key));
    return raw ? (JSON.parse(raw) as CachedAnswer) : null;
  } catch (error) {
    logger.warn({ err: error }, 'Answer cache read failed; continuing without cache');
    return null;
  }
}

export async function setCachedAnswer(key: string, value: CachedAnswer, ttlSeconds: number): Promise<void> {
  try {
    await withRedisTimeout(redis.set(key, JSON.stringify(value), 'EX', ttlSeconds));
  } catch (error) {
    logger.warn({ err: error }, 'Answer cache write failed; continuing without cache');
  }
}

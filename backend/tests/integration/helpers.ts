/**
 * Helpers for integration tests: one app instance, a clean database per test,
 * users created through the real API, and documents seeded through the real
 * chunk/embed/store path (mock embeddings, real pgvector).
 */

import request from 'supertest';
import { Redis } from 'ioredis';
import { vi } from 'vitest';
import { TEST_ENV } from './env.js';
import { createApp } from '../../src/app.js';
import { getPool, closePool } from '../../src/config/database.js';
import { redis } from '../../src/config/redis.js';
import { embeddingsQueue, embeddingsQueueEvents } from '../../src/queues/embeddings.queue.js';
import * as documentRepo from '../../src/repositories/document.repository.js';
import { processDocument } from '../../src/rag/embeddings.js';

export const app = createApp();
export const api = () => request(app);

/** Remove all application data (users cascade to everything they own) */
export async function resetData(): Promise<void> {
  // audit_log refuses TRUNCATE unless the transaction opts in (the retention job does the same)
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.audit_purge = 'on'");
    await client.query('TRUNCATE users, usage_logs, audit_log RESTART IDENTITY CASCADE');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Resolve when the promise settles or after `ms`, whichever comes first: cleanup must never hang a suite */
export async function settleWithin(promise: Promise<unknown>, ms = 2000): Promise<void> {
  await Promise.race([promise.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

export async function closeConnections(): Promise<void> {
  await settleWithin(embeddingsQueue.close());
  await settleWithin(embeddingsQueueEvents.close());
  if (redis.status !== 'end') {
    await settleWithin(redis.quit());
  }
  await settleWithin(closePool());
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

let counter = 0;

export async function registerUser(email?: string, password = 'CorrectHorse9!battery'): Promise<TestUser> {
  const address = email ?? `user${++counter}-${Date.now()}@example.com`;
  const res = await api().post('/auth/register').send({ email: address, password });
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    id: res.body.user.id,
    email: address,
    password,
    accessToken: res.body.tokens.accessToken,
    refreshToken: res.body.tokens.refreshToken,
  };
}

export const bearer = (user: Pick<TestUser, 'accessToken'>) => ({ Authorization: `Bearer ${user.accessToken}` });

/** Create a document and run the real chunk → embed → store path (no queue, no worker) */
export async function seedDocument(userId: string, title: string, content: string) {
  const doc = await documentRepo.create({ userId, title, content, mimeType: 'text/plain' });
  await processDocument(doc.id, userId, content, title);
  return doc;
}

/** Delete Redis keys with a prefix (rate-limit counters, answer cache) between tests */
export async function flushRedis(...prefixes: string[]): Promise<void> {
  const client = new Redis({ host: TEST_ENV['REDIS_HOST'], port: Number(TEST_ENV['REDIS_PORT']), lazyConnect: false });
  try {
    for (const prefix of prefixes) {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length > 0) await client.del(...keys);
    }
  } finally {
    client.disconnect();
  }
}

export interface FreshApp {
  app: ReturnType<typeof createApp>;
  http: () => ReturnType<typeof request>;
  /** Spy on every model call this app makes (the mock provider's `complete`) */
  modelCalls: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}

/**
 * Build an app with different environment settings (rate limits, budgets, a dead Redis...).
 * Configuration is read once at import time, so this resets the module graph and imports
 * everything again; the shared `app`/`api()` above are unaffected. Call close() when done.
 */
export async function loadFreshApp(env: Record<string, string>): Promise<FreshApp> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  vi.resetModules();
  const { createApp: create } = await import('../../src/app.js');
  const { MockProvider } = await import('../../src/ai/providers/mock.provider.js');
  const database = await import('../../src/config/database.js');
  const redisModule = await import('../../src/config/redis.js');
  const queue = await import('../../src/queues/embeddings.queue.js');

  const fresh = create();
  const modelCalls = vi.spyOn(MockProvider.prototype, 'complete') as unknown as ReturnType<typeof vi.fn>;

  // Configuration was read while the modules loaded: put the environment back right away so
  // overrides cannot leak into the next test (an earlier test's tiny budget, a dead Redis port...)
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return {
    app: fresh,
    http: () => request(fresh),
    modelCalls,
    close: async () => {
      vi.restoreAllMocks();
      redisModule.redis.disconnect();
      // With a dead Redis these closes can wait forever: do not let cleanup hang the suite
      await settleWithin(queue.embeddingsQueue.close(), 1500);
      await settleWithin(queue.embeddingsQueueEvents.close(), 1500);
      await settleWithin(database.closePool(), 2000);
    },
  };
}

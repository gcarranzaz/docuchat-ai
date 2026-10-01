/**
 * Environment for the integration tests.
 * Shared by vitest.integration.config.ts (workers) and globalSetup.ts (migrations).
 *
 * Defaults match docker-compose.test.yml. CI overrides them with TEST_DATABASE_URL,
 * TEST_REDIS_HOST and TEST_REDIS_PORT. Everything runs on the mock AI provider:
 * no API keys, deterministic answers.
 */

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  // TEST_LOG_LEVEL=error (or debug) to see what the app logs while a test runs
  LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgresql://docuchat:docuchat_test@localhost:55432/docuchat_test',
  REDIS_HOST: process.env['TEST_REDIS_HOST'] ?? 'localhost',
  REDIS_PORT: process.env['TEST_REDIS_PORT'] ?? '56379',
  JWT_SECRET: 'integration-test-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'integration-test-refresh-secret-0123456789abcd',
  AI_PROVIDER: 'mock',
  EMBEDDING_PROVIDER: 'mock',
  // Mock embeddings are hash-based, so similarity to a real question is arbitrary.
  // Retrieval is still exercised end to end (pgvector, user filter); only the cutoff is off.
  MIN_SIMILARITY_THRESHOLD: '0',
  RATE_LIMIT_ENABLED: 'false',
};

import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './tests/integration/env.js';

// Integration tests need Postgres (pgvector) and Redis:
//   docker compose -f docker-compose.test.yml up -d --wait
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/globalSetup.ts'],
    env: TEST_ENV,
    // One shared database: files run one after another
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

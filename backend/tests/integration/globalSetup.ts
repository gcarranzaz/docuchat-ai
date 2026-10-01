/**
 * Runs once before all integration tests: recreate the public schema and apply
 * the real migrations, so tests always run against the schema the app ships with.
 */

import { TEST_ENV } from './env.js';

export default async function setup(): Promise<void> {
  Object.assign(process.env, TEST_ENV);

  // Imported after the environment is set: config is read from process.env
  const { getPool, closePool } = await import('../../src/config/database.js');
  const { runMigrations } = await import('../../src/config/migrations.js');

  const pool = getPool();
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${TEST_ENV['DATABASE_URL']}.\n` +
        'Start it with: docker compose -f docker-compose.test.yml up -d --wait\n' +
        `(${(error as Error).message})`
    );
  }

  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const summary = await runMigrations();
  if (summary.applied === 0) {
    throw new Error('Integration setup applied no migrations');
  }
  await closePool();
}

/**
 * Database migrations
 * ===================
 * Simple runner that executes the SQL files in `backend/migrations` in
 * alphabetical order and records each one in `_migrations`.
 *
 * Importable (used by the integration test setup); the CLI entry point is migrate.ts.
 * For a larger team, node-pg-migrate or Knex migrations would add down-migrations
 * and locking; this keeps the dependency count at zero and every step visible.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from './database.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MigrationSummary {
  applied: number;
  skipped: number;
  total: number;
}

async function ensureMigrationTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function isApplied(name: string): Promise<boolean> {
  const result = await query('SELECT 1 FROM _migrations WHERE name = $1', [name]);
  return (result.rowCount ?? 0) > 0;
}

export async function runMigrations(): Promise<MigrationSummary> {
  logger.info('Starting database migrations...');

  await ensureMigrationTable();

  const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Alphabetical order ensures correct execution order

  let applied = 0;
  let skipped = 0;

  for (const file of files) {
    if (await isApplied(file)) {
      logger.debug({ migration: file }, 'Migration already applied, skipping');
      skipped++;
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info({ migration: file }, 'Applying migration...');

    try {
      await query(sql);
      await query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      logger.info({ migration: file }, 'Migration applied successfully');
      applied++;
    } catch (error) {
      logger.error({ migration: file, err: error }, 'Migration failed');
      throw error;
    }
  }

  logger.info({ applied, skipped, total: files.length }, 'Migrations complete');
  return { applied, skipped, total: files.length };
}

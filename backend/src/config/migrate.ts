/**
 * Database Migration Script
 * =========================
 * Simple migration runner that executes SQL files in order.
 *
 * Why this approach (not a full migration tool):
 * - MVP simplicity: No additional dependency
 * - Explicit control: See exactly what runs
 * - Idempotent: Uses CREATE IF NOT EXISTS
 *
 * For production, consider: node-pg-migrate, Knex migrations, or Prisma
 *
 * Usage:
 *   npm run migrate
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, closePool } from './database.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===========================================
// Migration Tracking Table
// ===========================================

async function ensureMigrationTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getMigrationStatus(name: string): Promise<boolean> {
  const result = await query(
    'SELECT 1 FROM _migrations WHERE name = $1',
    [name]
  );
  return (result.rowCount ?? 0) > 0;
}

async function recordMigration(name: string): Promise<void> {
  await query(
    'INSERT INTO _migrations (name) VALUES ($1)',
    [name]
  );
}

// ===========================================
// Run Migrations
// ===========================================

async function runMigrations(): Promise<void> {
  logger.info('Starting database migrations...');

  // Ensure migration tracking table exists
  await ensureMigrationTable();

  // Find migration files
  const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // Alphabetical order ensures correct execution order

  let appliedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const migrationName = file;

    // Check if already applied
    const alreadyApplied = await getMigrationStatus(migrationName);
    if (alreadyApplied) {
      logger.debug({ migration: migrationName }, 'Migration already applied, skipping');
      skippedCount++;
      continue;
    }

    // Read and execute migration
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    logger.info({ migration: migrationName }, 'Applying migration...');

    try {
      await query(sql);
      await recordMigration(migrationName);
      logger.info({ migration: migrationName }, 'Migration applied successfully');
      appliedCount++;
    } catch (error) {
      logger.error({
        migration: migrationName,
        err: error,
      }, 'Migration failed');
      throw error;
    }
  }

  logger.info({
    applied: appliedCount,
    skipped: skippedCount,
    total: files.length,
  }, 'Migrations complete');
}

// ===========================================
// Main
// ===========================================

async function main() {
  try {
    await runMigrations();
    await closePool();
    process.exit(0);
  } catch (error) {
    logger.fatal({ err: error }, 'Migration failed');
    await closePool();
    process.exit(1);
  }
}

main();

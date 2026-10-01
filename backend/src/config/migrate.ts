/**
 * Database Migration CLI
 * ======================
 *   npm run migrate
 *
 * The runner itself lives in migrations.ts so tests can import it without
 * triggering a process exit.
 */

import { closePool } from './database.js';
import { runMigrations } from './migrations.js';
import { logger } from '../utils/logger.js';

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

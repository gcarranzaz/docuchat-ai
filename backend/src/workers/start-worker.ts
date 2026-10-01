/**
 * Worker Start Script
 * ===================
 * Standalone executable to run embedding worker
 *
 * Usage:
 *   npm run dev:worker
 *   or
 *   tsx src/workers/start-worker.ts
 *
 * This allows workers to be deployed separately from the API server
 */

import { logger } from '../utils/logger.js';
import { getPool, checkDatabaseHealth } from '../config/database.js';
import './embeddings.worker.js'; // Import starts the worker

async function main(): Promise<void> {
  logger.info('Starting embeddings worker...');

  try {
    // Initialize database connection pool
    getPool();

    // Verify database connectivity
    const health = await checkDatabaseHealth();
    if (!health.healthy) {
      throw new Error(`Database health check failed: ${health.error}`);
    }

    logger.info({ latencyMs: health.latencyMs }, 'Worker connected to database');
    logger.info('✅ Embeddings worker started successfully');
    logger.info('Waiting for jobs...');
  } catch (error) {
    logger.error({ err: error }, 'Failed to start worker');
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'Unhandled error in worker startup');
  process.exit(1);
});

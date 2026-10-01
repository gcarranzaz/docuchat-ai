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
import { initProviders } from '../ai/providers/providerFactory.js';
import './embeddings.worker.js'; // Import starts the worker
import './maintenance.worker.js'; // Import starts the retention worker
import { scheduleRetention } from '../queues/maintenance.queue.js';

async function main(): Promise<void> {
  logger.info('Starting embeddings worker...');

  try {
    // Fail at startup (not on the first job) if the embedding provider is misconfigured
    initProviders();

    // Initialize database connection pool
    getPool();

    // Verify database connectivity
    const health = await checkDatabaseHealth();
    if (!health.healthy) {
      throw new Error(`Database health check failed: ${health.error}`);
    }

    logger.info({ latencyMs: health.latencyMs }, 'Worker connected to database');
    await scheduleRetention();
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

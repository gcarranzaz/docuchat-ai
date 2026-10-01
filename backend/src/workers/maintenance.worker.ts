/**
 * Maintenance worker: runs the scheduled retention job.
 */

import { Worker } from 'bullmq';
import { MAINTENANCE_QUEUE, maintenanceConnection } from '../queues/maintenance.queue.js';
import { runRetention } from '../services/retention.service.js';
import { logger } from '../utils/logger.js';

export const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name === 'retention') {
      return runRetention();
    }
    logger.warn({ job: job.name }, 'Unknown maintenance job');
    return undefined;
  },
  { connection: maintenanceConnection, concurrency: 1 }
);

maintenanceWorker.on('failed', (job, error) => {
  logger.error({ err: error, job: job?.name }, 'Maintenance job failed');
});

/**
 * Maintenance queue
 * =================
 * Housekeeping that must run on a schedule, not per request: today, data retention.
 * The scheduler is created by the worker at startup (upsert, so restarts and several
 * worker tasks do not create duplicates).
 */

import { Queue } from 'bullmq';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export const MAINTENANCE_QUEUE = 'maintenance';
export const RETENTION_SCHEDULER_ID = 'retention';

/** Every day at 03:00 UTC, when traffic is lowest */
export const RETENTION_CRON = '0 3 * * *';

export const maintenanceConnection = { ...config.redis };

export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
  connection: maintenanceConnection,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: { count: 30 }, removeOnFail: { count: 30 } },
});

/** Idempotent: calling it again replaces the scheduler with the same definition */
export async function scheduleRetention(): Promise<void> {
  await maintenanceQueue.upsertJobScheduler(RETENTION_SCHEDULER_ID, { pattern: RETENTION_CRON, tz: 'UTC' }, { name: 'retention', data: {} });
  logger.info({ cron: RETENTION_CRON }, 'Retention job scheduled');
}

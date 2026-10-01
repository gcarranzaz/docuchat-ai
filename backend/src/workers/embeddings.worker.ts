/**
 * Embeddings Worker
 * ==================
 * Background worker that processes embedding generation jobs
 *
 * Architecture:
 * - Runs as separate process (can scale horizontally)
 * - Picks jobs from Redis queue
 * - Calls embedding service to process documents
 * - Updates job progress
 * - Handles errors with retry logic
 *
 * Deployment:
 * - Can run as systemd service, PM2 process, or K8s deployment
 * - Horizontally scalable (multiple workers)
 * - Graceful shutdown on SIGTERM/SIGINT
 */

import { Worker, Job } from 'bullmq';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { processDocument } from '../rag/embeddings.js';
import type { EmbeddingJobData, EmbeddingJobResult } from '../queues/embeddings.queue.js';

const QUEUE_NAME = 'embeddings';

const redisConnection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
};

// ===========================================
// Worker Instance
// ===========================================

export const embeddingsWorker = new Worker<EmbeddingJobData, EmbeddingJobResult>(
  QUEUE_NAME,
  async (job: Job<EmbeddingJobData>) => {
    const { documentId, userId, content, title } = job.data;

    logger.info(
      {
        jobId: job.id,
        documentId,
        userId,
        contentLength: content.length,
      },
      'Processing embedding job'
    );

    try {
      // Update progress: starting
      await job.updateProgress(0);

      // Process the document (chunk + embed)
      await job.updateProgress(25);

      const result = await processDocument(documentId, userId, content, title);

      // Update progress: completed
      await job.updateProgress(100);

      logger.info(
        {
          jobId: job.id,
          documentId,
          chunksCreated: result.chunksCreated,
          totalTokens: result.totalTokens,
        },
        'Embedding job completed successfully'
      );

      return {
        documentId,
        chunksCreated: result.chunksCreated,
        chunksEmbedded: result.chunksEmbedded,
        totalTokens: result.totalTokens,
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error(
        {
          err: error,
          jobId: job.id,
          documentId,
        },
        'Embedding job failed'
      );

      // Throw error so BullMQ retries
      throw new Error(`Embedding generation failed: ${errorMessage}`);
    }
  },
  {
    connection: redisConnection,
    concurrency: 3, // Process up to 3 jobs concurrently
    limiter: {
      max: 10, // Max 10 jobs per
      duration: 60000, // 1 minute (to respect API rate limits)
    },
  }
);

// ===========================================
// Worker Events
// ===========================================

embeddingsWorker.on('ready', () => {
  logger.info('Embeddings worker ready');
});

embeddingsWorker.on('active', (job) => {
  logger.debug({ jobId: job.id }, 'Job active');
});

embeddingsWorker.on('completed', (job, result) => {
  logger.info(
    {
      jobId: job.id,
      documentId: result.documentId,
      chunksCreated: result.chunksCreated,
    },
    'Job completed'
  );
});

embeddingsWorker.on('failed', (job, error) => {
  logger.error(
    {
      jobId: job?.id,
      error: error.message,
      attemptsMade: job?.attemptsMade,
    },
    'Job failed'
  );
});

embeddingsWorker.on('error', (error) => {
  logger.error({ err: error }, 'Worker error');
});

embeddingsWorker.on('stalled', (jobId) => {
  logger.warn({ jobId }, 'Job stalled (worker crashed or took too long)');
});

// ===========================================
// Graceful Shutdown
// ===========================================

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down embeddings worker gracefully');

  try {
    // Wait for current jobs to complete (30s timeout)
    await embeddingsWorker.close();
    logger.info('Worker closed successfully');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ===========================================
// Export for Management
// ===========================================

export async function stopWorker(): Promise<void> {
  await embeddingsWorker.close();
  logger.info('Embeddings worker stopped');
}

export function getWorkerStatus(): {
  isRunning: boolean;
  isPaused: boolean;
} {
  return {
    isRunning: embeddingsWorker.isRunning(),
    isPaused: embeddingsWorker.isPaused(),
  };
}

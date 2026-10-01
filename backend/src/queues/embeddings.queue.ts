/**
 * Embeddings Queue
 * ================
 * Handles async document embedding processing
 *
 * Why async processing?
 * - Embedding generation can take 1-10 seconds for large documents
 * - Prevents HTTP timeout for user uploads
 * - Allows retry on failure
 * - Better user experience (upload returns immediately)
 *
 * Queue workflow:
 * 1. Document uploaded → stored in DB → job enqueued
 * 2. Worker picks up job → chunks → generates embeddings → stores
 * 3. Frontend can poll document status or use WebSockets for updates
 */

import { Queue, QueueEvents } from 'bullmq';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// ===========================================
// Job Data Interface
// ===========================================

export interface EmbeddingJobData {
  documentId: string;
  userId: string;
  content: string;
  title: string;
}

export interface EmbeddingJobResult {
  documentId: string;
  chunksCreated: number;
  chunksEmbedded: number;
  totalTokens: number;
  success: boolean;
  error?: string;
}

// ===========================================
// Queue Configuration
// ===========================================

const QUEUE_NAME = 'embeddings';

const redisConnection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
};

// ===========================================
// Queue Instance
// ===========================================

export const embeddingsQueue = new Queue<EmbeddingJobData, EmbeddingJobResult>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times
    backoff: {
      type: 'exponential',
      delay: 2000, // Start with 2s, then 4s, then 8s
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 1000, // Keep max 1000 completed jobs
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
});

// ===========================================
// Queue Events (for monitoring)
// ===========================================

export const embeddingsQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: redisConnection,
});

embeddingsQueueEvents.on('completed', ({ jobId, returnvalue }) => {
  // QueueEvents delivers the return value as a JSON string
  let result: Partial<EmbeddingJobResult> = {};
  try {
    result = typeof returnvalue === 'string' ? JSON.parse(returnvalue) : (returnvalue as Partial<EmbeddingJobResult>);
  } catch {
    // keep empty result; the job itself completed
  }
  logger.info(
    {
      jobId,
      documentId: result.documentId,
      chunksCreated: result.chunksCreated,
    },
    'Embedding job completed'
  );
});

embeddingsQueueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error(
    {
      jobId,
      reason: failedReason,
    },
    'Embedding job failed'
  );
});

// 'retrying' is not part of QueueEvents' typed listeners; a retry shows up as
// a 'failed' event followed by a new attempt, which is already logged above.

// ===========================================
// Queue Operations
// ===========================================

/**
 * Add a document to the embedding queue
 */
export async function enqueueEmbeddingJob(data: EmbeddingJobData): Promise<string> {
  const job = await embeddingsQueue.add('process-document', data, {
    jobId: `doc-${data.documentId}`, // Unique ID prevents duplicate jobs
  });

  logger.info(
    {
      jobId: job.id,
      documentId: data.documentId,
      userId: data.userId,
    },
    'Embedding job enqueued'
  );

  return job.id!;
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string): Promise<{
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
  progress?: number;
  result?: EmbeddingJobResult;
  error?: string;
}> {
  const job = await embeddingsQueue.getJob(jobId);

  if (!job) {
    return { status: 'unknown' };
  }

  const state = await job.getState();

  const response: {
    status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
    progress?: number;
    result?: EmbeddingJobResult;
    error?: string;
  } = {
    status: state as 'waiting' | 'active' | 'completed' | 'failed' | 'delayed',
  };

  if (state === 'completed') {
    response.result = job.returnvalue;
  } else if (state === 'failed') {
    response.error = job.failedReason;
  } else if (state === 'active') {
    response.progress = typeof job.progress === 'number' ? job.progress : undefined;
  }

  return response;
}

/**
 * Get document processing status by document ID
 */
export async function getDocumentJobStatus(documentId: string): Promise<ReturnType<typeof getJobStatus>> {
  const jobId = `doc-${documentId}`;
  return getJobStatus(jobId);
}

/**
 * Cancel a job
 */
export async function cancelJob(jobId: string): Promise<void> {
  const job = await embeddingsQueue.getJob(jobId);
  if (job) {
    await job.remove();
    logger.info({ jobId }, 'Job cancelled');
  }
}

/**
 * Clean old jobs
 */
export async function cleanOldJobs(): Promise<void> {
  await embeddingsQueue.clean(3600 * 1000, 1000, 'completed'); // 1 hour
  await embeddingsQueue.clean(86400 * 1000, 1000, 'failed'); // 24 hours
  logger.info('Old jobs cleaned');
}

// ===========================================
// Graceful Shutdown
// ===========================================

export async function closeQueue(): Promise<void> {
  await embeddingsQueue.close();
  await embeddingsQueueEvents.close();
  logger.info('Embeddings queue closed');
}

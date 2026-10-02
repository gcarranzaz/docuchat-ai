/**
 * Embedding Service
 * =================
 * Handles document embedding generation and storage.
 *
 * Workflow:
 * 1. Document uploaded → chunked → chunks stored without embeddings
 * 2. Embedding service generates embeddings (sync or async)
 * 3. Embeddings stored in pgvector for similarity search
 *
 * Optimization:
 * - Batch embedding generation (reduces API calls)
 * - Caching: embeddings only generated once per chunk
 * - Reuse: if chunk content unchanged, keep existing embedding
 */

import { getEmbeddingProvider } from '../ai/providers/providerFactory.js';
import * as chunkRepo from '../repositories/chunk.repository.js';
import * as documentRepo from '../repositories/document.repository.js';
import * as usageRepo from '../repositories/usage.repository.js';
import { chunkText } from './chunker.js';
import { logger } from '../utils/logger.js';

// ===========================================
// Types
// ===========================================

export interface EmbeddingResult {
  documentId: string;
  chunksCreated: number;
  chunksEmbedded: number;
  totalTokens: number;
}

// ===========================================
// Main Functions
// ===========================================

/**
 * Process a document: chunk it and generate embeddings
 * This is the main entry point for document ingestion
 */
export async function processDocument(
  documentId: string,
  userId: string,
  content: string,
  title: string
): Promise<EmbeddingResult> {
  const provider = getEmbeddingProvider();
  const startTime = Date.now();

  logger.info({ documentId, contentLength: content.length }, 'Processing document for embeddings');

  // Step 1: Chunk the document
  const chunks = chunkText(content);
  logger.debug({ documentId, chunkCount: chunks.length }, 'Document chunked');

  if (chunks.length === 0) {
    return {
      documentId,
      chunksCreated: 0,
      chunksEmbedded: 0,
      totalTokens: 0,
    };
  }

  // Step 2: Generate embeddings for all chunks
  const chunkContents = chunks.map((c) => c.content);
  let embeddings: { embedding: number[]; tokenCount: number }[];
  let totalTokens = 0;

  try {
    embeddings = await provider.embedBatch(chunkContents);
    totalTokens = embeddings.reduce((sum, e) => sum + e.tokenCount, 0);

    logger.debug({
      documentId,
      embeddingsGenerated: embeddings.length,
      totalTokens,
    }, 'Embeddings generated');
  } catch (error) {
    logger.error({ err: error, documentId }, 'Failed to generate embeddings');
    throw error;
  }

  // Step 3: Store chunks with embeddings
  const chunkInputs = chunks.map((chunk, index) => ({
    documentId,
    userId,
    chunkIndex: chunk.index,
    content: chunk.content,
    tokenCount: chunk.tokenCount,
    embedding: embeddings[index]?.embedding,
    metadata: {
      startPosition: chunk.startPosition,
      endPosition: chunk.endPosition,
      documentTitle: title,
    },
  }));

  const storedChunks = await chunkRepo.createBatch(chunkInputs);

  // Step 4: Update document chunk count
  await documentRepo.updateChunkCount(documentId, userId, storedChunks.length);

  // Step 5: Log usage
  await usageRepo.create({
    userId,
    operation: 'embed',
    provider: provider.name,
    model: provider.name === 'openai' ? 'text-embedding-3-small' : 'mock',
    inputTokens: totalTokens,
    outputTokens: 0,
    latencyMs: Date.now() - startTime,
    success: true,
    metadata: {
      documentId,
      chunkCount: chunks.length,
    },
  });

  logger.info({
    documentId,
    chunksCreated: storedChunks.length,
    totalTokens,
    latencyMs: Date.now() - startTime,
  }, 'Document processed successfully');

  return {
    documentId,
    chunksCreated: storedChunks.length,
    chunksEmbedded: storedChunks.length,
    totalTokens,
  };
}

/**
 * Generate embedding for a query (for similarity search)
 */
export async function embedQuery(
  query: string,
  userId: string
): Promise<{ embedding: number[]; tokenCount: number }> {
  const provider = getEmbeddingProvider();
  const startTime = Date.now();

  const result = await provider.embed(query);

  // Log usage
  await usageRepo.create({
    userId,
    operation: 'embed',
    provider: provider.name,
    model: provider.name === 'openai' ? 'text-embedding-3-small' : 'mock',
    inputTokens: result.tokenCount,
    outputTokens: 0,
    latencyMs: Date.now() - startTime,
    success: true,
    metadata: {
      queryLength: query.length,
    },
  });

  return result;
}

/**
 * Re-embed a document (useful if chunking strategy changes)
 */
export async function reprocessDocument(
  documentId: string,
  userId: string
): Promise<EmbeddingResult> {
  // Get the document
  const document = await documentRepo.findById(documentId, userId);
  if (!document) {
    throw new Error('Document not found');
  }

  // Delete existing chunks
  await chunkRepo.deleteByDocumentId(documentId, userId);

  // Reprocess
  return processDocument(documentId, userId, document.content, document.title);
}

/**
 * Check if a document needs embedding
 */
export async function needsEmbedding(
  documentId: string,
  userId: string
): Promise<boolean> {
  const hasEmbeddings = await chunkRepo.hasEmbeddings(documentId, userId);
  return !hasEmbeddings;
}

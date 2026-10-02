/**
 * Document Retriever
 * ==================
 * Finds relevant document chunks for a query using vector similarity.
 *
 * How it works:
 * 1. Embed the user's query
 * 2. Search pgvector for similar chunks (cosine similarity)
 * 3. Return top-K chunks with relevance scores
 *
 * Relevance score interpretation:
 * - 0.9+: Very relevant, almost exact match
 * - 0.7-0.9: Relevant, good context
 * - 0.5-0.7: Somewhat relevant, may be useful
 * - <0.5: Not very relevant
 */

import * as chunkRepo from '../repositories/chunk.repository.js';
import { embedQuery } from './embeddings.js';
import { getConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type { ChunkWithScore } from '../types/index.js';

// ===========================================
// Types
// ===========================================

export interface RetrievalOptions {
  /** Maximum chunks to return */
  topK?: number;
  /** Minimum similarity score (0-1) */
  minSimilarity?: number;
  /** Filter to specific documents */
  documentIds?: string[];
}

export interface RetrievalResult {
  chunks: ChunkWithScore[];
  query: string;
  queryTokens: number;
}

// ===========================================
// Retrieval Functions
// ===========================================

/**
 * Retrieve relevant chunks for a query
 */
export async function retrieveChunks(
  query: string,
  userId: string,
  options: RetrievalOptions = {}
): Promise<RetrievalResult> {
  const config = getConfig();
  const topK = options.topK ?? config.maxChunksPerQuery;
  // Use configured threshold (0.6 by default for production quality)
  // Lower for mock provider (0.0) in dev/test if needed via env var
  const minSimilarity = options.minSimilarity ?? config.minSimilarityThreshold;

  logger.debug({ queryLength: query.length, userId, topK, minSimilarity }, 'Starting chunk retrieval');

  // Step 1: Embed the query
  const { embedding, tokenCount } = await embedQuery(query, userId);

  // Step 2: Find similar chunks
  const chunks = await chunkRepo.findSimilar(userId, embedding, {
    limit: topK,
    documentIds: options.documentIds,
    minSimilarity,
  });

  logger.debug({
    queryLength: query.length,
    chunksFound: chunks.length,
    topScore: chunks[0]?.score ?? 0,
  }, 'Chunks retrieved');

  return {
    chunks,
    query,
    queryTokens: tokenCount,
  };
}

// Context formatting (buildContextFromChunks, createChunkMapping) lives in ./context.ts:
// it is prompt construction, not retrieval, and has no database dependency.

/**
 * Calculate overall relevance score for a retrieval
 * Used to determine confidence level
 */
export function calculateRetrievalScore(chunks: ChunkWithScore[]): number {
  if (chunks.length === 0) return 0;

  // Weighted average: higher weight for top results
  const weights = chunks.map((_, i) => 1 / (i + 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const weightedSum = chunks.reduce((sum, chunk, i) => {
    return sum + chunk.score * (weights[i] ?? 0);
  }, 0);

  return weightedSum / totalWeight;
}

/**
 * Chunk Repository
 * ================
 * Data access layer for document chunks with pgvector support.
 *
 * Uses PostgreSQL pgvector extension for:
 * - Storing high-dimensional embeddings (1536 dims)
 * - Fast similarity search using HNSW index
 * - Cosine similarity for semantic matching
 *
 * IMPORTANT: All queries filter by userId for tenant isolation.
 */

import { query, withTransaction, getClient } from '../config/database.js';
import type { DocChunk, ChunkWithScore } from '../types/index.js';
import { getConfig } from '../config/index.js';

// ===========================================
// Types
// ===========================================

interface ChunkRow {
  id: string;
  document_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  embedding: string | null; // pgvector returns as string
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface ChunkWithScoreRow extends ChunkRow {
  similarity: number;
}

export interface CreateChunkInput {
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  tokenCount?: number;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

// ===========================================
// Repository Functions
// ===========================================

/**
 * Create a single chunk
 */
export async function create(input: CreateChunkInput): Promise<DocChunk> {
  const embeddingValue = input.embedding
    ? `[${input.embedding.join(',')}]`
    : null;

  const result = await query<ChunkRow>(
    `INSERT INTO doc_chunks (document_id, user_id, chunk_index, content, token_count, embedding, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
     RETURNING *`,
    [
      input.documentId,
      input.userId,
      input.chunkIndex,
      input.content,
      input.tokenCount || null,
      embeddingValue,
      JSON.stringify(input.metadata || {}),
    ]
  );

  return mapRowToChunk(result.rows[0]!);
}

/**
 * Create multiple chunks in a transaction (for batch insert)
 */
export async function createBatch(inputs: CreateChunkInput[]): Promise<DocChunk[]> {
  if (inputs.length === 0) return [];

  return withTransaction(async (client) => {
    const chunks: DocChunk[] = [];

    for (const input of inputs) {
      const embeddingValue = input.embedding
        ? `[${input.embedding.join(',')}]`
        : null;

      const result = await client.query<ChunkRow>(
        `INSERT INTO doc_chunks (document_id, user_id, chunk_index, content, token_count, embedding, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
         RETURNING *`,
        [
          input.documentId,
          input.userId,
          input.chunkIndex,
          input.content,
          input.tokenCount || null,
          embeddingValue,
          JSON.stringify(input.metadata || {}),
        ]
      );

      chunks.push(mapRowToChunk(result.rows[0]!));
    }

    return chunks;
  });
}

/**
 * Update chunk embedding (for async embedding generation)
 */
export async function updateEmbedding(
  chunkId: string,
  userId: string,
  embedding: number[]
): Promise<boolean> {
  const embeddingValue = `[${embedding.join(',')}]`;

  const result = await query(
    `UPDATE doc_chunks
     SET embedding = $3::vector
     WHERE id = $1 AND user_id = $2`,
    [chunkId, userId, embeddingValue]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Find similar chunks using cosine similarity
 * This is the core RAG retrieval function
 */
export async function findSimilar(
  userId: string,
  embedding: number[],
  options: {
    limit?: number;
    documentIds?: string[];
    minSimilarity?: number;
  } = {}
): Promise<ChunkWithScore[]> {
  const config = getConfig();
  const limit = options.limit ?? config.maxChunksPerQuery;
  const minSimilarity = options.minSimilarity ?? 0.5;
  const embeddingValue = `[${embedding.join(',')}]`;

  let sql = `
    SELECT *,
           1 - (embedding <=> $2::vector) as similarity
    FROM doc_chunks
    WHERE user_id = $1
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> $2::vector) >= $3
  `;

  const params: unknown[] = [userId, embeddingValue, minSimilarity];

  // Filter by specific documents if provided
  if (options.documentIds && options.documentIds.length > 0) {
    const placeholders = options.documentIds.map((_, i) => `$${i + 4}`).join(', ');
    sql += ` AND document_id IN (${placeholders})`;
    params.push(...options.documentIds);
  }

  sql += `
    ORDER BY similarity DESC
    LIMIT $${params.length + 1}
  `;
  params.push(limit);

  const result = await query<ChunkWithScoreRow>(sql, params);

  return result.rows.map((row) => ({
    chunk: mapRowToChunk(row),
    score: row.similarity,
  }));
}

/**
 * Get all chunks for a document (ordered by index)
 */
export async function findByDocumentId(
  documentId: string,
  userId: string
): Promise<DocChunk[]> {
  const result = await query<ChunkRow>(
    `SELECT * FROM doc_chunks
     WHERE document_id = $1 AND user_id = $2
     ORDER BY chunk_index`,
    [documentId, userId]
  );

  return result.rows.map(mapRowToChunk);
}

/**
 * Get chunk by ID
 */
export async function findById(
  chunkId: string,
  userId: string
): Promise<DocChunk | null> {
  const result = await query<ChunkRow>(
    `SELECT * FROM doc_chunks
     WHERE id = $1 AND user_id = $2`,
    [chunkId, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapRowToChunk(result.rows[0]!);
}

/**
 * Get multiple chunks by IDs
 */
export async function findByIds(
  chunkIds: string[],
  userId: string
): Promise<DocChunk[]> {
  if (chunkIds.length === 0) return [];

  const placeholders = chunkIds.map((_, i) => `$${i + 2}`).join(', ');
  const result = await query<ChunkRow>(
    `SELECT * FROM doc_chunks
     WHERE id IN (${placeholders}) AND user_id = $1`,
    [userId, ...chunkIds]
  );

  return result.rows.map(mapRowToChunk);
}

/**
 * Delete all chunks for a document
 * (Usually handled by FK cascade, but useful for re-chunking)
 */
export async function deleteByDocumentId(
  documentId: string,
  userId: string
): Promise<number> {
  const result = await query(
    `DELETE FROM doc_chunks
     WHERE document_id = $1 AND user_id = $2`,
    [documentId, userId]
  );

  return result.rowCount ?? 0;
}

/**
 * Count chunks for a document
 */
export async function countByDocumentId(
  documentId: string,
  userId: string
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM doc_chunks
     WHERE document_id = $1 AND user_id = $2`,
    [documentId, userId]
  );

  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Check if document has embeddings
 */
export async function hasEmbeddings(
  documentId: string,
  userId: string
): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM doc_chunks
     WHERE document_id = $1 AND user_id = $2 AND embedding IS NOT NULL`,
    [documentId, userId]
  );

  return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
}

// ===========================================
// Helpers
// ===========================================

function mapRowToChunk(row: ChunkRow): DocChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    userId: row.user_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenCount: row.token_count,
    embedding: row.embedding ? parseEmbedding(row.embedding) : null,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/**
 * Parse pgvector string representation to array
 * pgvector returns embeddings as "[0.1,0.2,...]"
 */
function parseEmbedding(embeddingStr: string): number[] {
  try {
    // Remove brackets and split
    const cleaned = embeddingStr.replace(/^\[|\]$/g, '');
    return cleaned.split(',').map((v) => parseFloat(v));
  } catch {
    return [];
  }
}

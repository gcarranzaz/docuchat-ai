/**
 * Document Repository
 * ===================
 * Data access layer for document operations.
 *
 * IMPORTANT: All queries filter by userId for tenant isolation.
 * A user can only access their own documents.
 */

import { query } from '../config/database.js';
import type { Document } from '../types/index.js';

// ===========================================
// Types
// ===========================================

interface DocumentRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  mime_type: string;
  original_filename: string | null;
  file_size_bytes: number | null;
  chunk_count: number;
  metadata: Record<string, unknown>;
  summary: string | null;
  key_topics: string[] | null;
  document_type: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateDocumentInput {
  userId: string;
  title: string;
  content: string;
  mimeType: string;
  originalFilename?: string;
  fileSizeBytes?: number;
  metadata?: Record<string, unknown>;
}

// ===========================================
// Repository Functions
// ===========================================

/**
 * Create a new document
 */
export async function create(input: CreateDocumentInput): Promise<Document> {
  const result = await query<DocumentRow>(
    `INSERT INTO documents (user_id, title, content, mime_type, original_filename, file_size_bytes, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.userId,
      input.title,
      input.content,
      input.mimeType,
      input.originalFilename || null,
      input.fileSizeBytes || null,
      JSON.stringify(input.metadata || {}),
    ]
  );

  return mapRowToDocument(result.rows[0]!);
}

/**
 * Find document by ID (with tenant isolation)
 */
export async function findById(id: string, userId: string): Promise<Document | null> {
  const result = await query<DocumentRow>(
    `SELECT * FROM documents
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapRowToDocument(result.rows[0]!);
}

/**
 * List documents for a user (with pagination)
 */
export async function findByUser(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ documents: Document[]; total: number }> {
  // Get total count
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM documents WHERE user_id = $1`,
    [userId]
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  // Get documents
  const result = await query<DocumentRow>(
    `SELECT * FROM documents
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return {
    documents: result.rows.map(mapRowToDocument),
    total,
  };
}

/**
 * Update document chunk count (after chunking)
 */
export async function updateChunkCount(id: string, userId: string, chunkCount: number): Promise<boolean> {
  const result = await query(
    `UPDATE documents
     SET chunk_count = $3, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, userId, chunkCount]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Update document summary and metadata
 */
export async function updateSummary(
  id: string,
  userId: string,
  data: {
    summary?: string;
    keyTopics?: string[];
    documentType?: string;
  }
): Promise<boolean> {
  const result = await query(
    `UPDATE documents
     SET summary = COALESCE($3, summary),
         key_topics = COALESCE($4, key_topics),
         document_type = COALESCE($5, document_type),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, userId, data.summary || null, data.keyTopics || null, data.documentType || null]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Delete document (with tenant isolation)
 * Note: Cascades to doc_chunks due to FK constraint
 */
export async function deleteById(id: string, userId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM documents
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Check if document exists and belongs to user
 */
export async function exists(id: string, userId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM documents WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get multiple documents by IDs (for chat context)
 */
export async function findByIds(ids: string[], userId: string): Promise<Document[]> {
  if (ids.length === 0) return [];

  const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
  const result = await query<DocumentRow>(
    `SELECT * FROM documents
     WHERE id IN (${placeholders}) AND user_id = $1
     ORDER BY created_at DESC`,
    [userId, ...ids]
  );

  return result.rows.map(mapRowToDocument);
}

// ===========================================
// Helpers
// ===========================================

function mapRowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
    fileSizeBytes: row.file_size_bytes,
    chunkCount: row.chunk_count,
    metadata: row.metadata,
    summary: row.summary,
    keyTopics: row.key_topics,
    documentType: row.document_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

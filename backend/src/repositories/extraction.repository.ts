/**
 * Delete all extractions for a user
 */
export async function deleteAllByUser(userId: string): Promise<void> {
  const query = `
    DELETE FROM extractions
    WHERE user_id = $1
  `;
  await pool.query(query, [userId]);
}
/**
 * Extraction Repository
 * =====================
 * Data access layer for structured data extractions.
 */

import { getPool } from '../config/database.js';
import type { Extraction, ValidationError } from '../types/index.js';

const pool = getPool();

// ===========================================
// Types
// ===========================================

export interface CreateExtractionInput {
  userId: string;
  documentId: string;
  schemaName: string;
  schemaVersion: string;
  extractedData: Record<string, unknown>;
  validationErrors: ValidationError[];
  confidenceScore: number | null;
  promptVersion: string | null;
  modelUsed: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

// ===========================================
// Repository Functions
// ===========================================

/**
 * Create a new extraction
 */
export async function create(input: CreateExtractionInput): Promise<Extraction> {
  const query = `
    INSERT INTO extractions (
      user_id,
      document_id,
      schema_name,
      schema_version,
      extracted_data,
      validation_errors,
      confidence_score,
      prompt_version,
      model_used,
      input_tokens,
      output_tokens
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `;

  const result = await pool.query(query, [
    input.userId,
    input.documentId,
    input.schemaName,
    input.schemaVersion,
    JSON.stringify(input.extractedData),
    JSON.stringify(input.validationErrors),
    input.confidenceScore,
    input.promptVersion,
    input.modelUsed,
    input.inputTokens,
    input.outputTokens,
  ]);

  return result.rows[0] as Extraction;
}

/**
 * Get extraction by ID
 */
export async function findById(
  id: string,
  userId: string
): Promise<Extraction | null> {
  const query = `
    SELECT * FROM extractions
    WHERE id = $1 AND user_id = $2
  `;

  const result = await pool.query(query, [id, userId]);

  return result.rows[0] || null;
}

/**
 * List extractions for a document
 */
export async function findByDocument(
  documentId: string,
  userId: string
): Promise<Extraction[]> {
  const query = `
    SELECT * FROM extractions
    WHERE document_id = $1 AND user_id = $2
    ORDER BY created_at DESC
  `;

  const result = await pool.query(query, [documentId, userId]);

  return result.rows as Extraction[];
}

/**
 * List all extractions for a user
 */
export async function findByUser(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ extractions: Extraction[]; total: number }> {
  const [extractionsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM extractions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) as total FROM extractions WHERE user_id = $1`,
      [userId]
    ),
  ]);

  return {
    extractions: extractionsResult.rows as Extraction[],
    total: parseInt(countResult.rows[0]?.total ?? '0'),
  };
}

/**
 * Delete an extraction
 */
export async function deleteById(
  id: string,
  userId: string
): Promise<boolean> {
  const query = `
    DELETE FROM extractions
    WHERE id = $1 AND user_id = $2
  `;

  const result = await pool.query(query, [id, userId]);

  return (result.rowCount ?? 0) > 0;
}

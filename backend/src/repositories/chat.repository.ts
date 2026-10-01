/**
 * Delete all chat sessions for a user (cascades to messages via FK)
 */
export async function deleteAllSessions(userId: string): Promise<void> {
  const query = `
    DELETE FROM chat_sessions
    WHERE user_id = $1
  `;
  await pool.query(query, [userId]);
}
/**
 * Chat Repository
 * ================
 * Data access layer for chat sessions and messages.
 *
 * Chat Structure:
 * - Session: A conversation thread (user + metadata)
 * - Messages: Individual messages within a session (user queries + assistant responses)
 *
 * Features:
 * - Create sessions with optional titles
 * - Store messages with citations and confidence
 * - Retrieve conversation history
 * - Session listing with message counts
 */

import { getPool } from '../config/database.js';
import type { ChatSession, ChatMessage } from '../types/index.js';

const pool = getPool();

// ===========================================
// Row mapping
// ===========================================
// PostgreSQL columns are snake_case and DECIMAL columns arrive as strings. Callers (services, the API
// and the frontend) work with the camelCase types in types/index.ts, so every query result goes
// through these two functions. Casting raw rows instead made fields such as createdAt and
// messageCount undefined in the API ("Invalid Date" in the History page).

interface SessionRow {
  id: string;
  user_id: string;
  title: string | null;
  document_ids: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  message_count?: number;
  last_message_at?: Date | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  user_id: string;
  role: ChatMessage['role'];
  content: string;
  citations: ChatMessage['citations'];
  confidence_score: string | number | null;
  prompt_version: string | null;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  feedback_rating?: 'up' | 'down' | null;
}

function toSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    documentIds: row.document_ids ?? [],
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    citations: row.citations ?? null,
    confidenceScore: row.confidence_score === null || row.confidence_score === undefined ? null : Number(row.confidence_score),
    promptVersion: row.prompt_version,
    modelUsed: row.model_used,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    ...(row.feedback_rating !== undefined && { feedbackRating: row.feedback_rating }),
  };
}

// ===========================================
// Types
// ===========================================

export interface CreateSessionInput {
  userId: string;
  title?: string;
}

export interface CreateMessageInput {
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Array<{
    chunkId: string;
    text: string;
    relevance: number;
  }>;
  confidence?: {
    score: number;
    level: string;
  };
  promptVersion?: string;
  /** Extra facts about the answer (grounded, cached, repaired...), stored as JSON */
  metadata?: Record<string, unknown>;
  /** Model that produced an assistant message (stored in model_used) */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Legacy: used as input_tokens when inputTokens is not given */
  tokensUsed?: number;
}

export interface SessionWithMessageCount extends ChatSession {
  messageCount: number;
  lastMessageAt: Date;
}

// ===========================================
// Session Operations
// ===========================================

/**
 * Create a new chat session
 */
export async function createSession(input: CreateSessionInput): Promise<ChatSession> {
  const query = `
    INSERT INTO chat_sessions (user_id, title)
    VALUES ($1, $2)
    RETURNING *
  `;

  const result = await pool.query(query, [input.userId, input.title || 'New Chat']);

  return toSession(result.rows[0] as SessionRow);
}

/**
 * Get session by ID (with tenant isolation)
 */
export async function findSessionById(
  sessionId: string,
  userId: string
): Promise<ChatSession | null> {
  const query = `
    SELECT * FROM chat_sessions
    WHERE id = $1 AND user_id = $2
  `;

  const result = await pool.query(query, [sessionId, userId]);

  return result.rows[0] ? toSession(result.rows[0] as SessionRow) : null;
}

/**
 * List all sessions for a user with message counts
 */
export async function findSessionsByUser(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ sessions: SessionWithMessageCount[]; total: number }> {
  // Get sessions with message counts
  const sessionsQuery = `
    SELECT
      s.*,
      COUNT(m.id)::integer as message_count,
      MAX(m.created_at) as last_message_at
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON s.id = m.session_id
    WHERE s.user_id = $1
    GROUP BY s.id
    ORDER BY COALESCE(MAX(m.created_at), s.created_at) DESC
    LIMIT $2 OFFSET $3
  `;

  // Get total count
  const countQuery = `
    SELECT COUNT(*) as total
    FROM chat_sessions
    WHERE user_id = $1
  `;

  const [sessionsResult, countResult] = await Promise.all([
    pool.query(sessionsQuery, [userId, limit, offset]),
    pool.query(countQuery, [userId]),
  ]);

  return {
    sessions: (sessionsResult.rows as SessionRow[]).map((row) => ({
      ...toSession(row),
      messageCount: row.message_count ?? 0,
      lastMessageAt: row.last_message_at ?? row.created_at,
    })),
    total: parseInt(countResult.rows[0]?.total ?? '0'),
  };
}

/**
 * Update session title
 */
export async function updateSessionTitle(
  sessionId: string,
  userId: string,
  title: string
): Promise<ChatSession | null> {
  const query = `
    UPDATE chat_sessions
    SET title = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2 AND user_id = $3
    RETURNING *
  `;

  const result = await pool.query(query, [title, sessionId, userId]);

  return result.rows[0] ? toSession(result.rows[0] as SessionRow) : null;
}

/**
 * Delete session (cascades to messages via FK)
 */
export async function deleteSession(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const query = `
    DELETE FROM chat_sessions
    WHERE id = $1 AND user_id = $2
  `;

  const result = await pool.query(query, [sessionId, userId]);

  return (result.rowCount ?? 0) > 0;
}

// ===========================================
// Message Operations
// ===========================================

/**
 * Create a new message in a session
 */
export async function createMessage(input: CreateMessageInput): Promise<ChatMessage> {
  const query = `
    INSERT INTO chat_messages (
      session_id,
      user_id,
      role,
      content,
      citations,
      confidence_score,
      prompt_version,
      model_used,
      input_tokens,
      output_tokens,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `;

  const result = await pool.query(query, [
    input.sessionId,
    input.userId,
    input.role,
    input.content,
    input.citations ? JSON.stringify(input.citations) : null,
    input.confidence ? input.confidence.score : null,
    input.promptVersion || null,
    input.model || null,
    input.inputTokens ?? input.tokensUsed ?? null,
    input.outputTokens ?? null,
    JSON.stringify(input.metadata ?? {}),
  ]);

  return toMessage(result.rows[0] as MessageRow);
}

/**
 * Get all messages for a session
 */
export async function findMessagesBySession(
  sessionId: string,
  userId: string
): Promise<ChatMessage[]> {
  // feedback_rating: the user's own thumbs up/down on an assistant answer (null if none)
  const query = `
    SELECT m.*, f.rating AS feedback_rating
    FROM chat_messages m
    LEFT JOIN message_feedback f ON f.message_id = m.id AND f.user_id = m.user_id
    WHERE m.session_id = $1 AND m.user_id = $2
    ORDER BY m.created_at ASC
  `;

  const result = await pool.query(query, [sessionId, userId]);

  return (result.rows as MessageRow[]).map(toMessage);
}

/**
 * Get message by ID
 */
export async function findMessageById(
  messageId: string,
  userId: string
): Promise<ChatMessage | null> {
  const query = `
    SELECT * FROM chat_messages
    WHERE id = $1 AND user_id = $2
  `;

  const result = await pool.query(query, [messageId, userId]);

  return result.rows[0] ? toMessage(result.rows[0] as MessageRow) : null;
}

/**
 * Get recent messages across all sessions (for analytics)
 */
export async function findRecentMessages(
  userId: string,
  limit: number = 10
): Promise<ChatMessage[]> {
  const query = `
    SELECT * FROM chat_messages
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `;

  const result = await pool.query(query, [userId, limit]);

  return (result.rows as MessageRow[]).map(toMessage);
}

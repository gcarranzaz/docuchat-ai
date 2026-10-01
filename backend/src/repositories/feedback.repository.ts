/**
 * Feedback repository
 * ===================
 * Thumbs up/down on assistant answers. Every query is scoped by user_id: a user
 * can only rate, read or clear a vote on a message in their own conversations.
 */

import { query } from '../config/database.js';

export type Rating = 'up' | 'down';

export interface Feedback {
  messageId: string;
  rating: Rating;
  reason: string | null;
  updatedAt: Date;
}

interface FeedbackRow {
  message_id: string;
  rating: Rating;
  reason: string | null;
  updated_at: Date;
}

function toFeedback(row: FeedbackRow): Feedback {
  return { messageId: row.message_id, rating: row.rating, reason: row.reason, updatedAt: row.updated_at };
}

/**
 * Create or change the user's vote on an assistant message they own.
 * Returns null when the message does not exist, is not theirs, or is not an assistant message
 * (the caller answers 404 for all three: no hint about other users' messages).
 */
export async function upsert(userId: string, messageId: string, rating: Rating, reason: string | null): Promise<Feedback | null> {
  const result = await query<FeedbackRow>(
    `INSERT INTO message_feedback (user_id, message_id, rating, reason)
     SELECT m.user_id, m.id, $3, $4
     FROM chat_messages m
     WHERE m.id = $2 AND m.user_id = $1 AND m.role = 'assistant'
     ON CONFLICT (user_id, message_id) DO UPDATE
       SET rating = EXCLUDED.rating, reason = EXCLUDED.reason, updated_at = NOW()
     RETURNING message_id, rating, reason, updated_at`,
    [userId, messageId, rating, reason]
  );
  return result.rows[0] ? toFeedback(result.rows[0]) : null;
}

/** Remove the user's vote. Returns false when there was none. */
export async function remove(userId: string, messageId: string): Promise<boolean> {
  const result = await query('DELETE FROM message_feedback WHERE user_id = $1 AND message_id = $2', [userId, messageId]);
  return (result.rowCount ?? 0) > 0;
}

export async function find(userId: string, messageId: string): Promise<Feedback | null> {
  const result = await query<FeedbackRow>(
    'SELECT message_id, rating, reason, updated_at FROM message_feedback WHERE user_id = $1 AND message_id = $2',
    [userId, messageId]
  );
  return result.rows[0] ? toFeedback(result.rows[0]) : null;
}

export interface DownvotedAnswer {
  messageId: string;
  question: string | null;
  answer: string;
  reason: string | null;
  promptVersion: string | null;
  model: string | null;
  createdAt: Date;
}

/**
 * Review queue (operator view, not exposed through the user API): the most recent
 * down-voted answers with the question that produced them, ready to become golden-set cases.
 */
export async function recentDownvotes(limit = 50): Promise<DownvotedAnswer[]> {
  const result = await query<{
    message_id: string;
    question: string | null;
    answer: string;
    reason: string | null;
    prompt_version: string | null;
    model_used: string | null;
    created_at: Date;
  }>(
    `SELECT f.message_id,
            (SELECT q.content FROM chat_messages q
              WHERE q.session_id = m.session_id AND q.role = 'user' AND q.created_at <= m.created_at
              ORDER BY q.created_at DESC LIMIT 1) AS question,
            m.content AS answer, f.reason, m.prompt_version, m.model_used, f.created_at
     FROM message_feedback f
     JOIN chat_messages m ON m.id = f.message_id
     WHERE f.rating = 'down'
     ORDER BY f.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((r) => ({
    messageId: r.message_id,
    question: r.question,
    answer: r.answer,
    reason: r.reason,
    promptVersion: r.prompt_version,
    model: r.model_used,
    createdAt: r.created_at,
  }));
}

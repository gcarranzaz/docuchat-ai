/**
 * Usage Repository
 * ================
 * Tracks AI API usage for cost monitoring and rate limiting.
 *
 * Why track usage:
 * - Cost control: Know how much you're spending
 * - Rate limiting: Enforce per-user limits
 * - Debugging: Trace issues back to specific calls
 * - Analytics: Understand usage patterns
 */

import { query } from '../config/database.js';
import { calculateCost } from '../ai/providers/llmProvider.interface.js';
import type { UsageLog } from '../types/index.js';

// ===========================================
// Types
// ===========================================

interface UsageRow {
  id: string;
  user_id: string;
  operation: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  latency_ms: number | null;
  success: boolean;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface CreateUsageInput {
  userId: string;
  operation: 'chat' | 'extract' | 'embed';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  success: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

// ===========================================
// Repository Functions
// ===========================================

/**
 * Log an AI operation
 */
export async function create(input: CreateUsageInput): Promise<UsageLog> {
  const estimatedCost = calculateCost(input.model, input.inputTokens, input.outputTokens);

  const result = await query<UsageRow>(
    `INSERT INTO usage_logs (user_id, operation, provider, model, input_tokens, output_tokens, estimated_cost_usd, latency_ms, success, error_message, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.userId,
      input.operation,
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens,
      estimatedCost,
      input.latencyMs || null,
      input.success,
      input.errorMessage || null,
      JSON.stringify(input.metadata || {}),
    ]
  );

  return mapRowToUsage(result.rows[0]!);
}

/**
 * Get usage stats for a user in a time window
 */
export async function getUserStats(
  userId: string,
  windowMs: number = 60000 // Default: last minute
): Promise<{
  totalRequests: number;
  totalTokens: number;
  estimatedCost: number;
  byOperation: Record<string, number>;
}> {
  const windowStart = new Date(Date.now() - windowMs);

  const result = await query<{
    operation: string;
    request_count: string;
    total_input: string;
    total_output: string;
    total_cost: string;
  }>(
    `SELECT
       operation,
       COUNT(*) as request_count,
       SUM(input_tokens) as total_input,
       SUM(output_tokens) as total_output,
       SUM(estimated_cost_usd) as total_cost
     FROM usage_logs
     WHERE user_id = $1 AND created_at >= $2
     GROUP BY operation`,
    [userId, windowStart]
  );

  const stats = {
    totalRequests: 0,
    totalTokens: 0,
    estimatedCost: 0,
    byOperation: {} as Record<string, number>,
  };

  for (const row of result.rows) {
    const requests = parseInt(row.request_count, 10);
    const tokens = parseInt(row.total_input, 10) + parseInt(row.total_output, 10);
    const cost = parseFloat(row.total_cost) || 0;

    stats.totalRequests += requests;
    stats.totalTokens += tokens;
    stats.estimatedCost += cost;
    stats.byOperation[row.operation] = requests;
  }

  return stats;
}

/**
 * Check if user is within rate limit
 */
export async function isWithinRateLimit(
  userId: string,
  operation: 'chat' | 'extract' | 'embed',
  maxRequests: number,
  windowMs: number
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const windowStart = new Date(Date.now() - windowMs);

  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM usage_logs
     WHERE user_id = $1 AND operation = $2 AND created_at >= $3`,
    [userId, operation, windowStart]
  );

  const current = parseInt(result.rows[0]?.count ?? '0', 10);

  return {
    allowed: current < maxRequests,
    current,
    limit: maxRequests,
  };
}

/**
 * Get recent usage history for a user
 */
export async function getRecentHistory(
  userId: string,
  limit: number = 50
): Promise<UsageLog[]> {
  const result = await query<UsageRow>(
    `SELECT * FROM usage_logs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows.map(mapRowToUsage);
}

/**
 * Get total cost for a user (lifetime or time window)
 */
export async function getTotalCost(
  userId: string,
  sinceDate?: Date
): Promise<number> {
  let sql = `SELECT SUM(estimated_cost_usd) as total FROM usage_logs WHERE user_id = $1`;
  const params: unknown[] = [userId];

  if (sinceDate) {
    sql += ` AND created_at >= $2`;
    params.push(sinceDate);
  }

  const result = await query<{ total: string | null }>(sql, params);
  return parseFloat(result.rows[0]?.total ?? '0') || 0;
}

// ===========================================
// Helpers
// ===========================================

function mapRowToUsage(row: UsageRow): UsageLog {
  return {
    id: row.id,
    userId: row.user_id,
    operation: row.operation as UsageLog['operation'],
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    latencyMs: row.latency_ms,
    success: row.success,
    errorMessage: row.error_message,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/**
 * Retention
 * =========
 * Deletes what has outlived its purpose. Runs daily in the worker (workers/maintenance.worker.ts).
 *
 * | Data                                   | Kept                                             |
 * |----------------------------------------|--------------------------------------------------|
 * | Documents, chunks, embeddings          | until the user deletes them or the account       |
 * | Conversations and messages             | until the user deletes them (or RETENTION_CONVERSATION_DAYS) |
 * | Usage log (tokens, cost per call)      | RETENTION_USAGE_DAYS      (default 90)           |
 * | Audit log                              | RETENTION_AUDIT_DAYS      (default 365)          |
 * | Daily/monthly budget counters          | RETENTION_BUDGET_DAYS     (default 400)          |
 * | Expired refresh tokens                 | one day after they expire                        |
 *
 * The audit log is append-only; only this job may remove rows, and only by opting in for
 * the length of one transaction (see migrations/006_audit_log.sql).
 */

import { getPool, query } from '../config/database.js';
import { getConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface RetentionResult {
  usageLogs: number;
  auditLog: number;
  budgets: number;
  refreshTokens: number;
  conversations: number;
}

export interface RetentionPolicy {
  usageDays: number;
  auditDays: number;
  budgetDays: number;
  conversationDays: number;
}

export function policyFromConfig(): RetentionPolicy {
  const cfg = getConfig();
  return {
    usageDays: cfg.retentionUsageDays,
    auditDays: cfg.retentionAuditDays,
    budgetDays: cfg.retentionBudgetDays,
    conversationDays: cfg.retentionConversationDays,
  };
}

export async function runRetention(policy: RetentionPolicy = policyFromConfig(), now: Date = new Date()): Promise<RetentionResult> {
  const result: RetentionResult = { usageLogs: 0, auditLog: 0, budgets: 0, refreshTokens: 0, conversations: 0 };

  if (policy.usageDays > 0) {
    const r = await query('DELETE FROM usage_logs WHERE created_at < $2::timestamptz - make_interval(days => $1)', [policy.usageDays, now]);
    result.usageLogs = r.rowCount ?? 0;
  }

  if (policy.budgetDays > 0) {
    const r = await query('DELETE FROM user_budgets WHERE updated_at < $2::timestamptz - make_interval(days => $1)', [policy.budgetDays, now]);
    result.budgets = r.rowCount ?? 0;
  }

  // Expired tokens are useless a day after they expire; no setting, no reason to keep them
  const tokens = await query("DELETE FROM refresh_tokens WHERE expires_at < $1::timestamptz - INTERVAL '1 day'", [now]);
  result.refreshTokens = tokens.rowCount ?? 0;

  if (policy.conversationDays > 0) {
    const r = await query(
      `DELETE FROM chat_sessions s
       WHERE s.created_at < $2::timestamptz - make_interval(days => $1)
         AND NOT EXISTS (
           SELECT 1 FROM chat_messages m
           WHERE m.session_id = s.id AND m.created_at >= $2::timestamptz - make_interval(days => $1)
         )`,
      [policy.conversationDays, now]
    );
    result.conversations = r.rowCount ?? 0;
  }

  if (policy.auditDays > 0) {
    // The only place allowed to delete audit rows: opt in for this transaction only
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL app.audit_purge = 'on'");
      const r = await client.query('DELETE FROM audit_log WHERE occurred_at < $2::timestamptz - make_interval(days => $1)', [policy.auditDays, now]);
      await client.query('COMMIT');
      result.auditLog = r.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  logger.info({ ...result }, 'Retention run complete');
  return result;
}

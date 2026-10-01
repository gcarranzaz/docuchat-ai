/**
 * Audit trail
 * ===========
 * One row per security-relevant event: who (opaque user id), what, on which resource,
 * with what outcome, tied to the request id of the access log and application logs.
 * Answers "which model and prompt version produced this answer, for whom, when?".
 *
 * What it never holds: question or answer text, document text, emails, passwords, tokens.
 * Metadata is limited to facts (ids, model, prompt version, token counts, codes); as a second
 * line of defence every string value is PII-redacted and truncated before it is stored.
 *
 * Failure policy: recording is best effort. If the insert fails the error is logged loudly and
 * the user's request carries on; blocking every action on the audit table would turn a logging
 * fault into an outage. (A regulated deployment may choose the opposite and fail closed.)
 */

import { createHash } from 'node:crypto';
import { query } from '../config/database.js';
import { redactPii } from '../ai/safety/pii.js';
import { currentRequestId } from '../utils/requestContext.js';
import { logger } from '../utils/logger.js';

export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.refresh'
  | 'auth.token_reuse'
  | 'auth.logout'
  | 'account.delete'
  | 'document.create'
  | 'document.delete'
  | 'chat.ask'
  | 'chat.blocked'
  | 'tool.call'
  | 'session.delete'
  | 'session.delete_all'
  | 'extraction.create'
  | 'extraction.delete'
  | 'extraction.delete_all'
  | 'feedback.set'
  | 'feedback.clear';

export interface AuditEvent {
  action: AuditAction;
  /** Who did it; null when nobody is identified (a failed login for an unknown email) */
  userId?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  resourceType?: 'user' | 'document' | 'session' | 'message' | 'extraction';
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

const MAX_STRING = 200;

/** Keep facts, drop anything that looks like content: redact personal data in strings and cap their length */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const redacted = redactPii(value).text;
    return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…` : redacted;
  }
  if (depth > 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeMetadata(item, depth + 1)]));
  }
  return value;
}

/**
 * A stable pseudonym for an email, to spot repeated attempts against one account without
 * storing the address itself. Truncated SHA-256 of the lowercased address.
 */
export function pseudonymize(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

export async function record(event: AuditEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (actor_user_id, action, outcome, resource_type, resource_id, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.userId ?? null,
        event.action,
        event.outcome ?? 'success',
        event.resourceType ?? null,
        event.resourceId ?? null,
        currentRequestId() ?? null,
        JSON.stringify(sanitizeMetadata(event.metadata ?? {})),
      ]
    );
  } catch (error) {
    // Loud, but never the user's problem
    logger.error({ err: error, action: event.action }, 'AUDIT WRITE FAILED: the event was not recorded');
  }
}

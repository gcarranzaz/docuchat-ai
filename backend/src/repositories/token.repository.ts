/**
 * Refresh Token Repository
 * ========================
 * Data access layer for refresh token operations.
 *
 * Refresh Token Rotation Strategy:
 * 1. When user logs in, create a new refresh token
 * 2. When token is used to refresh, mark it as "used" and create new one
 * 3. If a "used" token is presented again → possible token theft!
 *    Revoke all tokens for that user (force re-login)
 *
 * Security notes:
 * - Tokens are hashed before storage (SHA-256)
 * - Track used_at to detect reuse attacks
 * - Clean up expired tokens periodically
 */

import { query, withTransaction } from '../config/database.js';
import type { RefreshToken } from '../types/index.js';

// ===========================================
// Types
// ===========================================

interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface CreateTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

// ===========================================
// Repository Functions
// ===========================================

/**
 * Create a new refresh token
 */
export async function create(input: CreateTokenInput): Promise<RefreshToken> {
  const result = await query<TokenRow>(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.userId, input.tokenHash, input.expiresAt]
  );

  return mapRowToToken(result.rows[0]!);
}

/**
 * Find a valid (not used, not revoked, not expired) token by hash
 */
export async function findValidByHash(tokenHash: string): Promise<RefreshToken | null> {
  const result = await query<TokenRow>(
    `SELECT * FROM refresh_tokens
     WHERE token_hash = $1
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > NOW()`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapRowToToken(result.rows[0]!);
}

/**
 * Check if token exists (even if used/revoked)
 * Used to detect token reuse attacks
 */
export async function findByHash(tokenHash: string): Promise<RefreshToken | null> {
  const result = await query<TokenRow>(
    `SELECT * FROM refresh_tokens
     WHERE token_hash = $1`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapRowToToken(result.rows[0]!);
}

/**
 * Mark token as used (for rotation)
 * Returns true if token was successfully marked
 */
export async function markAsUsed(tokenId: string): Promise<boolean> {
  const result = await query(
    `UPDATE refresh_tokens
     SET used_at = NOW()
     WHERE id = $1
       AND used_at IS NULL
       AND revoked_at IS NULL`,
    [tokenId]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke a specific token
 */
export async function revoke(tokenId: string): Promise<boolean> {
  const result = await query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE id = $1
       AND revoked_at IS NULL`,
    [tokenId]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke ALL tokens for a user
 * Used when token reuse is detected (security breach)
 */
export async function revokeAllForUser(userId: string): Promise<number> {
  const result = await query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE user_id = $1
       AND revoked_at IS NULL`,
    [userId]
  );

  return result.rowCount ?? 0;
}

/**
 * Rotate token: mark old as used, create new one
 * Atomic operation using transaction
 */
export async function rotateToken(
  oldTokenId: string,
  newTokenInput: CreateTokenInput
): Promise<RefreshToken | null> {
  return withTransaction(async (client) => {
    // Mark old token as used
    const markResult = await client.query(
      `UPDATE refresh_tokens
       SET used_at = NOW()
       WHERE id = $1
         AND used_at IS NULL
         AND revoked_at IS NULL
       RETURNING id`,
      [oldTokenId]
    );

    if ((markResult.rowCount ?? 0) === 0) {
      // Token was already used or revoked
      return null;
    }

    // Create new token
    const createResult = await client.query<TokenRow>(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [newTokenInput.userId, newTokenInput.tokenHash, newTokenInput.expiresAt]
    );

    return mapRowToToken(createResult.rows[0]!);
  });
}

/**
 * Clean up expired tokens (maintenance)
 * Run this periodically (e.g., daily cron job)
 */
export async function cleanupExpired(): Promise<number> {
  const result = await query(
    `DELETE FROM refresh_tokens
     WHERE expires_at < NOW() - INTERVAL '1 day'`
  );

  return result.rowCount ?? 0;
}

/**
 * Count active tokens for a user
 * Useful for limiting concurrent sessions
 */
export async function countActiveForUser(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM refresh_tokens
     WHERE user_id = $1
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > NOW()`,
    [userId]
  );

  return parseInt(result.rows[0]?.count ?? '0', 10);
}

// ===========================================
// Helpers
// ===========================================

function mapRowToToken(row: TokenRow): RefreshToken {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

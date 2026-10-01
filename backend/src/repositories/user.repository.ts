/**
 * User Repository
 * ===============
 * Data access layer for user operations.
 *
 * Why repository pattern:
 * - Separates data access from business logic
 * - Easy to test (mock the repository)
 * - Single place to enforce data access rules
 * - Can swap database without changing services
 *
 * Security notes:
 * - Never return passwordHash to services that don't need it
 * - Use parameterized queries (pg handles this)
 */

import { query } from '../config/database.js';
import type { User } from '../types/index.js';

// ===========================================
// Types
// ===========================================

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

// User without password hash (safe to return)
export type SafeUser = Omit<User, 'passwordHash'>;

// ===========================================
// Repository Functions
// ===========================================

/**
 * Find user by email
 * Returns full user including password hash (for auth)
 */
export async function findByEmail(email: string): Promise<User | null> {
  const result = await query<UserRow>(
    `SELECT id, email, password_hash, created_at, updated_at
     FROM users
     WHERE email = $1`,
    [email.toLowerCase()]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapRowToUser(result.rows[0]!);
}

/**
 * Find user by ID
 * Returns user without password hash (safe)
 */
export async function findById(id: string): Promise<SafeUser | null> {
  const result = await query<UserRow>(
    `SELECT id, email, created_at, updated_at
     FROM users
     WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0]!;
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create a new user
 * Returns the created user without password hash
 */
export async function create(email: string, passwordHash: string): Promise<SafeUser> {
  const result = await query<UserRow>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, created_at, updated_at`,
    [email.toLowerCase(), passwordHash]
  );

  const row = result.rows[0]!;
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Check if email exists
 * Useful for registration validation
 */
export async function emailExists(email: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  return (result.rowCount ?? 0) > 0;
}

// ===========================================
// Helpers
// ===========================================

function mapRowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

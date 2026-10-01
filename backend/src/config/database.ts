/**
 * Database Connection Module
 * ==========================
 * Manages PostgreSQL connection pool using the 'pg' library.
 *
 * Why connection pooling:
 * - Reuses connections instead of creating new ones per request
 * - Handles connection lifecycle (connect, release, errors)
 * - Configurable pool size for scaling
 *
 * Security notes:
 * - Connection string/credentials from env vars
 * - SSL enabled in production
 * - Query parameterization handled by pg library (prevents SQL injection)
 */

import fs from 'node:fs';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getConfig, getDatabaseUrl, type Config } from './index.js';
import { logger } from '../utils/logger.js';

// ===========================================
// Pool Configuration
// ===========================================

let pool: Pool | null = null;

/**
 * TLS settings for the Postgres connection.
 * Production verifies the server certificate. RDS certificates are signed by an Amazon CA that is
 * not in Node's default trust store, so the image ships the RDS CA bundle and DB_SSL_CA_FILE
 * points at it; without that, "verify" fails closed instead of silently skipping the check.
 */
export function buildPgSsl(cfg: Pick<Config, 'nodeEnv' | 'dbSsl' | 'dbSslCaFile'>): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = cfg.dbSsl === 'auto' ? (cfg.nodeEnv === 'production' ? 'verify' : 'disable') : cfg.dbSsl;
  if (mode === 'disable') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    ...(cfg.dbSslCaFile && { ca: fs.readFileSync(cfg.dbSslCaFile, 'utf8') }),
  };
}

export function getPool(): Pool {
  if (!pool) {
    const config = getConfig();
    const connectionString = getDatabaseUrl();

    pool = new Pool({
      connectionString,
      // Pool sizing: start small, scale based on load
      max: 20, // Max connections in pool
      min: 2, // Min connections to keep alive
      idleTimeoutMillis: 30000, // Close idle connections after 30s
      connectionTimeoutMillis: 5000, // Fail fast if can't connect in 5s

      ssl: buildPgSsl(config),
    });

    // Connection event handlers
    pool.on('connect', () => {
      logger.debug('New database connection established');
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected database pool error');
    });

    pool.on('remove', () => {
      logger.debug('Database connection removed from pool');
    });
  }

  return pool;
}

// ===========================================
// Query Helpers
// ===========================================

/**
 * Execute a query using pooled connection
 * Automatically releases connection back to pool
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await getPool().query<T>(text, params);
  const duration = Date.now() - start;

  logger.debug({
    query: text.substring(0, 100),
    duration,
    rows: result.rowCount,
  }, 'Executed query');

  return result;
}

/**
 * Get a client for transaction support
 * IMPORTANT: Always release the client in a finally block!
 *
 * Usage:
 * ```
 * const client = await getClient();
 * try {
 *   await client.query('BEGIN');
 *   // ... your queries
 *   await client.query('COMMIT');
 * } catch (e) {
 *   await client.query('ROLLBACK');
 *   throw e;
 * } finally {
 *   client.release();
 * }
 * ```
 */
export async function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

/**
 * Transaction helper that handles begin/commit/rollback
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ===========================================
// Health Check
// ===========================================

export async function checkDatabaseHealth(): Promise<{
  healthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    await query('SELECT 1');
    return {
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ===========================================
// Graceful Shutdown
// ===========================================

export async function closePool(): Promise<void> {
  if (pool) {
    logger.info('Closing database connection pool...');
    await pool.end();
    pool = null;
    logger.info('Database connection pool closed');
  }
}

// No signal handlers here on purpose. This module used to close the pool on SIGTERM by itself,
// which raced with the entry point's graceful shutdown: the pool was closed while requests were
// still finishing ("Cannot use a pool after calling end on the pool"). Whoever owns the process
// (index.ts, the workers) decides the order: stop accepting work, let it finish, then closePool().

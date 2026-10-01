/**
 * Authentication Middleware
 * =========================
 * Protects routes that require authentication.
 *
 * Usage:
 *   router.get('/protected', authMiddleware, handler);
 *
 * The middleware:
 * 1. Extracts Bearer token from Authorization header
 * 2. Verifies the JWT signature and expiry
 * 3. Attaches userId to request object
 * 4. Passes to next handler or returns 401
 *
 * Security notes:
 * - Only accepts Bearer tokens
 * - Validates token signature with secret
 * - Checks token type (access vs refresh)
 * - Logs authentication failures for monitoring
 */

import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { errors } from './error.middleware.js';
import { logger } from '../utils/logger.js';

// ===========================================
// Middleware
// ===========================================

/**
 * Require valid access token
 * Adds req.userId on success
 */
export function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw errors.unauthorized('No authorization header');
    }

    // Expect "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throw errors.unauthorized('Invalid authorization format. Use: Bearer <token>');
    }

    const token = parts[1]!;

    // Verify token
    const payload = verifyAccessToken(token);

    // Attach user info to request
    req.userId = payload.userId;

    next();
  } catch (error) {
    // Log failed auth attempts (useful for security monitoring)
    logger.debug(
      {
        path: req.path,
        ip: req.ip,
        error: error instanceof Error ? error.message : 'Unknown',
      },
      'Authentication failed'
    );

    if (error instanceof Error) {
      if (error.message === 'Token expired') {
        next(errors.unauthorized('Access token expired'));
        return;
      }
      if (error.message === 'Invalid token') {
        next(errors.unauthorized('Invalid access token'));
        return;
      }
    }

    next(errors.unauthorized('Authentication failed'));
  }
}

/**
 * Optional auth: doesn't fail if no token, but attaches userId if present
 * Useful for endpoints that work with or without auth
 */
export function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      // No token is fine for optional auth
      return next();
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      // Invalid format - still proceed without auth
      return next();
    }

    const token = parts[1]!;
    const payload = verifyAccessToken(token);
    req.userId = payload.userId;

    next();
  } catch {
    // Token invalid/expired - proceed without auth
    next();
  }
}

// ===========================================
// Type Guard
// ===========================================

/**
 * Type guard to assert that userId exists on request
 * Useful after authMiddleware to get proper typing
 */
export function assertAuthenticated(
  req: Request
): asserts req is Request & { userId: string } {
  if (!req.userId) {
    throw errors.unauthorized('Not authenticated');
  }
}

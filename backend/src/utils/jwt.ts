/**
 * JWT Utility Functions
 * =====================
 * Handles token generation and verification.
 *
 * Security considerations:
 * - Access tokens: Short-lived (15 min), used for API access
 * - Refresh tokens: Longer-lived (7 days), used only to get new access tokens
 * - Refresh token rotation: Old token invalidated when new one issued
 * - Tokens are signed with different secrets (defense in depth)
 */

import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { getConfig } from '../config/index.js';

// ===========================================
// Types
// ===========================================

export interface AccessTokenPayload {
  userId: string;
  email: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  userId: string;
  tokenId: string; // UUID to track in DB
  type: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenId: string; // For storing in DB
  expiresIn: number; // Access token expiry in seconds
}

// ===========================================
// Parse Duration
// ===========================================

/**
 * Parse duration string to seconds
 * Supports: '15m', '1h', '7d', '30d'
 */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 60 * 60;
    case 'd': return value * 60 * 60 * 24;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

// ===========================================
// Token Generation
// ===========================================

/**
 * Generate a pair of access and refresh tokens
 */
export function generateTokenPair(userId: string, email: string): TokenPair {
  const config = getConfig();
  const refreshTokenId = crypto.randomUUID();

  // Access token payload
  const accessPayload: AccessTokenPayload = {
    userId,
    email,
    type: 'access',
  };

  // Refresh token payload
  const refreshPayload: RefreshTokenPayload = {
    userId,
    tokenId: refreshTokenId,
    type: 'refresh',
  };

  const accessExpiresIn = parseDuration(config.jwtExpiresIn);
  const refreshExpiresIn = parseDuration(config.jwtRefreshExpiresIn);

  const accessOptions: SignOptions = {
    expiresIn: accessExpiresIn,
    algorithm: 'HS256',
  };

  const refreshOptions: SignOptions = {
    expiresIn: refreshExpiresIn,
    algorithm: 'HS256',
  };

  const accessToken = jwt.sign(accessPayload, config.jwtSecret, accessOptions);
  const refreshToken = jwt.sign(refreshPayload, config.jwtRefreshSecret, refreshOptions);

  return {
    accessToken,
    refreshToken,
    refreshTokenId,
    expiresIn: accessExpiresIn,
  };
}

// ===========================================
// Token Verification
// ===========================================

/**
 * Verify and decode an access token
 * Returns the payload if valid, throws if invalid
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const config = getConfig();

  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
    }) as JwtPayload & AccessTokenPayload;

    // Verify token type
    if (payload.type !== 'access') {
      throw new Error('Invalid token type');
    }

    return {
      userId: payload.userId,
      email: payload.email,
      type: 'access',
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Token expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token');
    }
    throw error;
  }
}

/**
 * Verify and decode a refresh token
 * Returns the payload if valid, throws if invalid
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const config = getConfig();

  try {
    const payload = jwt.verify(token, config.jwtRefreshSecret, {
      algorithms: ['HS256'],
    }) as JwtPayload & RefreshTokenPayload;

    // Verify token type
    if (payload.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    return {
      userId: payload.userId,
      tokenId: payload.tokenId,
      type: 'refresh',
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Refresh token expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid refresh token');
    }
    throw error;
  }
}

// ===========================================
// Token Hashing (for DB storage)
// ===========================================

/**
 * Hash a token for secure storage in database
 * We don't store raw tokens - if DB is compromised, tokens are useless
 */
export function hashToken(token: string): string {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}

/**
 * Calculate expiry date for refresh token
 */
export function getRefreshTokenExpiry(): Date {
  const config = getConfig();
  const expiresInSeconds = parseDuration(config.jwtRefreshExpiresIn);
  return new Date(Date.now() + expiresInSeconds * 1000);
}

/**
 * Authentication Service
 * ======================
 * Business logic for user authentication.
 *
 * Implements:
 * - User registration with password hashing
 * - Login with credential verification
 * - Refresh token rotation
 * - Token reuse detection (security)
 *
 * Security notes:
 * - Passwords hashed with bcrypt (cost factor 12)
 * - Generic error messages to prevent user enumeration
 * - Refresh tokens rotated on each use
 * - Token reuse triggers full session revocation
 */

import bcrypt from 'bcryptjs';
import * as userRepo from '../repositories/user.repository.js';
import * as tokenRepo from '../repositories/token.repository.js';
import {
  generateTokenPair,
  verifyRefreshToken,
  hashToken,
  getRefreshTokenExpiry,
} from '../utils/jwt.js';
import { AppError, errors } from '../middleware/error.middleware.js';
import { logger } from '../utils/logger.js';
import type { AuthResponse, TokenResponse } from '../schemas/auth.schema.js';

// ===========================================
// Constants
// ===========================================

const BCRYPT_ROUNDS = 12; // Good balance of security vs speed
const MAX_ACTIVE_SESSIONS = 5; // Limit concurrent sessions per user

// ===========================================
// Register
// ===========================================

export async function register(
  email: string,
  password: string
): Promise<AuthResponse> {
  // Check if email already exists
  const existingUser = await userRepo.emailExists(email);
  if (existingUser) {
    throw errors.conflict('Email already registered');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // Create user
  const user = await userRepo.create(email, passwordHash);

  logger.info({ userId: user.id }, 'User registered successfully');

  // Generate tokens
  const tokenPair = generateTokenPair(user.id, user.email);

  // Store refresh token (hashed)
  await tokenRepo.create({
    userId: user.id,
    tokenHash: hashToken(tokenPair.refreshToken),
    expiresAt: getRefreshTokenExpiry(),
  });

  return {
    user: {
      id: user.id,
      email: user.email,
    },
    tokens: {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
    },
  };
}

// ===========================================
// Login
// ===========================================

export async function login(
  email: string,
  password: string
): Promise<AuthResponse> {
  // Find user by email
  const user = await userRepo.findByEmail(email);

  // Use constant-time comparison even if user doesn't exist
  // This prevents timing attacks for user enumeration
  if (!user) {
    // Hash a dummy password to maintain constant time
    await bcrypt.hash('dummy_password', BCRYPT_ROUNDS);
    throw errors.unauthorized('Invalid email or password');
  }

  // Verify password
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    throw errors.unauthorized('Invalid email or password');
  }

  // Check session limit (optional: revoke oldest if exceeded)
  const activeCount = await tokenRepo.countActiveForUser(user.id);
  if (activeCount >= MAX_ACTIVE_SESSIONS) {
    logger.warn({ userId: user.id, activeCount }, 'Max sessions reached');
    // Could revoke oldest here, but for MVP just warn
  }

  // Generate tokens
  const tokenPair = generateTokenPair(user.id, user.email);

  // Store refresh token (hashed)
  await tokenRepo.create({
    userId: user.id,
    tokenHash: hashToken(tokenPair.refreshToken),
    expiresAt: getRefreshTokenExpiry(),
  });

  logger.info({ userId: user.id }, 'User logged in successfully');

  return {
    user: {
      id: user.id,
      email: user.email,
    },
    tokens: {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
    },
  };
}

// ===========================================
// Refresh Token
// ===========================================

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  // Verify the JWT signature and extract payload
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (error) {
    throw errors.unauthorized(
      error instanceof Error ? error.message : 'Invalid refresh token'
    );
  }

  const tokenHash = hashToken(refreshToken);

  // Check if token exists in database
  const storedToken = await tokenRepo.findByHash(tokenHash);

  if (!storedToken) {
    throw errors.unauthorized('Refresh token not found');
  }

  // Check if token was already used (SECURITY: possible token theft!)
  if (storedToken.usedAt) {
    logger.error(
      { userId: payload.userId, tokenId: storedToken.id },
      'Refresh token reuse detected! Possible token theft.'
    );

    // Revoke ALL tokens for this user (force re-login)
    const revokedCount = await tokenRepo.revokeAllForUser(payload.userId);
    logger.warn(
      { userId: payload.userId, revokedCount },
      'All refresh tokens revoked due to reuse detection'
    );

    throw new AppError(
      'Session compromised. Please login again.',
      401,
      'TOKEN_REUSE_DETECTED'
    );
  }

  // Check if token is revoked
  if (storedToken.revokedAt) {
    throw errors.unauthorized('Refresh token has been revoked');
  }

  // Check if token is expired (DB check, in addition to JWT expiry)
  if (storedToken.expiresAt < new Date()) {
    throw errors.unauthorized('Refresh token has expired');
  }

  // Get user info for new tokens
  const user = await userRepo.findById(payload.userId);
  if (!user) {
    throw errors.unauthorized('User not found');
  }

  // Generate new token pair
  const newTokenPair = generateTokenPair(user.id, user.email);

  // Rotate: mark old token as used, create new one (atomic)
  const newStoredToken = await tokenRepo.rotateToken(storedToken.id, {
    userId: user.id,
    tokenHash: hashToken(newTokenPair.refreshToken),
    expiresAt: getRefreshTokenExpiry(),
  });

  if (!newStoredToken) {
    // Race condition: token was already used/revoked during this request
    throw errors.unauthorized('Token rotation failed');
  }

  logger.debug({ userId: user.id }, 'Tokens refreshed successfully');

  return {
    accessToken: newTokenPair.accessToken,
    refreshToken: newTokenPair.refreshToken,
    expiresIn: newTokenPair.expiresIn,
  };
}

// ===========================================
// Logout (optional: revoke specific token)
// ===========================================

export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);
  const storedToken = await tokenRepo.findByHash(tokenHash);

  if (storedToken) {
    await tokenRepo.revoke(storedToken.id);
    logger.debug({ tokenId: storedToken.id }, 'Token revoked on logout');
  }
}

// ===========================================
// Revoke All Sessions (for security page, password change, etc.)
// ===========================================

export async function revokeAllSessions(userId: string): Promise<number> {
  const revokedCount = await tokenRepo.revokeAllForUser(userId);
  logger.info({ userId, revokedCount }, 'All sessions revoked');
  return revokedCount;
}

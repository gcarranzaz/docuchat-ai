/**
 * Rate Limiting Middleware
 * ========================
 * Protects endpoints from abuse and API cost overruns
 *
 * Strategy:
 * - General API limit: 20 req/min (adjustable)
 * - Chat endpoint: 10 req/min (LLM calls are expensive)
 * - Extraction endpoint: 5 req/min (LLM calls + processing intensive)
 * - Per-user limits (not IP-based for authenticated endpoints)
 *
 * Production considerations:
 * - Use Redis for distributed rate limiting (multiple server instances)
 * - Implement sliding window for smoother limit enforcement
 * - Add burst allowance for legitimate spikes
 * - Different limits for different user tiers (free vs paid)
 */

import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type { Request, Response } from 'express';

// ===========================================
// Rate Limit Configuration
// ===========================================

const rateLimitConfig = config.rateLimit;

/**
 * Custom key generator: rate limit by user ID for authenticated endpoints
 */
function keyGenerator(req: Request): string {
  // If authenticated, use userId
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }

  // Otherwise use IP address
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Custom handler when rate limit is exceeded
 */
function handler(req: Request, res: Response): void {
  const identifier = keyGenerator(req);

  logger.warn(
    {
      identifier,
      path: req.path,
      method: req.method,
    },
    'Rate limit exceeded'
  );

  res.status(429).json({
    error: 'Too Many Requests',
    message: 'You have exceeded the rate limit. Please try again later.',
    retryAfter: res.getHeader('Retry-After'),
  });
}

/**
 * Skip rate limiting in test environment
 */
function skip(req: Request): boolean {
  return config.server.nodeEnv === 'test';
}

// ===========================================
// Rate Limiters
// ===========================================

/**
 * General API rate limiter
 * Applied to most endpoints
 */
export const generalLimiter = rateLimit({
  windowMs: rateLimitConfig.windowMs,
  max: rateLimitConfig.maxRequests,
  message: 'Too many requests from this account, please try again later.',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  keyGenerator,
  handler,
  skip,
});

/**
 * Strict rate limiter for auth endpoints
 * Prevents brute force attacks
 */
export const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute (dev-friendly)
  max: 100, // 100 requests per window (dev-friendly)
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // For auth, always use IP (no user yet)
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
  handler: (req, res) => {
    logger.warn(
      {
        ip: req.ip,
        path: req.path,
      },
      'Auth rate limit exceeded - possible brute force attack'
    );

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many authentication attempts. Please try again in 15 minutes.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
  skip,
});

/**
 * Rate limiter for chat endpoints
 * Stricter because LLM API calls are expensive
 */
export const chatLimiter = rateLimit({
  windowMs: rateLimitConfig.windowMs,
  max: rateLimitConfig.chatMax,
  message: 'Too many chat requests. Please wait before sending more messages.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: (req, res) => {
    logger.warn(
      {
        userId: req.user?.id,
        path: req.path,
      },
      'Chat rate limit exceeded'
    );

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'You are sending messages too quickly. Please wait a moment before trying again.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
  skip,
});

/**
 * Rate limiter for extraction endpoints
 * Very strict because extraction is processing-intensive
 */
export const extractLimiter = rateLimit({
  windowMs: rateLimitConfig.windowMs,
  max: rateLimitConfig.extractMax,
  message: 'Too many extraction requests. Please wait before submitting more.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: (req, res) => {
    logger.warn(
      {
        userId: req.user?.id,
        path: req.path,
      },
      'Extraction rate limit exceeded'
    );

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'You are submitting extraction requests too quickly. Please wait before trying again.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
  skip,
});

/**
 * Rate limiter for document uploads
 * Moderate limit to prevent storage abuse
 */
export const uploadLimiter = rateLimit({
  windowMs: rateLimitConfig.windowMs,
  max: 10, // 10 uploads per minute
  message: 'Too many uploads. Please wait before uploading more documents.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: (req, res) => {
    logger.warn(
      {
        userId: req.user?.id,
        path: req.path,
      },
      'Upload rate limit exceeded'
    );

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'You are uploading documents too quickly. Please wait before uploading more.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
  skip,
});

// ===========================================
// Helper: Create Custom Rate Limiter
// ===========================================

export function createRateLimiter(options: {
  windowMs?: number;
  max: number;
  message?: string;
}) {
  return rateLimit({
    windowMs: options.windowMs || rateLimitConfig.windowMs,
    max: options.max,
    message: options.message || 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler,
    skip,
  });
}

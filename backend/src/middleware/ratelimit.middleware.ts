/**
 * Rate Limiting Middleware
 * ========================
 * Protects endpoints from abuse and runaway AI cost.
 *
 * - Counters live in Redis, so the limits hold across several API tasks. In-memory
 *   counters would give each task its own allowance (N tasks = N times the limit).
 * - Authenticated requests are limited per user; anonymous ones (login, register)
 *   per IP. Behind a load balancer set TRUST_PROXY, or every client shares one IP.
 * - If Redis is unavailable the limiter fails OPEN (the request is served and the
 *   error is logged): losing rate limiting briefly is better than taking the API
 *   down. The per-user budget (budget.service.ts) is the hard spend cap and lives
 *   in Postgres, so cost stays bounded in that case.
 * - Disable everything with RATE_LIMIT_ENABLED=false (local tests).
 *
 * Layers: this file limits request RATE; budget.service.ts limits SPEND.
 */

import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { RedisRateLimitStore } from './redisRateLimitStore.js';
import { logger } from '../utils/logger.js';

const settings = config.rateLimit;

function userOrIp(req: Request): string {
  if (req.userId) return `user:${req.userId}`;
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function ipOnly(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function tooMany(message: string) {
  return (req: Request, res: Response): void => {
    logger.warn({ identifier: userOrIp(req), path: req.path, method: req.method }, 'Rate limit exceeded');
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message,
        retryAfter: res.getHeader('Retry-After'),
      },
    });
  };
}

interface LimiterSpec {
  name: string;
  windowMs: number;
  max: number;
  message: string;
  key?: (req: Request) => string;
}

function makeLimiter(spec: LimiterSpec) {
  const options: Partial<Options> = {
    windowMs: spec.windowMs,
    limit: spec.max,
    standardHeaders: true, // RateLimit-* and Retry-After
    legacyHeaders: false,
    keyGenerator: spec.key ?? userOrIp,
    handler: tooMany(spec.message),
    skip: () => !settings.enabled,
    passOnStoreError: true, // fail open, see the note at the top
    store: new RedisRateLimitStore(`rl:${spec.name}:`),
  };
  return rateLimit(options);
}

// ===========================================
// Rate Limiters
// ===========================================

/** General API limiter, applied to most endpoints */
export const generalLimiter = makeLimiter({
  name: 'general',
  windowMs: settings.windowMs,
  max: settings.maxRequests,
  message: 'Too many requests. Please try again later.',
});

/** Strict limiter for login/register: slows password guessing. Always per IP (no user yet). */
export const authLimiter = makeLimiter({
  name: 'auth',
  windowMs: settings.authWindowMs,
  max: settings.authMax,
  message: 'Too many authentication attempts. Please try again later.',
  key: ipOnly,
});

/** Chat: every request can cost an LLM call */
export const chatLimiter = makeLimiter({
  name: 'chat',
  windowMs: settings.windowMs,
  max: settings.chatMax,
  message: 'You are sending messages too quickly. Please wait a moment before trying again.',
});

/** Extraction: LLM call over a whole document */
export const extractLimiter = makeLimiter({
  name: 'extract',
  windowMs: settings.windowMs,
  max: settings.extractMax,
  message: 'You are submitting extraction requests too quickly. Please wait before trying again.',
});

/** Uploads: storage and embedding cost */
export const uploadLimiter = makeLimiter({
  name: 'upload',
  windowMs: settings.windowMs,
  max: settings.uploadMax,
  message: 'You are uploading documents too quickly. Please wait before uploading more.',
});

/** Build a custom limiter (distinct `name` per limiter: it is the Redis key prefix) */
export function createRateLimiter(options: { name: string; windowMs?: number; max: number; message?: string }) {
  return makeLimiter({
    name: options.name,
    windowMs: options.windowMs ?? settings.windowMs,
    max: options.max,
    message: options.message ?? 'Too many requests, please try again later.',
  });
}

/**
 * Error Handling Middleware
 * =========================
 * Centralizes error handling across all routes.
 *
 * Why centralized error handling:
 * - Consistent error response format
 * - Single place to add logging, monitoring, etc.
 * - Prevents leaking internal details in production
 * - Handles both expected (AppError) and unexpected errors
 */

import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';

// ===========================================
// Custom Application Error
// ===========================================

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    // Maintains proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }
}

// Common error factories
export const errors = {
  badRequest: (message: string, code = 'BAD_REQUEST') =>
    new AppError(message, 400, code),

  unauthorized: (message = 'Authentication required') =>
    new AppError(message, 401, 'UNAUTHORIZED'),

  forbidden: (message = 'Access denied') =>
    new AppError(message, 403, 'FORBIDDEN'),

  notFound: (resource = 'Resource') =>
    new AppError(`${resource} not found`, 404, 'NOT_FOUND'),

  conflict: (message: string) =>
    new AppError(message, 409, 'CONFLICT'),

  tooManyRequests: (message = 'Rate limit exceeded') =>
    new AppError(message, 429, 'RATE_LIMIT_EXCEEDED'),

  internal: (message = 'Internal server error') =>
    new AppError(message, 500, 'INTERNAL_ERROR', false),
};

// ===========================================
// Error Response Format
// ===========================================

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

// ===========================================
// Error Handler Middleware
// ===========================================

export const errorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const config = getConfig();
  const isDev = config.nodeEnv === 'development';

  // Generate request ID if not present
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();

  // Log the error
  logger.error({
    err: {
      name: err.name,
      message: err.message,
      stack: err.stack,
    },
    requestId,
    path: req.path,
    method: req.method,
    userId: req.userId,
  }, 'Request error');

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const response: ErrorResponse = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
        requestId,
      },
    };
    res.status(400).json(response);
    return;
  }

  // Handle known application errors
  if (err instanceof AppError) {
    const response: ErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        requestId,
      },
    };

    // Include stack trace in development
    if (isDev) {
      response.error.details = { stack: err.stack };
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // Handle unknown errors (don't leak details in production)
  const response: ErrorResponse = {
    error: {
      code: 'INTERNAL_ERROR',
      message: isDev ? err.message : 'An unexpected error occurred',
      requestId,
    },
  };

  if (isDev) {
    response.error.details = {
      name: err.name,
      stack: err.stack,
    };
  }

  res.status(500).json(response);
};

// ===========================================
// 404 Handler (for unmatched routes)
// ===========================================

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(errors.notFound(`Route ${req.method} ${req.path}`));
};

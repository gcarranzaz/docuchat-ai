/**
 * Logger Configuration
 * ====================
 * Uses Pino for structured JSON logging (production) with pretty output in dev.
 *
 * Why Pino:
 * - Fastest JSON logger for Node.js
 * - Structured logging for easy parsing in log aggregators
 * - Pretty printing in development
 * - Low overhead in production
 *
 * Log levels (in order):
 * - fatal: App is about to crash
 * - error: Something failed
 * - warn: Something unexpected but recoverable
 * - info: Normal operations (default in prod)
 * - debug: Detailed debug info
 * - trace: Very verbose tracing
 *
 * SECURITY NOTE:
 * - Never log sensitive data (passwords, tokens, PII)
 * - Log user IDs, not emails/names
 * - Redact request bodies in production
 */

import { pino } from 'pino';

// Determine environment
const isDevelopment = process.env['NODE_ENV'] !== 'production';
const logLevel = process.env['LOG_LEVEL'] || (isDevelopment ? 'debug' : 'info');

// Create logger with appropriate transport
export const logger = pino({
  level: logLevel,

  // In development, use pretty printing
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,

  // Base context for all logs
  base: {
    service: 'docuchat-backend',
    env: process.env['NODE_ENV'] || 'development',
  },

  // Redact sensitive fields
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      'token',
      'refreshToken',
      'apiKey',
    ],
    censor: '[REDACTED]',
  },
});

// ===========================================
// Typed Logger Helpers
// ===========================================

/**
 * Create a child logger with additional context
 * Useful for adding request-specific context
 */
export function createRequestLogger(requestId: string, userId?: string) {
  return logger.child({
    requestId,
    ...(userId && { userId }),
  });
}

/**
 * Log an error with stack trace
 */
export function logError(error: Error, context?: Record<string, unknown>): void {
  logger.error({
    err: {
      message: error.message,
      name: error.name,
      stack: error.stack,
    },
    ...context,
  }, error.message);
}

/**
 * Log AI operation with relevant context
 * Useful for debugging and cost tracking
 */
export function logAiOperation(params: {
  operation: 'chat' | 'extract' | 'embed';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  userId: string;
  success: boolean;
  error?: string;
}): void {
  const logData = {
    aiOperation: params.operation,
    provider: params.provider,
    model: params.model,
    tokens: {
      input: params.inputTokens,
      output: params.outputTokens,
      total: params.inputTokens + params.outputTokens,
    },
    latencyMs: params.latencyMs,
    userId: params.userId,
    success: params.success,
    ...(params.error && { error: params.error }),
  };
  const message = `AI ${params.operation} ${params.success ? 'completed' : 'failed'}`;

  if (params.success) {
    logger.info(logData, message);
  } else {
    logger.error(logData, message);
  }
}

export default logger;

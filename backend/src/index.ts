/**
 * DocuChat Backend - Entry Point
 * ==============================
 * Starts the HTTP server. The app itself is built in app.ts.
 *
 * Startup order matters: configuration problems (AI providers, prompt versions)
 * must stop the process before it touches any dependency or serves a request.
 */

import type { Server } from 'node:http';
import { getConfig } from './config/index.js';
import { getPool, closePool } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { initProviders } from './ai/providers/providerFactory.js';
import { assertPromptConfig } from './ai/prompts/registry.js';
import { createApp } from './app.js';

const config = getConfig();
const app = createApp();
let server: Server | undefined;
let shuttingDown = false;

// ===========================================
// Server Startup
// ===========================================

async function startServer() {
  try {
    // Build LLM providers first: in production a missing API key must stop the
    // server at startup, before it touches any dependency or serves a request
    initProviders();
    // ...and refuse a PROMPT_VERSION_* that does not exist (answers store the exact version)
    assertPromptConfig(config);

    // Initialize database connection pool
    logger.info('Initializing database connection pool...');
    getPool();

    // Connect to Redis
    logger.info('Connecting to Redis...');
    await connectRedis();

    // Start listening
    const port = config.port;
    server = app.listen(port, () => {
      logger.info({
        port,
        env: config.nodeEnv,
        aiProvider: config.aiProvider,
      }, `DocuChat backend started on port ${port}`);
    });

  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

// ===========================================
// Graceful Shutdown
// ===========================================

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, graceMs: config.shutdownGraceMs }, 'Shutting down: no new connections, letting in-flight requests finish');

  // A deploy must not cut a streamed answer in half. After the grace period we stop waiting.
  setTimeout(() => {
    logger.warn('Grace period over; exiting with requests still open');
    process.exit(1);
  }, config.shutdownGraceMs).unref();

  if (server) {
    const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
    server.closeIdleConnections(); // keep-alive sockets with nothing in flight would hold close() open
    await closed;
  }

  await disconnectRedis();
  await closePool();

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Promise Rejection');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught Exception');
  process.exit(1);
});

// Start the server
startServer();

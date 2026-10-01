/**
 * DocuChat Backend - Entry Point
 * ==============================
 * Express server setup with middleware pipeline and routes.
 *
 * Middleware order matters:
 * 1. Security headers (helmet)
 * 2. CORS
 * 3. Body parsing
 * 4. Request logging
 * 5. Routes
 * 6. 404 handler
 * 7. Error handler (must be last)
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';

import { getConfig } from './config/index.js';
import { getPool, closePool } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import documentsRoutes from './routes/documents.routes.js';
import chatRoutes from './routes/chat.routes.js';
import extractionsRoutes from './routes/extractions.routes.js';
import jobsRoutes from './routes/jobs.routes.js';

// ===========================================
// Create Express App
// ===========================================

const app = express();

// ===========================================
// Security Middleware
// ===========================================

// Helmet: Sets various HTTP headers for security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
    },
  },
}));

// CORS: Allow frontend origin
const config = getConfig();
app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ===========================================
// Body Parsing
// ===========================================

// JSON bodies (limit size to prevent abuse)
app.use(express.json({ limit: '10mb' }));

// URL-encoded bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===========================================
// Request Logging & ID
// ===========================================

app.use((req: Request, res: Response, next: NextFunction) => {
  // Generate or use existing request ID
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.headers['x-request-id'] = requestId;
  res.setHeader('x-request-id', requestId);

  // Log request start
  const start = Date.now();

  // Log request completion
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      requestId,
      userId: req.userId,
    }, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });

  next();
});

// ===========================================
// Routes
// ===========================================

// Health check (no auth required)
app.use('/health', healthRoutes);

// Authentication routes
app.use('/auth', authRoutes);
// Also accept requests that include a '/api' prefix (frontend/dev proxies or envs)
app.use('/api/auth', authRoutes);

// Document routes
app.use('/documents', documentsRoutes);
app.use('/api/documents', documentsRoutes);

// Chat routes
app.use('/chat', chatRoutes);
app.use('/api/chat', chatRoutes);

// Extraction routes
app.use('/extractions', extractionsRoutes);
app.use('/api/extractions', extractionsRoutes);

// Job status routes
app.use('/jobs', jobsRoutes);
app.use('/api/jobs', jobsRoutes);

// ===========================================
// Error Handling (must be last)
// ===========================================

app.use(notFoundHandler);
app.use(errorHandler);

// ===========================================
// Server Startup
// ===========================================

async function startServer() {
  try {
    // Initialize database connection pool
    logger.info('Initializing database connection pool...');
    getPool();

    // Connect to Redis
    logger.info('Connecting to Redis...');
    await connectRedis();

    // Start listening
    const port = config.port;
    app.listen(port, () => {
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
  logger.info({ signal }, 'Received shutdown signal, closing connections...');

  // Close Redis connection
  await disconnectRedis();

  // Close database pool
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

export default app;

/**
 * Express app factory
 * ===================
 * Builds the HTTP app without starting a server or touching process-level
 * handlers, so integration tests can mount it with supertest.
 * Startup (providers, database, Redis, listen, shutdown) lives in index.ts.
 */

// Must come before any router is used: makes Express 4 forward rejected promises from
// async route handlers to the error middleware. Without it an `async` handler that
// throws never answers, and the request hangs until the client gives up.
import 'express-async-errors';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';

import { getConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { requestContext } from './utils/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import documentsRoutes from './routes/documents.routes.js';
import chatRoutes from './routes/chat.routes.js';
import extractionsRoutes from './routes/extractions.routes.js';
import jobsRoutes from './routes/jobs.routes.js';

export function createApp(): express.Express {
  const app = express();
  const config = getConfig();

  // Behind a load balancer the client IP comes from X-Forwarded-For; trusting it blindly
  // would let anyone spoof their IP, so only the configured number of hops is trusted
  app.set('trust proxy', config.trustProxy);

  // Security headers
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

  // CORS: allow the frontend origin only
  app.use(cors({
    origin: config.frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // Body parsing (size-limited to prevent abuse)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Request ID and access log
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string) || uuidv4();
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);

    const start = Date.now();
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

    // Everything this request does (logs, audit rows) can now find its request id
    requestContext.run({ requestId }, next);
  });

  // Routes (both with and without the /api prefix, for dev proxies)
  app.use('/health', healthRoutes);
  app.use('/auth', authRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/documents', documentsRoutes);
  app.use('/api/documents', documentsRoutes);
  app.use('/chat', chatRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/extractions', extractionsRoutes);
  app.use('/api/extractions', extractionsRoutes);
  app.use('/jobs', jobsRoutes);
  app.use('/api/jobs', jobsRoutes);

  // Error handling (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Health Check Routes
 * ===================
 * Provides endpoints for monitoring and load balancer health checks.
 *
 * Endpoints:
 * - GET /health: Basic health check (fast, for load balancers)
 * - GET /health/ready: Readiness check (includes DB connectivity)
 *
 * Why separate endpoints:
 * - /health: Always fast, just confirms process is running
 * - /health/ready: Checks dependencies, use for readiness probes
 *
 * Load balancer pattern:
 * - Health checks should be < 5s response time
 * - Return 200 for healthy, 503 for unhealthy
 */

import { Router, Request, Response } from 'express';
import { checkDatabaseHealth } from '../config/database.js';
import { getConfig } from '../config/index.js';

const router = Router();

// ===========================================
// GET /health - Basic liveness check
// ===========================================
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'docuchat-backend',
  });
});

// ===========================================
// GET /health/ready - Readiness check with dependencies
// ===========================================
router.get('/ready', async (_req: Request, res: Response) => {
  const config = getConfig();
  const dbHealth = await checkDatabaseHealth();

  const isReady = dbHealth.healthy;

  const response = {
    status: isReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    service: 'docuchat-backend',
    version: process.env['npm_package_version'] || '1.0.0',
    environment: config.nodeEnv,
    checks: {
      database: {
        status: dbHealth.healthy ? 'healthy' : 'unhealthy',
        latencyMs: dbHealth.latencyMs,
        ...(dbHealth.error && { error: dbHealth.error }),
      },
    },
  };

  res.status(isReady ? 200 : 503).json(response);
});

export default router;

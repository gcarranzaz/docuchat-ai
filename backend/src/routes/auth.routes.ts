/**
 * Authentication Routes
 * =====================
 * Handles user registration, login, and token refresh.
 *
 * Endpoints:
 * - POST /auth/register - Create new account
 * - POST /auth/login - Get access + refresh tokens
 * - POST /auth/refresh - Rotate refresh token
 * - POST /auth/logout - Revoke refresh token (optional)
 *
 * Security:
 * - All endpoints validate input with Zod
 * - Passwords never logged or returned
 * - Rate limiting on auth endpoints (see authLimiter below)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { authLimiter } from '../middleware/ratelimit.middleware.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  type RegisterInput,
  type LoginInput,
  type RefreshInput,
  deleteAccountSchema,
  type DeleteAccountInput,
} from '../schemas/auth.schema.js';
import * as authService from '../services/auth.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Apply auth rate limiter to all auth routes
router.use(authLimiter);

// ===========================================
// POST /auth/register
// ===========================================
router.post(
  '/register',
  validate(registerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as RegisterInput;

      const result = await authService.register(email, password);

      res.status(201).json({
        message: 'Registration successful',
        user: result.user,
        tokens: result.tokens,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ===========================================
// POST /auth/login
// ===========================================
router.post(
  '/login',
  validate(loginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as LoginInput;

      const result = await authService.login(email, password);

      res.json({
        message: 'Login successful',
        user: result.user,
        tokens: result.tokens,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ===========================================
// POST /auth/refresh
// ===========================================
router.post(
  '/refresh',
  validate(refreshSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body as RefreshInput;

      const tokens = await authService.refreshTokens(refreshToken);

      res.json({
        message: 'Tokens refreshed',
        tokens,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ===========================================
// POST /auth/logout (optional)
// ===========================================
router.post(
  '/logout',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body as { refreshToken?: string };

      if (refreshToken) {
        await authService.logout(refreshToken);
      }

      res.json({
        message: 'Logged out successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

// ===========================================
// GET /auth/me - Get current user (requires auth)
// ===========================================
import { authMiddleware } from '../middleware/auth.middleware.js';
import * as userRepo from '../repositories/user.repository.js';

router.get(
  '/me',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await userRepo.findById(req.userId!);

      if (!user) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'User not found' },
        });
        return;
      }

      res.json({
        user: {
          id: user.id,
          email: user.email,
          createdAt: user.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ===========================================
// DELETE /auth/me - Delete the account and all its data (requires auth + password)
// ===========================================
router.delete(
  '/me',
  authMiddleware,
  validate(deleteAccountSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { password } = req.body as DeleteAccountInput;
      await authService.deleteAccount(req.userId!, password);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }
);

export default router;

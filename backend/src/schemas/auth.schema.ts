/**
 * Auth Validation Schemas
 * =======================
 * Zod schemas for validating authentication requests.
 *
 * Why Zod:
 * - Runtime validation + TypeScript inference
 * - Detailed error messages
 * - Composable schemas
 * - Works great with Express middleware
 */

import { z } from 'zod';

// ===========================================
// Shared Validations
// ===========================================

const emailSchema = z
  .string()
  .email('Invalid email format')
  .min(5, 'Email too short')
  .max(255, 'Email too long')
  .toLowerCase()
  .trim();

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password too long')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    'Password must contain at least one lowercase letter, one uppercase letter, and one number'
  );

// ===========================================
// Register Schema
// ===========================================

export const registerSchema = z.object({
  body: z.object({
    email: emailSchema,
    password: passwordSchema,
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];

// ===========================================
// Login Schema
// ===========================================

export const loginSchema = z.object({
  body: z.object({
    email: emailSchema,
    // Less strict for login - let the service handle invalid credentials
    password: z.string().min(1, 'Password is required'),
  }),
});

export type LoginInput = z.infer<typeof loginSchema>['body'];

// ===========================================
// Refresh Token Schema
// ===========================================

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
  }),
});

export type RefreshInput = z.infer<typeof refreshSchema>['body'];

// ===========================================
// Response Types (for documentation)
// ===========================================

export interface AuthResponse {
  user: {
    id: string;
    email: string;
  };
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number; // seconds
  };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

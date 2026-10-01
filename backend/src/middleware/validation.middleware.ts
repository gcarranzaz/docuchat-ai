/**
 * Validation Middleware
 * =====================
 * Generic middleware for validating requests with Zod schemas.
 *
 * Usage:
 *   import { loginSchema } from '../schemas/auth.schema';
 *   router.post('/login', validate(loginSchema), loginHandler);
 *
 * Benefits:
 * - Consistent validation across all routes
 * - Detailed error messages
 * - Type inference for handlers
 */

import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';

/**
 * Create validation middleware from a Zod schema
 *
 * The schema should define what to validate:
 * - body: Request body
 * - query: Query parameters
 * - params: URL parameters
 */
export function validate(schema: AnyZodObject) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      // Let the error middleware handle ZodError
      next(error);
    }
  };
}

/**
 * Alternative: Validate and transform
 * Replaces req.body/query/params with validated & transformed values
 */
export function validateAndTransform(schema: AnyZodObject) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const result = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      // Replace with validated values (includes transformations like .toLowerCase())
      req.body = result.body;
      req.query = result.query;
      req.params = result.params;

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Validate only body (simpler for most POST/PUT routes)
 */
export function validateBody(schema: AnyZodObject) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const result = await schema.parseAsync(req.body);
      req.body = result;
      next();
    } catch (error) {
      next(error);
    }
  };
}

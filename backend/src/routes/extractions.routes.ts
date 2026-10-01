import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as extractionService from '../services/extraction.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { extractLimiter, generalLimiter } from '../middleware/ratelimit.middleware.js';
import { errors } from '../middleware/error.middleware.js';
import { logger } from '../utils/logger.js';
import { extractionRequestSchema } from '../schemas/extraction.schema.js';

const router = Router();

/**
 * DELETE /extractions (bulk delete)
 * Delete all extractions for the authenticated user
 * Response: 204 No Content
 */
router.delete('/', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    await extractionService.deleteAllExtractions(userId);
    res.status(204).send();
  } catch (error) {
    throw error;
  }
});
/**
 * Extraction Routes
 * =================
 * API endpoints for structured data extraction from documents.
 *
 * Endpoints:
 * - POST /extractions - Extract structured data from a document
 * - GET /extractions/schemas - List available extraction schemas
 * - GET /extractions - List all extractions for user
 * - GET /extractions/:id - Get a specific extraction
 * - GET /extractions/document/:documentId - Get extractions for a document
 * - DELETE /extractions/:id - Delete an extraction
 */

// ===========================================
// Validation Schemas
// ===========================================

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ===========================================
// Extraction Routes
// ===========================================

router.post('/', authMiddleware, extractLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // Validate input
    const validation = extractionRequestSchema.safeParse(req.body);
    if (!validation.success) {
      throw validation.error;
    }

    const { documentId, schemaName } = validation.data;

    logger.info(
      { userId, documentId, schemaName },
      'Extraction request received'
    );

    // Process extraction
    const result = await extractionService.extractFromDocument(userId, {
      documentId,
      schemaName,
    });

    res.json(result);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /extractions/schemas
 * List available extraction schemas
 *
 * Response:
 * [
 *   {
 *     "name": "invoice",
 *     "version": "v1.0",
 *     "description": "Extract invoice information from documents"
 *   },
 *   {
 *     "name": "resume",
 *     "version": "v1.0",
 *     "description": "Extract candidate information from resumes"
 *   }
 * ]
 */
router.get('/schemas', authMiddleware, generalLimiter, async (_req: Request, res: Response) => {
  try {
    const schemas = extractionService.getAvailableSchemas();
    res.json(schemas);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /extractions
 * List all extractions for the authenticated user
 *
 * Query params:
 * - limit: Number of extractions to return (default: 20, max: 100)
 * - offset: Number of extractions to skip (default: 0)
 *
 * Response:
 * {
 *   "extractions": [
 *     {
 *       "id": "uuid",
 *       "documentId": "uuid",
 *       "schemaName": "invoice",
 *       "extractedData": { ... },
 *       "confidenceScore": 0.95,
 *       "createdAt": "2024-01-15T10:30:00Z"
 *     }
 *   ],
 *   "total": 42
 * }
 */
router.get('/', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // Validate query params
    const validation = paginationSchema.safeParse(req.query);
    if (!validation.success) {
      throw validation.error;
    }

    const { limit, offset } = validation.data;

    const result = await extractionService.listExtractions(
      userId,
      limit,
      offset
    );

    res.json(result);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /extractions/:id
 * Get a specific extraction by ID
 *
 * Response:
 * {
 *   "id": "uuid",
 *   "documentId": "uuid",
 *   "schemaName": "invoice",
 *   "schemaVersion": "v1.0",
 *   "extractedData": { ... },
 *   "validationErrors": [],
 *   "confidenceScore": 0.95,
 *   "createdAt": "2024-01-15T10:30:00Z"
 * }
 */
router.get('/:id', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const extractionId = req.params.id;

    if (!extractionId) {
      throw errors.badRequest('Extraction ID is required');
    }

    const result = await extractionService.getExtraction(userId, extractionId);

    res.json(result);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /extractions/document/:documentId
 * Get all extractions for a specific document
 *
 * Response:
 * [
 *   {
 *     "id": "uuid",
 *     "documentId": "uuid",
 *     "schemaName": "invoice",
 *     "extractedData": { ... },
 *     "confidenceScore": 0.95,
 *     "createdAt": "2024-01-15T10:30:00Z"
 *   }
 * ]
 */
router.get(
  '/document/:documentId',
  authMiddleware,
  generalLimiter,
  async (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const documentId = req.params.documentId;

      if (!documentId) {
        throw errors.badRequest('Document ID is required');
      }

      const result = await extractionService.listExtractionsByDocument(
        userId,
        documentId
      );

      res.json(result);
    } catch (error) {
      throw error;
    }
  }
);

/**
 * DELETE /extractions/:id
 * Delete an extraction
 *
 * Response:
 * 204 No Content
 */
router.delete('/:id', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const extractionId = req.params.id;

    if (!extractionId) {
      throw errors.badRequest('Extraction ID is required');
    }

    await extractionService.deleteExtraction(userId, extractionId);

    res.status(204).send();
  } catch (error) {
    throw error;
  }
});

export default router;

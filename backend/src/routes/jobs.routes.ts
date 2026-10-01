/**
 * Jobs Routes
 * ===========
 * API endpoints for job status monitoring
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { getDocumentJobStatus } from '../queues/embeddings.queue.js';
import { errors } from '../middleware/error.middleware.js';
import * as documentRepo from '../repositories/document.repository.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/jobs/documents/:documentId
 * Get embedding job status for a document
 */
router.get('/documents/:documentId', authMiddleware, async (req, res, next) => {
  try {
    const documentId = req.params['documentId'];
    const userId = req.userId!;

    if (!documentId) {
      throw errors.badRequest('documentId is required');
    }

    // Tenant isolation: only the owner may see a document's job status
    if (!(await documentRepo.exists(documentId, userId))) {
      throw errors.notFound('Document');
    }

    logger.debug({ userId, documentId }, 'Checking document job status');

    const status = await getDocumentJobStatus(documentId);

    res.json({
      documentId,
      jobStatus: status,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

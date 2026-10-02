/**
 * Document Routes
 * ===============
 * Handles document upload, retrieval, and management.
 *
 * Endpoints:
 * - POST /documents - Upload text or PDF
 * - GET /documents - List user's documents
 * - GET /documents/:id - Get document details
 * - DELETE /documents/:id - Delete document
 *
 * All endpoints require authentication.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, assertAuthenticated } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { uploadSingle, handleMulterError } from '../middleware/upload.middleware.js';
import { uploadLimiter, generalLimiter } from '../middleware/ratelimit.middleware.js';
import {
  uploadTextSchema,
  getDocumentSchema,
  listDocumentsSchema,
  deleteDocumentSchema,
  type UploadTextInput,
  type GetDocumentParams,
  type ListDocumentsQuery,
} from '../schemas/document.schema.js';
import * as documentService from '../services/document.service.js';
import { errors } from '../middleware/error.middleware.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Apply general rate limiter to GET/DELETE routes
router.get('/', generalLimiter);
router.get('/:id', generalLimiter);
router.delete('/:id', generalLimiter);

// Shared dispatcher middleware: decides multipart vs JSON uploads
const uploadDispatcher = (req: Request, res: Response, next: NextFunction) => {
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    uploadSingle(req, res, (err) => {
      if (err) {
        next(errors.badRequest(handleMulterError(err)));
        return;
      }
      next();
    });
  } else {
    next();
  }
};

// Shared upload handler (used for both '/' and '/upload')
const uploadHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertAuthenticated(req);
    const userId = req.userId;

    // Check if file was uploaded
    if (req.file) {
      // PDF upload
      const title = req.body.title || req.file.originalname || 'Untitled Document';

      if (req.file.mimetype !== 'application/pdf') {
        throw errors.badRequest('Only PDF files are supported for file upload');
      }

      const document = await documentService.createPdfDocument(
        userId,
        title,
        req.file.buffer,
        req.file.originalname
      );

      res.status(201).json({
        message: 'PDF document uploaded successfully',
        document: {
          id: document.id,
          title: document.title,
          mimeType: document.mimeType,
          originalFilename: document.originalFilename,
          fileSizeBytes: document.fileSizeBytes,
          contentLength: document.content.length,
          createdAt: document.createdAt,
        },
      });
    } else {
      // Text upload (validate with Zod)
      const parseResult = uploadTextSchema.safeParse({ body: req.body });
      if (!parseResult.success) {
        throw errors.badRequest(
          parseResult.error.errors.map((e) => e.message).join(', ')
        );
      }

      const { title, content } = req.body as UploadTextInput;

      const document = await documentService.createTextDocument(userId, title, content);

      res.status(201).json({
        message: 'Text document created successfully',
        document: {
          id: document.id,
          title: document.title,
          mimeType: document.mimeType,
          contentLength: document.content.length,
          createdAt: document.createdAt,
        },
      });
    }
  } catch (error) {
    next(error);
  }
};

// Register both paths so clients posting to /documents or /documents/upload work
// Apply upload rate limiter
router.post('/', uploadLimiter, uploadDispatcher, uploadHandler);
router.post('/upload', uploadLimiter, uploadDispatcher, uploadHandler);

// ===========================================
// GET /documents - List documents
// ===========================================
router.get(
  '/',
  validate(listDocumentsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertAuthenticated(req);

      const { limit, offset } = req.query as unknown as ListDocumentsQuery;
      const result = await documentService.listDocuments(req.userId, limit, offset);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// ===========================================
// GET /documents/:id - Get document details
// ===========================================
router.get(
  '/:id',
  validate(getDocumentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertAuthenticated(req);

      const { id } = req.params as unknown as GetDocumentParams;
      const document = await documentService.getDocument(id, req.userId);

      res.json({ document });
    } catch (error) {
      next(error);
    }
  }
);

// ===========================================
// DELETE /documents/:id - Delete document
// ===========================================
router.delete(
  '/:id',
  validate(deleteDocumentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertAuthenticated(req);

      const { id } = req.params as GetDocumentParams;
      await documentService.deleteDocument(id, req.userId);

      res.json({ message: 'Document deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

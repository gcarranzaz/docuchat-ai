// (removed misplaced route definition)
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as chatService from '../services/chat.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { chatLimiter, generalLimiter } from '../middleware/ratelimit.middleware.js';
import { errors } from '../middleware/error.middleware.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ===========================================
// Validation Schemas
// ===========================================

const chatRequestSchema = z.object({
  question: z.string().min(1).max(5000),
  sessionId: z.string().uuid().optional(),
  documentIds: z.array(z.string().uuid()).optional(),
});

const updateSessionSchema = z.object({
  title: z.string().min(1).max(200),
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ===========================================
// Routes
// ===========================================

/**
 * POST /chat
 * Send a question and receive an AI-powered answer with citations
 *
 * Request body:
 * {
 *   "question": "What is the total revenue?",
 *   "sessionId": "uuid", // Optional: continue existing session
 *   "documentIds": ["uuid1", "uuid2"] // Optional: filter to specific docs
 * }
 *
 * Response:
 * {
 *   "sessionId": "uuid",
 *   "messageId": "uuid",
 *   "answer": "The total revenue is $1.2M [chunk-0]...",
 *   "citations": [
 *     {
 *       "chunkId": "uuid",
 *       "text": "Revenue for Q1 2024 was $1.2M...",
 *       "relevance": 0.95
 *     }
 *   ],
 *   "confidence": {
 *     "score": 0.87,
 *     "level": "HIGH",
 *     "description": "Direct answer found in documents",
 *     "factors": {
 *       "retrievalScore": 0.92,
 *       "llmConfidence": 0.9,
 *       "citationCoverage": 0.75
 *     }
 *   },
 *   "metadata": {
 *     "chunksRetrieved": 5,
 *     "tokensUsed": 1234,
 *     "promptVersion": "chat_rag:v1.0"
 *   }
 * }
 */
router.post('/', authMiddleware, chatLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // Validate input
    const validation = chatRequestSchema.safeParse(req.body);
    if (!validation.success) {
      throw validation.error;
    }

    const { question, sessionId, documentIds } = validation.data;

    logger.info({ userId, sessionId, hasDocumentFilter: !!documentIds }, 'Chat request received');

    // Process chat
    const result = await chatService.chat(userId, {
      question,
      sessionId,
      documentIds,
    });

    res.json(result);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /chat/sessions
 * List all chat sessions for the authenticated user
 *
 * Query params:
 * - limit: Number of sessions to return (default: 20, max: 100)
 * - offset: Number of sessions to skip (default: 0)
 *
 * Response:
 * {
 *   "sessions": [
 *     {
 *       "id": "uuid",
 *       "title": "Revenue questions",
 *       "messageCount": 5,
 *       "lastMessageAt": "2024-01-15T10:30:00Z",
 *       "createdAt": "2024-01-15T09:00:00Z"
 *     }
 *   ],
 *   "total": 42
 * }
 */
router.get('/sessions', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // Validate query params
    const validation = paginationSchema.safeParse(req.query);
    if (!validation.success) {
      throw validation.error;
    }

    const { limit, offset } = validation.data;

    const result = await chatService.listSessions(userId, limit, offset);

    res.json(result);
  } catch (error) {
    throw error;
  }
});

/**
 * GET /chat/sessions/:id
 * Get a specific session with all its messages
 *
 * Response:
 * {
 *   "session": {
 *     "id": "uuid",
 *     "title": "Revenue questions",
 *     "createdAt": "2024-01-15T09:00:00Z",
 *     "updatedAt": "2024-01-15T10:30:00Z"
 *   },
 *   "messages": [
 *     {
 *       "id": "uuid",
 *       "role": "user",
 *       "content": "What is the revenue?",
 *       "createdAt": "2024-01-15T09:01:00Z"
 *     },
 *     {
 *       "id": "uuid",
 *       "role": "assistant",
 *       "content": "The revenue is $1.2M [chunk-0]",
 *       "citations": [...],
 *       "confidenceScore": 0.87,
 *       "createdAt": "2024-01-15T09:01:05Z"
 *     }
 *   ]
 * }
 */
router.get('/sessions/:id', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw errors.badRequest('Session ID is required');
    }

    const result = await chatService.getSession(userId, sessionId);

    res.json(result);
  } catch (error) {
    throw error;
  }
});

/**
 * PATCH /chat/sessions/:id
 * Update a session's title
 *
 * Request body:
 * {
 *   "title": "New title for the session"
 * }
 *
 * Response:
 * {
 *   "id": "uuid",
 *   "title": "New title for the session",
 *   "createdAt": "2024-01-15T09:00:00Z",
 *   "updatedAt": "2024-01-15T10:30:00Z"
 * }
 */
router.patch('/sessions/:id', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw errors.badRequest('Session ID is required');
    }

    // Validate input
    const validation = updateSessionSchema.safeParse(req.body);
    if (!validation.success) {
      throw validation.error;
    }

    const { title } = validation.data;

    const result = await chatService.updateSession(userId, sessionId, title);

    res.json(result);
  } catch (error) {
    throw error;
  }
});

/**
 * DELETE /chat/sessions/:id
 * Delete a session and all its messages
 *
 * Response:
 * 204 No Content
 */
router.delete('/sessions/:id', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const sessionId = req.params.id;

    if (!sessionId) {
      throw errors.badRequest('Session ID is required');
    }

    await chatService.deleteSession(userId, sessionId);

    res.status(204).send();
  } catch (error) {
    throw error;
  }
});

/**
 * DELETE /chat/sessions
 * Delete all chat sessions for the authenticated user
 * Response: 204 No Content
 */
router.delete('/sessions', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    await chatService.deleteAllSessions(userId);
    res.status(204).send();
  } catch (error) {
    throw error;
  }
});

export default router;

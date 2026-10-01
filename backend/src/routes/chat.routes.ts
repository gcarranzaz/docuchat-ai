// (removed misplaced route definition)
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as chatService from '../services/chat.service.js';
import * as chatRepo from '../repositories/chat.repository.js';
import * as feedbackRepo from '../repositories/feedback.repository.js';
import * as audit from '../services/audit.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { chatLimiter, generalLimiter } from '../middleware/ratelimit.middleware.js';
import { errors, AppError } from '../middleware/error.middleware.js';
import { StreamAbortedError } from '../ai/providers/errors.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ===========================================
// Validation Schemas
// ===========================================

const chatRequestSchema = z.object({
  question: z.string().min(1).max(5000),
  sessionId: z.string().uuid().optional(),
  documentIds: z.array(z.string().uuid()).optional(),
  /** Ask the same question again as a new turn (skips the cache, leaves the last attempt out of context) */
  regenerate: z.boolean().optional(),
});

const feedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  reason: z.string().trim().max(500).optional(),
});

const messageIdSchema = z.string().uuid();

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

    const { question, sessionId, documentIds, regenerate } = validation.data;

    logger.info({ userId, sessionId, hasDocumentFilter: !!documentIds }, 'Chat request received');

    // Process chat
    const result = await chatService.chat(userId, {
      question,
      sessionId,
      documentIds,
      regenerate,
    });

    res.json(result);
  } catch (error) {
    throw error;
  }
});

/**
 * POST /chat/stream
 * Same request as POST /chat, answered as Server-Sent Events:
 *
 *   event: status   data: {"phase":"generating"}
 *   event: token    data: {"text":"..."}        (zero or more: a DRAFT of the answer text)
 *   event: result   data: <the same body POST /chat returns>   (always last on success)
 *   event: error    data: {"code","message","status"}          (mid-stream failure; then the stream ends)
 *
 * Anything that can be refused (bad input, unknown session, rate limit, budget) is
 * decided BEFORE the stream opens, so those are ordinary HTTP errors (400/404/429).
 * Once it is open, status is 200 and a failure arrives as an `error` event.
 * The `result` event is the source of truth; on `error` the client discards the draft.
 */
router.post('/stream', authMiddleware, chatLimiter, async (req: Request, res: Response) => {
  const userId = req.userId!;

  const validation = chatRequestSchema.safeParse(req.body);
  if (!validation.success) {
    throw validation.error;
  }
  const { question, sessionId, documentIds, regenerate } = validation.data;

  // Stop generating if the client goes away before we finish: nobody is reading the tokens
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let started = false;
  let heartbeat: NodeJS.Timeout | undefined;

  const send = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const start = () => {
    if (started) return;
    started = true;
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell nginx-style proxies not to buffer the stream
    });
    res.flushHeaders();
    send('status', { phase: 'generating' });
    // Comment lines keep idle-timeout proxies (an ALB closes idle connections) from cutting a slow answer
    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, 15_000);
  };

  try {
    const result = await chatService.chat(
      userId,
      { question, sessionId, documentIds, regenerate },
      { onStreamStart: start, onToken: (text) => send('token', { text }), signal: controller.signal }
    );
    start(); // paths that never call the model (nothing retrieved) have not opened the stream yet
    send('result', result);
  } catch (error) {
    if (!started) throw error; // refused before streaming: an ordinary JSON error response
    if (!(error instanceof StreamAbortedError)) {
      logger.error({ err: error, userId }, 'Chat stream failed');
      send(
        'error',
        error instanceof AppError
          ? { code: error.code, message: error.message, status: error.statusCode }
          : { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', status: 500 }
      );
    }
  } finally {
    clearInterval(heartbeat);
    if (started && !res.writableEnded) res.end();
  }
});

/**
 * PUT /chat/messages/:id/feedback
 * Thumbs up/down on an assistant answer. One vote per user and message: sending it
 * again changes the vote. 404 if the message is not an assistant message of the caller.
 *
 * Body: { "rating": "up" | "down", "reason": "optional, up to 500 characters" }
 */
router.put('/messages/:id/feedback', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const messageId = messageIdSchema.safeParse(req.params['id']);
  if (!messageId.success) throw messageId.error;
  const body = feedbackSchema.safeParse(req.body);
  if (!body.success) throw body.error;

  const feedback = await feedbackRepo.upsert(userId, messageId.data, body.data.rating, body.data.reason ?? null);
  if (!feedback) throw errors.notFound('Message');

  logger.info({ userId, messageId: messageId.data, rating: feedback.rating }, 'Answer feedback recorded');
  await audit.record({ action: 'feedback.set', userId, resourceType: 'message', resourceId: messageId.data, metadata: { rating: feedback.rating } });
  res.json({ feedback });
});

/**
 * DELETE /chat/messages/:id/feedback
 * Remove the caller's vote (idempotent for messages they own; 404 otherwise).
 */
router.delete('/messages/:id/feedback', authMiddleware, generalLimiter, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const messageId = messageIdSchema.safeParse(req.params['id']);
  if (!messageId.success) throw messageId.error;

  const message = await chatRepo.findMessageById(messageId.data, userId);
  if (!message || message.role !== 'assistant') throw errors.notFound('Message');

  await feedbackRepo.remove(userId, messageId.data);
  await audit.record({ action: 'feedback.clear', userId, resourceType: 'message', resourceId: messageId.data });
  res.status(204).end();
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

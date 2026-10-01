/**
 * Delete all chat sessions for a user (and all their messages)
 */
export async function deleteAllSessions(userId: string): Promise<void> {
  await chatRepo.deleteAllSessions(userId);
  logger.info({ userId }, 'All chat sessions deleted');
}
/**
 * Chat Service with RAG
 * =====================
 * Orchestrates the complete RAG pipeline for document Q&A.
 *
 * Pipeline:
 * 1. Sanitize user input (anti-prompt injection)
 * 2. Retrieve relevant document chunks via vector similarity
 * 3. Build context string with citations
 * 4. Generate prompt with safety guidelines
 * 5. Call LLM for completion
 * 6. Parse citations from response
 * 7. Calculate confidence score
 * 8. Store messages in database
 * 9. Return structured response
 */

import { retrieveChunks, buildContextFromChunks, createChunkMapping } from '../rag/retriever.js';
import { buildChatPrompt, buildChatPromptV2, sanitizeInput } from '../ai/prompts/promptBuilder.js';
import { parseCitations, parseStructuredResponse, enrichCitationsWithScores } from '../ai/postprocessing/citationParser.js';
import { calculateConfidence, getConfidenceDescription } from '../ai/postprocessing/confidenceCalculator.js';
import { getLlmProvider } from '../ai/providers/providerFactory.js';
import * as chatRepo from '../repositories/chat.repository.js';
import * as usageRepo from '../repositories/usage.repository.js';
import { errors } from '../middleware/error.middleware.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import type { ChatSession, ChatMessage, Citation } from '../types/index.js';

// ===========================================
// Types
// ===========================================

export interface ChatRequest {
  sessionId?: string; // Optional: create new session if not provided
  question: string;
  documentIds?: string[]; // Optional: filter to specific documents
}

export interface ChatResponse {
  sessionId: string;
  messageId: string;
  answer: string;
  citations: Citation[];
  confidence: {
    score: number;
    level: string;
    description: string;
    factors: {
      retrievalScore: number;
      llmConfidence: number;
      citationCoverage: number;
    };
  };
  metadata: {
    chunksRetrieved: number;
    tokensUsed: number;
    promptVersion: string;
  };
}

export interface SessionListResponse {
  sessions: Array<{
    id: string;
    title: string;
    messageCount: number;
    lastMessageAt: Date;
    createdAt: Date;
  }>;
  total: number;
}

export interface SessionDetailResponse {
  session: ChatSession;
  messages: ChatMessage[];
}

// ===========================================
// Chat with RAG
// ===========================================

/**
 * Main chat function - orchestrates the RAG pipeline
 */
export async function chat(
  userId: string,
  request: ChatRequest
): Promise<ChatResponse> {
  const config = getConfig();

  // Step 1: Sanitize input
  const sanitizedQuestion = sanitizeInput(request.question);

  if (!sanitizedQuestion || sanitizedQuestion.trim().length === 0) {
    throw errors.badRequest('Question cannot be empty');
  }

  logger.info({ userId, question: sanitizedQuestion.substring(0, 100) }, 'Processing chat request');

  // Step 2: Get or create session
  let sessionId = request.sessionId;
  if (!sessionId) {
    const newSession = await chatRepo.createSession({
      userId,
      title: sanitizedQuestion.substring(0, 100), // Use first 100 chars as title
    });
    sessionId = newSession.id;
    logger.debug({ sessionId }, 'Created new chat session');
  } else {
    // Verify session belongs to user
    const session = await chatRepo.findSessionById(sessionId, userId);
    if (!session) {
      throw errors.notFound('Chat session');
    }
  }

  // Step 3: Store user message
  await chatRepo.createMessage({
    sessionId,
    userId,
    role: 'user',
    content: sanitizedQuestion,
  });

  try {
    // Step 4: Retrieve relevant chunks
    const retrieval = await retrieveChunks(sanitizedQuestion, userId, {
      topK: config.maxChunksPerQuery,
      documentIds: request.documentIds,
    });

    logger.debug({
      chunksFound: retrieval.chunks.length,
      topScore: retrieval.chunks[0]?.score ?? 0,
    }, 'Chunks retrieved');

    logger.debug({
      chunkIds: retrieval.chunks.map((c) => c.chunk.id),
      previews: retrieval.chunks.map((c) => c.chunk.content?.slice(0, 120)),
    }, 'Retrieved chunk details');

    // If no relevant chunks, return a clear response and skip LLM
    if (retrieval.chunks.length === 0) {
      const assistantMessage = await chatRepo.createMessage({
        sessionId,
        userId,
        role: 'assistant',
        content: 'No relevant information found in your documents to answer this question.',
        citations: [],
        confidence: {
          score: 0,
          level: 'none',
        },
        promptVersion: 'none',
        tokensUsed: retrieval.queryTokens,
      });

      return {
        sessionId,
        messageId: assistantMessage.id,
        answer: assistantMessage.content,
        citations: [],
        confidence: {
          score: 0,
          level: 'none',
          description: 'No relevant information found.',
          factors: {
            retrievalScore: 0,
            llmConfidence: 0,
            citationCoverage: 0,
          },
        },
        metadata: {
          chunksRetrieved: 0,
          tokensUsed: retrieval.queryTokens,
          promptVersion: 'none',
        },
      };
    }

    // ...existing code for LLM call and response...
    // Step 5: Build context and chunk mapping
    const context = buildContextFromChunks(retrieval.chunks);
    const chunkMapping = createChunkMapping(retrieval.chunks);

    // Step 6: Build prompt (v2 structured output or v1 text)
    const useStructured = config.useStructuredOutput;
    const prompt = useStructured
      ? buildChatPromptV2({ context, question: sanitizedQuestion })
      : buildChatPrompt({ context, question: sanitizedQuestion });

    // Step 7: Call LLM
    const llmProvider = getLlmProvider();
    const llmResult = await llmProvider.complete({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
    });

    logger.debug({
      responseLength: llmResult.content.length,
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
      useStructured,
    }, 'LLM response received');

    // Step 8: Parse citations (structured JSON or legacy text)
    const parsed = useStructured
      ? parseStructuredResponse(llmResult.content, chunkMapping)
      : parseCitations(llmResult.content, chunkMapping);

    // Enrich citations with relevance scores
    const chunkScores = new Map(
      retrieval.chunks.map((c) => [c.chunk.id, c.score])
    );
    const enrichedCitations = enrichCitationsWithScores(parsed.citations, chunkScores);

    // Step 9: Calculate confidence
    const confidenceResult = calculateConfidence({
      chunks: retrieval.chunks,
      llmConfidenceStr: parsed.rawConfidence,
      citations: enrichedCitations,
      responseLength: llmResult.content.length,
    });

    logger.info({
      sessionId,
      confidenceLevel: confidenceResult.level,
      confidenceScore: confidenceResult.score,
      citationCount: enrichedCitations.length,
    }, 'Chat response generated');

    // Step 10: Store assistant message
    const assistantMessage = await chatRepo.createMessage({
      sessionId,
      userId,
      role: 'assistant',
      content: llmResult.content,
      citations: enrichedCitations,
      confidence: {
        score: confidenceResult.score,
        level: confidenceResult.level,
      },
      promptVersion: prompt.promptVersion,
      tokensUsed: retrieval.queryTokens + llmResult.inputTokens + llmResult.outputTokens,
    });

    // Step 11: Log usage for rate limiting and analytics
    await usageRepo.create({
      userId,
      operation: 'chat',
      provider: config.aiProvider,
      model: llmResult.model,
      inputTokens: retrieval.queryTokens + llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
      success: true,
      metadata: {
        sessionId,
        chunksRetrieved: retrieval.chunks.length,
        confidenceLevel: confidenceResult.level,
      },
    });

    // Step 12: Return structured response
    return {
      sessionId,
      messageId: assistantMessage.id,
      answer: llmResult.content,
      citations: enrichedCitations,
      confidence: {
        score: confidenceResult.score,
        level: confidenceResult.level,
        description: getConfidenceDescription(confidenceResult.level),
        factors: confidenceResult.factors,
      },
      metadata: {
        chunksRetrieved: retrieval.chunks.length,
        tokensUsed: retrieval.queryTokens + llmResult.inputTokens + llmResult.outputTokens,
        promptVersion: prompt.promptVersion,
      },
    };

  } catch (error) {
    logger.error({ err: error, userId, sessionId }, 'Chat processing failed');
    throw error;
  }
}

// ===========================================
// Session Management
// ===========================================

/**
 * List all chat sessions for a user
 */
export async function listSessions(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<SessionListResponse> {
  const result = await chatRepo.findSessionsByUser(userId, limit, offset);

  return {
    sessions: result.sessions.map((s) => ({
      id: s.id,
      title: s.title || 'New Chat',
      messageCount: s.messageCount,
      lastMessageAt: s.lastMessageAt || s.createdAt,
      createdAt: s.createdAt,
    })),
    total: result.total,
  };
}

/**
 * Get a specific session with all messages
 */
export async function getSession(
  userId: string,
  sessionId: string
): Promise<SessionDetailResponse> {
  const session = await chatRepo.findSessionById(sessionId, userId);

  if (!session) {
    throw errors.notFound('Chat session');
  }

  const messages = await chatRepo.findMessagesBySession(sessionId, userId);

  return {
    session,
    messages,
  };
}

/**
 * Update session title
 */
export async function updateSession(
  userId: string,
  sessionId: string,
  title: string
): Promise<ChatSession> {
  const updated = await chatRepo.updateSessionTitle(sessionId, userId, title);

  if (!updated) {
    throw errors.notFound('Chat session');
  }

  return updated;
}

/**
 * Delete a session
 */
export async function deleteSession(
  userId: string,
  sessionId: string
): Promise<void> {
  const deleted = await chatRepo.deleteSession(sessionId, userId);

  if (!deleted) {
    throw errors.notFound('Chat session');
  }

  logger.info({ userId, sessionId }, 'Chat session deleted');
}

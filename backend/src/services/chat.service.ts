/**
 * Chat Service with RAG
 * =====================
 * Orchestrates one question/answer turn. The AI work itself (prompt
 * construction, model call, post-processing) lives in ai/pipeline/chatPipeline.ts;
 * this service only handles the surrounding concerns.
 *
 * Flow:
 * 1. Normalise and validate the question (ai/safety/inputGuard.ts)
 * 2. Get or create the chat session, load recent history
 * 3. Retrieve relevant document chunks via vector similarity
 * 4. Run the AI pipeline (prompt → model → validated answer)
 * 5. Calculate the confidence score
 * 6. Store the messages and the usage record
 * 7. Return the structured response
 */

import { retrieveChunks } from '../rag/retriever.js';
import { enrichCitationsWithScores } from '../ai/postprocessing/citationParser.js';
import { calculateConfidence, getConfidenceDescription, isGrounded } from '../ai/postprocessing/confidenceCalculator.js';
import { getLlmProvider, chatModelName } from '../ai/providers/providerFactory.js';
import { runChatPipeline, AiOutputInvalidError, type ChatPipelineResult } from '../ai/pipeline/chatPipeline.js';
import { calculateCost } from '../ai/pricing.js';
import { activePrompt } from '../ai/prompts/registry.js';
import { buildCacheKey, getCachedAnswer, setCachedAnswer } from '../ai/responseCache.js';
import { estimateTokenCount } from '../rag/chunker.js';
import * as budget from './budget.service.js';
import * as audit from './audit.service.js';
import { StreamAbortedError } from '../ai/providers/errors.js';
import { prepareQuestion, detectInjection, InputRejectedError, type PreparedQuestion } from '../ai/safety/inputGuard.js';
import type { HistoryTurn } from '../ai/prompts/promptBuilder.js';
import * as chatRepo from '../repositories/chat.repository.js';
import * as usageRepo from '../repositories/usage.repository.js';
import { errors, AppError } from '../middleware/error.middleware.js';
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
  /**
   * Ask the same question again as a new turn. Skips the answer cache and leaves the
   * previous attempt out of the context, so the model does not just copy its own answer.
   */
  regenerate?: boolean;
}

export interface ChatResponse {
  sessionId: string;
  messageId: string;
  answer: string;
  citations: Citation[];
  /**
   * True only when the answer is backed by at least one valid citation and the evidence
   * is not "none". When false, clients must not present the answer as established fact.
   */
  grounded: boolean;
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
    model: string;
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

/**
 * For "regenerate": drop the trailing user+assistant exchange when it is the same question,
 * so the new attempt starts from the conversation as it was before that attempt.
 */
function withoutLastAttempt(history: HistoryTurn[], question: string): HistoryTurn[] {
  const last = history[history.length - 1];
  const asked = history[history.length - 2];
  if (last?.role === 'assistant' && asked?.role === 'user' && asked.content.trim().toLowerCase() === question.trim().toLowerCase()) {
    return history.slice(0, -2);
  }
  return history;
}

// Rough size of the chat system prompt, added to the input estimate used for budgeting
const SYSTEM_PROMPT_TOKENS = 800;

// ===========================================
// Chat with RAG
// ===========================================

/** Hooks for streaming callers. All optional: without them `chat` behaves as a plain request/response. */
export interface ChatOptions {
  /** Called once everything that can be refused has been decided and generation begins */
  onStreamStart?: () => void;
  /** Called with each piece of the answer text as it is generated (a draft; see chatPipeline) */
  onToken?: (text: string) => void;
  /** Aborts generation, for example when the client disconnects */
  signal?: AbortSignal;
}

/**
 * Main chat function - one question/answer turn
 */
export async function chat(userId: string, request: ChatRequest, options: ChatOptions = {}): Promise<ChatResponse> {
  const config = getConfig();

  // Step 1: Normalise and validate input
  let prepared: PreparedQuestion;
  try {
    prepared = prepareQuestion(request.question, {
      maxChars: config.maxQuestionChars,
      detect: config.injectionDetection,
    });
  } catch (error) {
    if (error instanceof InputRejectedError) {
      throw errors.badRequest(error.message, 'INVALID_QUESTION');
    }
    throw error;
  }
  const question = prepared.text;

  if (prepared.injection.flagged) {
    // Flag and count, never block: the structural defences handle it (docs/SECURITY.md)
    logger.warn({ userId, signals: prepared.injection.signals }, 'Possible prompt injection in question');
  }

  // Log sizes and ids, never the question: it can contain personal data (docs/AI-DATA.md)
  logger.info({ userId, questionLength: question.length, hasSession: Boolean(request.sessionId) }, 'Processing chat request');

  // Step 2: Get or create session; load recent history before storing the new message
  let sessionId = request.sessionId;
  let history: HistoryTurn[] = [];
  if (!sessionId) {
    const newSession = await chatRepo.createSession({
      userId,
      title: question.substring(0, 100), // Use first 100 chars as title
    });
    sessionId = newSession.id;
    logger.debug({ sessionId }, 'Created new chat session');
  } else {
    // Verify session belongs to user
    const session = await chatRepo.findSessionById(sessionId, userId);
    if (!session) {
      throw errors.notFound('Chat session');
    }
    const previous = await chatRepo.findMessagesBySession(sessionId, userId);
    history = previous
      .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    if (request.regenerate) {
      history = withoutLastAttempt(history, question);
    }
  }

  // Step 3: Store user message
  await chatRepo.createMessage({
    sessionId,
    userId,
    role: 'user',
    content: question,
  });

  try {
    // Step 4: Retrieve relevant chunks (always scoped to this user)
    const retrieval = await retrieveChunks(question, userId, {
      topK: config.maxChunksPerQuery,
      documentIds: request.documentIds,
    });

    logger.debug({
      chunksFound: retrieval.chunks.length,
      topScore: retrieval.chunks[0]?.score ?? 0,
    }, 'Chunks retrieved');

    logger.debug({ chunkIds: retrieval.chunks.map((c) => c.chunk.id) }, 'Retrieved chunk ids');

    // If no relevant chunks, return a clear response and skip the model
    if (retrieval.chunks.length === 0) {
      const assistantMessage = await chatRepo.createMessage({
        sessionId,
        userId,
        role: 'assistant',
        content: 'No relevant information found in your documents to answer this question.',
        citations: [],
        confidence: {
          score: 0,
          level: 'NONE',
        },
        promptVersion: 'none',
        tokensUsed: retrieval.queryTokens,
        metadata: { grounded: false },
      });

      return {
        sessionId,
        messageId: assistantMessage.id,
        answer: assistantMessage.content,
        citations: [],
        grounded: false,
        confidence: {
          score: 0,
          level: 'NONE',
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
          model: 'none',
        },
      };
    }

    // Documents can carry injection attempts too: count them for review
    const documentInjection = config.injectionDetection
      ? detectInjection(retrieval.chunks.map((c) => c.chunk.content).join('\n'))
      : { flagged: false, signals: [] as string[] };
    if (documentInjection.flagged) {
      logger.warn({ userId, signals: documentInjection.signals }, 'Possible prompt injection in retrieved document text');
    }

    // Step 5: Answer from cache, or reserve budget → prompt → model → validated answer
    const model = chatModelName(config);
    const promptTemplate = activePrompt('chat_rag', config);
    const promptVersion = `${promptTemplate.name}:${promptTemplate.version}`;

    // Only the first turn is cached: earlier turns change the answer
    const cacheKey =
      config.aiCacheEnabled && history.length === 0 && !request.regenerate
        ? buildCacheKey({ userId, question, chunkIds: retrieval.chunks.map((c) => c.chunk.id), promptVersion, model })
        : null;

    let result: ChatPipelineResult;
    let cached = false;

    const cachedAnswer = cacheKey ? await getCachedAnswer(cacheKey) : null;
    if (cachedAnswer) {
      cached = true;
      options.onStreamStart?.(); // a cached answer is delivered as the final result, with no tokens
      result = { ...cachedAnswer, repaired: false, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0 };
    } else {
      // Worst case for this call: estimated prompt + the maximum output. Reserved atomically
      // before the model is called, so concurrent requests cannot overspend (budget.service.ts).
      const estimatedInput =
        estimateTokenCount(question) +
        retrieval.chunks.reduce((sum, c) => sum + estimateTokenCount(c.chunk.content), 0) +
        history.reduce((sum, turn) => sum + estimateTokenCount(turn.content), 0) +
        SYSTEM_PROMPT_TOKENS;
      // Tools (spec 011) need complete turns, so they are not offered on the streaming path. Each tool
      // round is another model call, so the worst case is (1 + rounds) calls.
      const provider = getLlmProvider();
      const useTools = config.toolsEnabled && !options.onToken && Boolean(provider.completeWithTools);
      const calls = useTools ? 1 + config.toolMaxRounds : 1;
      const reservation = await budget.reserve(
        userId,
        {
          tokens: (estimatedInput + config.maxTokensPerRequest) * calls,
          costUsd: calculateCost(model, estimatedInput * calls, config.maxTokensPerRequest * calls),
        },
        { dailyTokens: config.userDailyTokenBudget, monthlyCostUsd: config.userMonthlyCostCapUsd }
      );

      // Everything that can be refused (input, session, retrieval, budget) has been decided:
      // from here on a streaming caller may open its response
      options.onStreamStart?.();

      let emittedChars = 0;
      try {
        result = await runChatPipeline({
          question,
          chunks: retrieval.chunks,
          history,
          provider,
          ...(useTools && {
            tools: {
              userId,
              maxRounds: config.toolMaxRounds,
              // Every call is audited, whether it worked, was refused or was malformed
              onToolCall: async (call, execution, round) => {
                await audit.record({
                  action: 'tool.call',
                  userId,
                  outcome: execution.outcome,
                  resourceType: 'document',
                  ...(execution.resourceId && { resourceId: execution.resourceId }),
                  metadata: { tool: call.name, round },
                });
              },
            },
          }),
          ...(options.onToken && {
            stream: {
              onToken: (text: string) => {
                emittedChars += text.length;
                options.onToken?.(text);
              },
              ...(options.signal && { signal: options.signal }),
            },
          }),
        });
      } catch (error) {
        if (emittedChars > 0) {
          // The provider generated (and bills) what was already streamed, even if the user
          // closed the page or the stream broke: charge an estimate instead of giving it back,
          // otherwise starting a stream and aborting would be free
          await budget.settle(reservation, {
            tokens: estimatedInput + Math.ceil(emittedChars / 4),
            costUsd: calculateCost(model, estimatedInput, Math.ceil(emittedChars / 4)),
          });
        } else {
          await budget.release(reservation); // nothing was generated we can account for
        }
        if (error instanceof AiOutputInvalidError) {
          throw errors.badGateway(error.message, error.code);
        }
        throw error;
      }

      await budget.settle(reservation, {
        tokens: result.usage.inputTokens + result.usage.outputTokens,
        costUsd: calculateCost(result.model, result.usage.inputTokens, result.usage.outputTokens),
      });

      if (cacheKey) {
        await setCachedAnswer(
          cacheKey,
          {
            answer: result.answer,
            citations: result.citations,
            rawConfidence: result.rawConfidence,
            reasoning: result.reasoning,
            droppedCitations: result.droppedCitations,
            model: result.model,
            promptVersion: result.promptVersion,
          },
          config.aiCacheTtlSeconds
        );
      }
    }

    // Enrich citations with relevance scores
    const chunkScores = new Map(retrieval.chunks.map((c) => [c.chunk.id, c.score]));
    const citations = enrichCitationsWithScores(result.citations, chunkScores);

    // Step 6: Calculate confidence
    const confidenceResult = calculateConfidence({
      chunks: retrieval.chunks,
      llmConfidenceStr: result.rawConfidence,
      citations,
      responseLength: result.answer.length,
    });

    logger.info({
      sessionId,
      confidenceLevel: confidenceResult.level,
      confidenceScore: confidenceResult.score,
      citationCount: citations.length,
      droppedCitations: result.droppedCitations,
      repaired: result.repaired,
    }, 'Chat response generated');

    const inputTokens = retrieval.queryTokens + result.usage.inputTokens;
    const outputTokens = result.usage.outputTokens;

    // Backed by a real citation and not "no evidence": otherwise the UI must hedge
    const grounded = isGrounded(citations.length, confidenceResult.level);

    // Step 7: Store assistant message (the validated answer, never the raw model output)
    const assistantMessage = await chatRepo.createMessage({
      sessionId,
      userId,
      role: 'assistant',
      content: result.answer,
      citations,
      confidence: {
        score: confidenceResult.score,
        level: confidenceResult.level,
      },
      promptVersion: result.promptVersion,
      model: result.model,
      inputTokens,
      outputTokens,
      metadata: { grounded, cached, repaired: result.repaired, regenerated: request.regenerate === true },
    });

    // Step 8: Log usage for rate limiting and analytics
    await usageRepo.create({
      userId,
      operation: 'chat',
      provider: config.aiProvider,
      model: result.model,
      inputTokens,
      outputTokens,
      success: true,
      metadata: {
        sessionId,
        chunksRetrieved: retrieval.chunks.length,
        confidenceLevel: confidenceResult.level,
        promptVersion: result.promptVersion,
        repaired: result.repaired,
        droppedCitations: result.droppedCitations,
        cached,
        injectionSignals: prepared.injection.signals,
        documentInjectionSignals: documentInjection.signals,
      },
    });

    // The audit row says who asked, with which model and prompt, and how it went: never what was said
    await audit.record({
      action: 'chat.ask',
      userId,
      resourceType: 'message',
      resourceId: assistantMessage.id,
      metadata: {
        sessionId,
        model: result.model,
        promptVersion: result.promptVersion,
        inputTokens,
        outputTokens,
        cached,
        grounded,
        regenerated: request.regenerate === true,
        confidenceLevel: confidenceResult.level,
        injectionSignals: prepared.injection.signals,
        documentInjectionSignals: documentInjection.signals,
      },
    });

    // Step 9: Return structured response
    return {
      sessionId,
      messageId: assistantMessage.id,
      answer: result.answer,
      citations,
      grounded,
      confidence: {
        score: confidenceResult.score,
        level: confidenceResult.level,
        description: getConfidenceDescription(confidenceResult.level),
        factors: confidenceResult.factors,
      },
      metadata: {
        chunksRetrieved: retrieval.chunks.length,
        tokensUsed: inputTokens + outputTokens,
        promptVersion: result.promptVersion,
        model: result.model,
      },
    };

  } catch (error) {
    logger.error({ err: error, userId, sessionId }, 'Chat processing failed');
    if (error instanceof budget.BudgetExceededError) {
      await audit.record({ action: 'chat.blocked', userId, outcome: 'denied', metadata: { reason: error.code, sessionId } });
    } else if (error instanceof AppError || !(error instanceof StreamAbortedError)) {
      await audit.record({
        action: 'chat.ask',
        userId,
        outcome: 'error',
        metadata: { sessionId, errorCode: error instanceof AppError ? error.code : 'INTERNAL_ERROR' },
      });
    }
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
  await audit.record({ action: 'session.delete', userId, resourceType: 'session', resourceId: sessionId });
}

/**
 * Delete all chat sessions for a user (and all their messages)
 */
export async function deleteAllSessions(userId: string): Promise<void> {
  await chatRepo.deleteAllSessions(userId);
  logger.info({ userId }, 'All chat sessions deleted');
  await audit.record({ action: 'session.delete_all', userId });
}

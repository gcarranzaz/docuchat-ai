/**
 * useChatStream
 * =============
 * Owns the conversation: sends questions, shows the answer while it is generated,
 * and exposes the actions around an answer (stop, retry, regenerate, rate).
 *
 * What the user sees while an answer streams is a DRAFT (no citations, no confidence
 * yet). The final `result` replaces it; if the request fails the draft is discarded,
 * never kept as if it were a real answer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { chatApi } from '../api/client';
import { streamChat } from '../api/chatStream';
import type { ApiError, ChatMessage, ChatResponse, Rating } from '../types';

/** idle → searching (looking through the documents) → writing (the model is answering) */
export type Phase = 'idle' | 'searching' | 'writing';

export interface ChatError {
  code: string;
  message: string;
  /** Whether trying the same question again can help */
  retryable: boolean;
}

/** Human wording for the failures a user can actually run into */
export function describeError(error: ApiError, retryAfterSeconds?: number): ChatError {
  switch (error.code) {
    case 'RATE_LIMIT_EXCEEDED':
      return {
        code: error.code,
        message: retryAfterSeconds
          ? `You are asking too quickly. Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'} and try again.`
          : 'You are asking too quickly. Please wait a moment and try again.',
        retryable: true,
      };
    case 'DAILY_TOKEN_BUDGET_EXCEEDED':
    case 'MONTHLY_COST_CAP_EXCEEDED':
      // The server message says when the allowance resets; retrying now cannot help
      return { code: error.code, message: error.message, retryable: false };
    case 'AI_OUTPUT_INVALID':
      return { code: error.code, message: 'The assistant produced an answer in an unusable format. Trying again usually fixes it.', retryable: true };
    case 'NETWORK_ERROR':
    case 'STREAM_INTERRUPTED':
      return { code: error.code, message: error.message, retryable: true };
    case 'UNAUTHORIZED':
      return { code: error.code, message: error.message, retryable: false };
    case 'INVALID_QUESTION':
    case 'VALIDATION_ERROR':
      return { code: error.code, message: error.message || 'That question could not be sent. Check it and try again.', retryable: false };
    default:
      return { code: error.code, message: 'Something went wrong while generating the answer. Please try again.', retryable: true };
  }
}

interface RunOptions {
  /** Show the question as a new user bubble (false when retrying or regenerating) */
  addUserMessage?: boolean;
  regenerate?: boolean;
}

export function useChatStream(documentIds: string[]) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ChatError | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const lastRef = useRef<{ question: string; regenerate: boolean } | null>(null);
  const documentIdsRef = useRef(documentIds);
  documentIdsRef.current = documentIds;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Leaving the page cancels an answer in flight: nobody is reading it
  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (question: string, options: RunOptions = {}) => {
    const text = question.trim();
    if (text === '' || busyRef.current) return;
    busyRef.current = true;

    const regenerate = options.regenerate === true;
    lastRef.current = { question: text, regenerate };

    const pendingId = `pending-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    setError(null);
    setPhase('searching');
    setMessages((previous) => [
      ...previous,
      ...(options.addUserMessage === false ? [] : [{ id: crypto.randomUUID(), role: 'user' as const, content: text, createdAt: now }]),
      { id: pendingId, role: 'assistant' as const, content: '', streaming: true, createdAt: now },
    ]);

    const controller = new AbortController();
    controllerRef.current = controller;

    const outcome = await streamChat(
      {
        question: text,
        ...(sessionRef.current && { sessionId: sessionRef.current }),
        documentIds: documentIdsRef.current,
        ...(regenerate && { regenerate: true }),
      },
      {
        onStatus: (status) => {
          if (status === 'generating') setPhase('writing');
        },
        onToken: (piece) => {
          setMessages((previous) => previous.map((m) => (m.id === pendingId ? { ...m, content: m.content + piece } : m)));
        },
        onResult: (result: ChatResponse) => {
          sessionRef.current = result.sessionId;
          setSessionId(result.sessionId);
          setMessages((previous) =>
            previous.map((m) =>
              m.id === pendingId
                ? {
                    id: result.messageId,
                    role: 'assistant',
                    content: result.answer, // replaces the draft: this is the validated answer
                    citations: result.citations,
                    grounded: result.grounded,
                    confidenceLevel: result.confidence.level,
                    confidenceScore: result.confidence.score,
                    rating: null,
                    createdAt: m.createdAt,
                  }
                : m
            )
          );
        },
      },
      controller.signal
    );

    if (!outcome.ok) {
      if (outcome.aborted) {
        // Keep what was written, clearly marked as partial; drop the bubble if nothing arrived
        setMessages((previous) =>
          previous.flatMap((m) => {
            if (m.id !== pendingId) return [m];
            return m.content === '' ? [] : [{ ...m, streaming: false, stopped: true }];
          })
        );
      } else {
        // A failed answer is discarded entirely: a half-written draft must not look like a result
        setMessages((previous) => previous.filter((m) => m.id !== pendingId));
        setError(describeError(outcome.error, outcome.retryAfterSeconds));
      }
    }

    controllerRef.current = null;
    busyRef.current = false;
    setPhase('idle');
  }, []);

  const send = useCallback((question: string) => run(question), [run]);

  const stop = useCallback(() => controllerRef.current?.abort(), []);

  /** Try the last question again without adding it to the conversation twice */
  const retry = useCallback(() => {
    const last = lastRef.current;
    if (last) void run(last.question, { addUserMessage: false, regenerate: last.regenerate });
  }, [run]);

  /** Ask again the question that produced this answer; both attempts stay in the conversation */
  const regenerate = useCallback(
    (assistantMessageId: string) => {
      const index = messages.findIndex((m) => m.id === assistantMessageId);
      const question = messages
        .slice(0, index)
        .reverse()
        .find((m) => m.role === 'user')?.content;
      if (question) void run(question, { addUserMessage: false, regenerate: true });
    },
    [messages, run]
  );

  /** Thumbs up/down; pressing the same one again clears the vote. Optimistic, reverted on failure. */
  const rate = useCallback(async (messageId: string, rating: Rating) => {
    // Read the current vote from the latest state, not from inside a state updater: React runs
    // updaters later, so anything assigned there is not yet set when the next line needs it
    const before = messagesRef.current.find((m) => m.id === messageId)?.rating ?? null;
    const next: Rating | null = before === rating ? null : rating;

    setMessages((all) => all.map((m) => (m.id === messageId ? { ...m, rating: next } : m)));

    const response = next === null ? await chatApi.clearFeedback(messageId) : await chatApi.setFeedback(messageId, next);

    if (response.error) {
      setMessages((all) => all.map((m) => (m.id === messageId ? { ...m, rating: before } : m)));
      setError({ code: 'FEEDBACK_FAILED', message: 'Your feedback could not be saved. Please try again.', retryable: false });
    }
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    sessionRef.current = null;
    lastRef.current = null;
    setSessionId(null);
    setMessages([]);
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { messages, phase, busy: phase !== 'idle', error, sessionId, send, stop, retry, regenerate, rate, reset, clearError };
}

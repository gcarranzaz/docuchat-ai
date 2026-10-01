/**
 * Chat streaming client
 * =====================
 * Consumes POST /chat/stream (Server-Sent Events) with fetch. EventSource is not
 * an option: it can only GET and cannot send the Authorization header.
 *
 * Contract with the backend (see backend/src/routes/chat.routes.ts):
 *   - Anything that can be refused (bad input, unknown session, rate limit, budget) is a normal
 *     HTTP error BEFORE the stream opens, with the JSON body { error: { code, message } }.
 *   - Once open: `status`, zero or more `token` (a DRAFT of the answer), then exactly one
 *     `result` (the validated answer: the source of truth) or one `error`.
 */

import { API_BASE_URL, getAccessToken, attemptTokenRefresh, clearTokens } from './client';
import type { ApiError, ChatResponse } from '../types';

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Split a buffer into complete SSE events plus the unfinished tail.
 * Comment lines (": ping" heartbeats) and malformed events are skipped.
 */
export function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';

  const events: SseEvent[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (data === '') continue; // heartbeat or empty block
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      // a broken event must not take the whole stream down
    }
  }
  return { events, rest };
}

export interface StreamRequest {
  question: string;
  sessionId?: string;
  documentIds?: string[];
  regenerate?: boolean;
}

export interface StreamHandlers {
  onStatus?: (phase: string) => void;
  /** Next piece of the answer text. A draft: the final result replaces it. */
  onToken: (text: string) => void;
  onResult: (result: ChatResponse) => void;
}

export type StreamOutcome = { ok: true } | { ok: false; error: ApiError; aborted?: boolean; retryAfterSeconds?: number };

async function open(request: StreamRequest, signal: AbortSignal): Promise<Response> {
  return fetch(`${API_BASE_URL}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${getAccessToken() ?? ''}`,
    },
    body: JSON.stringify(request),
    signal,
  });
}

export async function streamChat(request: StreamRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<StreamOutcome> {
  try {
    let response = await open(request, signal);

    if (response.status === 401) {
      if (await attemptTokenRefresh()) {
        response = await open(request, signal);
      } else {
        clearTokens();
        return { ok: false, error: { code: 'UNAUTHORIZED', message: 'Your session expired. Please sign in again.' } };
      }
    }

    // Refused before the stream opened: an ordinary JSON error
    if (!response.ok) {
      let error: ApiError = { code: 'UNKNOWN_ERROR', message: `Request failed with status ${response.status}` };
      try {
        const body = (await response.json()) as { error?: ApiError };
        if (body.error) error = body.error;
      } catch {
        // keep the generic error
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      return { ok: false, error, ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfterSeconds: retryAfter }) };
    }

    if (!response.body) {
      return { ok: false, error: { code: 'STREAM_UNSUPPORTED', message: 'This browser cannot read streamed responses.' } };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished: StreamOutcome | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;

      for (const { event, data } of parsed.events) {
        if (event === 'status') {
          handlers.onStatus?.((data as { phase: string }).phase);
        } else if (event === 'token') {
          handlers.onToken((data as { text: string }).text);
        } else if (event === 'result') {
          handlers.onResult(data as ChatResponse);
          finished = { ok: true };
        } else if (event === 'error') {
          const { code, message } = data as { code: string; message: string };
          finished = { ok: false, error: { code, message } };
        }
      }
    }

    // The stream ended without a result or an error event: the connection dropped mid-answer
    return (
      finished ?? {
        ok: false,
        error: { code: 'STREAM_INTERRUPTED', message: 'The connection was interrupted before the answer finished.' },
      }
    );
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return { ok: false, aborted: true, error: { code: 'ABORTED', message: 'Stopped.' } };
    }
    return { ok: false, error: { code: 'NETWORK_ERROR', message: 'Cannot reach the server. Check your connection and try again.' } };
  }
}

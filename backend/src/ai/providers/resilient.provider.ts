/**
 * Resilient Provider
 * ==================
 * Wraps a provider with retries and an optional fallback, so callers keep
 * depending only on `LlmProvider`.
 *
 * Policy:
 * - Retry retryable errors (429, 5xx, timeouts) with backoff.
 * - Fall back to the secondary provider only after the primary's retries are
 *   exhausted AND the error is retryable. A 401 or 400 is a bug to surface, not
 *   an outage to route around.
 * - Embeddings never fall back: vectors from different models live in different
 *   spaces and must not be mixed in one index. They are retried, nothing more.
 */

import type {
  LlmProvider,
  CompletionParams,
  StreamHandlers,
  ToolCompletionParams,
  ToolCompletionResult,
} from './llmProvider.interface.js';
import type { EmbeddingResult, CompletionResult } from '../../types/index.js';
import { LlmProviderError } from './errors.js';
import { withRetry, type RetryOptions } from './retry.js';
import { logger } from '../../utils/logger.js';

export interface ResilientProviderOptions {
  retry: RetryOptions;
  fallback?: LlmProvider;
}

export class ResilientProvider implements LlmProvider {
  constructor(
    private readonly primary: LlmProvider,
    private readonly options: ResilientProviderOptions
  ) {}

  get name(): string {
    return this.primary.name;
  }

  isConfigured(): boolean {
    return this.primary.isConfigured();
  }

  embed(text: string): Promise<EmbeddingResult> {
    return withRetry(() => this.primary.embed(text), this.options.retry);
  }

  embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return withRetry(() => this.primary.embedBatch(texts), this.options.retry);
  }

  /**
   * Streaming policy: once the first token has reached the caller the answer is
   * already on the user's screen, so a retry or a fallback would restart it from
   * scratch. Before the first token, the same retry and fallback rules as complete()
   * apply. After it, any failure is final.
   */
  async stream(params: CompletionParams, handlers: StreamHandlers): Promise<CompletionResult> {
    let emitted = false;
    const tracked: StreamHandlers = {
      ...handlers,
      onToken: (text) => {
        emitted = true;
        handlers.onToken(text);
      },
    };

    const attempt = (provider: LlmProvider) => async (): Promise<CompletionResult> => {
      try {
        return await provider.stream(params, tracked);
      } catch (error) {
        if (emitted && error instanceof LlmProviderError && error.retryable) {
          // Same failure, marked final so withRetry does not start a second answer on top of the first
          throw new LlmProviderError(error.message, error.provider, error.status, false, { cause: error });
        }
        throw error;
      }
    };

    try {
      return await withRetry(attempt(this.primary), this.options.retry);
    } catch (error) {
      const { fallback } = this.options;
      if (emitted || !fallback || !(error instanceof LlmProviderError) || !error.retryable) {
        throw error;
      }

      logger.warn(
        { primary: this.primary.name, fallback: fallback.name, status: error.status },
        'Primary LLM provider failed before streaming started; using fallback'
      );
      try {
        return await withRetry(attempt(fallback), this.options.retry);
      } catch (fallbackError) {
        logger.error({ err: fallbackError, fallback: fallback.name }, 'Fallback LLM provider also failed');
        throw error;
      }
    }
  }

  /**
   * Same policy as complete(), per step. Present only when the primary supports tools. A fallback
   * is used only if it supports them too; otherwise the failure is final. The transcript is
   * provider-neutral, so a fallback can continue a conversation the primary began.
   */
  get completeWithTools(): LlmProvider['completeWithTools'] {
    const primary = this.primary.completeWithTools?.bind(this.primary);
    if (!primary) return undefined;
    return async (params: ToolCompletionParams): Promise<ToolCompletionResult> => {
      try {
        return await withRetry(() => primary(params), this.options.retry);
      } catch (error) {
        const fallback = this.options.fallback;
        const secondary = fallback?.completeWithTools?.bind(fallback);
        if (!fallback || !secondary || !(error instanceof LlmProviderError) || !error.retryable) {
          throw error;
        }
        logger.warn({ primary: this.primary.name, fallback: fallback.name, status: error.status }, 'Primary LLM provider failed on a tool step; using fallback');
        try {
          return await withRetry(() => secondary(params), this.options.retry);
        } catch (fallbackError) {
          logger.error({ err: fallbackError, fallback: fallback.name }, 'Fallback LLM provider also failed');
          throw error;
        }
      }
    };
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    try {
      return await withRetry(() => this.primary.complete(params), this.options.retry);
    } catch (error) {
      const { fallback } = this.options;
      if (!fallback || !(error instanceof LlmProviderError) || !error.retryable) {
        throw error;
      }

      logger.warn(
        { primary: this.primary.name, fallback: fallback.name, status: error.status },
        'Primary LLM provider failed after retries; using fallback'
      );

      try {
        return await withRetry(() => fallback.complete(params), this.options.retry);
      } catch (fallbackError) {
        logger.error({ err: fallbackError, fallback: fallback.name }, 'Fallback LLM provider also failed');
        // The primary failure is the root cause the operator needs to see first
        throw error;
      }
    }
  }
}

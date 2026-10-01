/**
 * Retry with exponential backoff and jitter
 * =========================================
 * Only retries errors flagged `retryable` by the provider layer. Anything else
 * (bad key, bad request, programming error) is thrown immediately.
 */

import { LlmProviderError } from './errors.js';

export interface RetryOptions {
  /** Retries after the first attempt (2 means up to 3 calls in total) */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; returns a value in [0, 1) */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs = 10_000, sleep = defaultSleep, random = Math.random } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const retryable = error instanceof LlmProviderError && error.retryable;
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }

      // Honour the provider's Retry-After; otherwise exponential backoff with
      // jitter (between 50% and 100% of the step) so clients do not retry in sync.
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = error.retryAfterMs !== undefined ? Math.min(error.retryAfterMs, maxDelayMs) : Math.round(backoff * (0.5 + random() * 0.5));
      await sleep(delay);
    }
  }
}

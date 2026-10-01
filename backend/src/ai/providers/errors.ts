/**
 * Provider errors
 * ===============
 * One error type for every provider so retry and fallback logic never has to
 * know which vendor SDK threw.
 *
 * `retryable` means "the same request may succeed later" (rate limit, overload,
 * timeout, network). Auth and bad-request errors are not retryable: retrying a
 * wrong key only burns time, and falling back would hide a configuration bug.
 */

export interface LlmProviderErrorOptions {
  /** Delay requested by the provider (Retry-After), in milliseconds */
  retryAfterMs?: number;
  cause?: unknown;
}

export class LlmProviderError extends Error {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable: boolean = false,
    options: LlmProviderErrorOptions = {}
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LlmProviderError';
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/** HTTP statuses where trying again later can work */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** The caller cancelled a stream (for example the browser disconnected). Not a provider failure. */
export class StreamAbortedError extends Error {
  constructor() {
    super('Stream aborted by the caller');
    this.name = 'StreamAbortedError';
  }
}

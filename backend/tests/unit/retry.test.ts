import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/ai/providers/retry.js';
import { LlmProviderError } from '../../src/ai/providers/errors.js';

const noSleep = () => Promise.resolve();
const retryable = () => new LlmProviderError('busy', 'test', 429, true);

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable error and then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(retryable()).mockResolvedValue('ok');
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable error (e.g. 401)', async () => {
    const auth = new LlmProviderError('bad key', 'test', 401, false);
    const fn = vi.fn().mockRejectedValue(auth);
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1, sleep: noSleep })).rejects.toBe(auth);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry errors that are not provider errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bug'));
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1, sleep: noSleep })).rejects.toThrow('bug');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(retryable());
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, sleep: noSleep })).rejects.toBeInstanceOf(LlmProviderError);
    expect(fn).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });

  it('backs off exponentially with jitter and caps the delay', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(retryable());
    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 250,
      random: () => 1, // no jitter reduction: delay = full backoff
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => undefined);
    expect(delays).toEqual([100, 200, 250]);
  });

  it('honours Retry-After from the provider when present', async () => {
    const delays: number[] = [];
    const err = new LlmProviderError('slow down', 'test', 429, true, { retryAfterMs: 1500 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    await withRetry(fn, {
      maxRetries: 1,
      baseDelayMs: 10,
      maxDelayMs: 10_000,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(delays).toEqual([1500]);
  });
});

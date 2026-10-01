import { describe, it, expect, vi } from 'vitest';
import { ResilientProvider } from '../../src/ai/providers/resilient.provider.js';
import { LlmProviderError } from '../../src/ai/providers/errors.js';
import type { LlmProvider } from '../../src/ai/providers/llmProvider.interface.js';

const noSleep = () => Promise.resolve();
const retry = { maxRetries: 2, baseDelayMs: 1, sleep: noSleep };

function fake(name: string, overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    name,
    isConfigured: () => true,
    embed: vi.fn().mockResolvedValue({ embedding: [0], tokenCount: 1 }),
    embedBatch: vi.fn().mockResolvedValue([{ embedding: [0], tokenCount: 1 }]),
    complete: vi.fn().mockResolvedValue({ content: name, inputTokens: 1, outputTokens: 1, model: name }),
    ...overrides,
  };
}

const busy = () => new LlmProviderError('busy', 'primary', 503, true);

describe('ResilientProvider', () => {
  it('passes through to the primary on success', async () => {
    const primary = fake('primary');
    const result = await new ResilientProvider(primary, { retry }).complete({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.content).toBe('primary');
  });

  it('retries the primary before giving up', async () => {
    const complete = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue({ content: 'ok', inputTokens: 1, outputTokens: 1, model: 'p' });
    const primary = fake('primary', { complete });
    const result = await new ResilientProvider(primary, { retry }).complete({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.content).toBe('ok');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('uses the fallback only after the primary exhausts its retries on a retryable error', async () => {
    const complete = vi.fn().mockRejectedValue(busy());
    const primary = fake('primary', { complete });
    const fallback = fake('fallback');
    const result = await new ResilientProvider(primary, { retry, fallback }).complete({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.content).toBe('fallback');
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('does not use the fallback for non-retryable errors (a bad key is a config bug, not an outage)', async () => {
    const auth = new LlmProviderError('bad key', 'primary', 401, false);
    const primary = fake('primary', { complete: vi.fn().mockRejectedValue(auth) });
    const fallback = fake('fallback');

    await expect(
      new ResilientProvider(primary, { retry, fallback }).complete({ systemPrompt: 's', userPrompt: 'u' })
    ).rejects.toBe(auth);
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('throws the typed error when there is no fallback', async () => {
    const primary = fake('primary', { complete: vi.fn().mockRejectedValue(busy()) });
    await expect(new ResilientProvider(primary, { retry }).complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toBeInstanceOf(
      LlmProviderError
    );
  });

  it('surfaces the primary error if the fallback also fails', async () => {
    const primary = fake('primary', { complete: vi.fn().mockRejectedValue(busy()) });
    const fallback = fake('fallback', { complete: vi.fn().mockRejectedValue(new LlmProviderError('down', 'fallback', 500, true)) });
    const err = await new ResilientProvider(primary, { retry, fallback }).complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
  });

  it('never falls back for embeddings: vectors from different models are not comparable', async () => {
    const embed = vi.fn().mockRejectedValue(busy());
    const primary = fake('primary', { embed });
    const fallback = fake('fallback');
    await expect(new ResilientProvider(primary, { retry, fallback }).embed('x')).rejects.toBeInstanceOf(LlmProviderError);
    expect(fallback.embed).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(3); // still retried
  });

  it('reports the primary provider name and configuration', () => {
    const wrapper = new ResilientProvider(fake('primary', { isConfigured: () => false }), { retry });
    expect(wrapper.name).toBe('primary');
    expect(wrapper.isConfigured()).toBe(false);
  });
});

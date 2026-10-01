import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../../src/ai/providers/anthropic.provider.js';
import { LlmProviderError } from '../../src/ai/providers/errors.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const okBody = {
  content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }],
  usage: { input_tokens: 12, output_tokens: 3 },
  model: 'test-model',
};

function provider(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  return new AnthropicProvider({ apiKey: 'sk-ant-test', model: 'test-model', fetchImpl, ...overrides });
}

describe('AnthropicProvider', () => {
  it('is only configured when it has an API key', () => {
    expect(provider(vi.fn()).isConfigured()).toBe(true);
    expect(new AnthropicProvider({ apiKey: undefined, model: 'm' }).isConfigured()).toBe(false);
  });

  it('maps a completion to the shared CompletionResult shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const result = await provider(fetchImpl as unknown as typeof fetch).complete({
      systemPrompt: 'sys',
      userPrompt: 'hi',
      maxTokens: 50,
      temperature: 0.2,
      stopSequences: ['END'],
    });

    expect(result).toEqual({ content: 'Hello world', inputTokens: 12, outputTokens: 3, model: 'test-model' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBeTruthy();
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'test-model',
      system: 'sys',
      max_tokens: 50,
      stop_sequences: ['END'],
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('does not send temperature by default: the live API rejects it for current Claude models (400)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await provider(fetchImpl as unknown as typeof fetch).complete({ systemPrompt: 's', userPrompt: 'u', temperature: 0.2 });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).not.toHaveProperty('temperature');
  });

  it('sends temperature only when it is configured explicitly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await provider(fetchImpl as unknown as typeof fetch, { temperature: 0.4 }).complete({ systemPrompt: 's', userPrompt: 'u' });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).temperature).toBe(0.4);
  });

  it('marks 429 and 5xx as retryable and passes Retry-After through', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'slow' } }, { status: 429, headers: { 'retry-after': '2' } }));
    const err = await provider(fetchImpl as unknown as typeof fetch)
      .complete({ systemPrompt: 's', userPrompt: 'u' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err).toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000, provider: 'anthropic' });

    const serverErr = await provider(vi.fn().mockResolvedValue(jsonResponse({}, { status: 503 })) as unknown as typeof fetch)
      .complete({ systemPrompt: 's', userPrompt: 'u' })
      .catch((e) => e);
    expect(serverErr.retryable).toBe(true);
  });

  it('treats auth and bad-request errors as non-retryable and never leaks the key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'invalid x-api-key' } }, { status: 401 }));
    const err = await provider(fetchImpl as unknown as typeof fetch)
      .complete({ systemPrompt: 's', userPrompt: 'u' })
      .catch((e) => e);

    expect(err).toMatchObject({ status: 401, retryable: false });
    expect(String(err.message)).not.toContain('sk-ant-test');
  });

  it('treats network failures and timeouts as retryable', async () => {
    const down = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const err = await provider(down as unknown as typeof fetch)
      .complete({ systemPrompt: 's', userPrompt: 'u' })
      .catch((e) => e);
    expect(err).toMatchObject({ retryable: true, provider: 'anthropic' });

    const hang = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    const timedOut = await provider(hang as unknown as typeof fetch, { timeoutMs: 20 })
      .complete({ systemPrompt: 's', userPrompt: 'u' })
      .catch((e) => e);
    expect(timedOut).toMatchObject({ retryable: true });
    expect(String(timedOut.message)).toMatch(/timed out/i);
  });

  it('fails clearly when the response has no text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ content: [], usage: { input_tokens: 1, output_tokens: 0 } }));
    const err = await provider(fetchImpl as unknown as typeof fetch)
      .complete({ systemPrompt: 's', userPrompt: 'u' })
      .catch((e) => e);
    expect(err).toMatchObject({ retryable: false });
  });

  it('does not offer embeddings and says so with a non-retryable error', async () => {
    const p = provider(vi.fn() as unknown as typeof fetch);
    await expect(p.embed('x')).rejects.toMatchObject({ retryable: false, provider: 'anthropic' });
    await expect(p.embedBatch(['x'])).rejects.toBeInstanceOf(LlmProviderError);
  });
});

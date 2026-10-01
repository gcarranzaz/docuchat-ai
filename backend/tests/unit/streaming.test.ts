import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../../src/ai/providers/anthropic.provider.js';
import { MockProvider } from '../../src/ai/providers/mock.provider.js';
import { ResilientProvider } from '../../src/ai/providers/resilient.provider.js';
import { LlmProviderError, StreamAbortedError } from '../../src/ai/providers/errors.js';
import type { LlmProvider, StreamHandlers } from '../../src/ai/providers/llmProvider.interface.js';
import { runChatPipeline } from '../../src/ai/pipeline/chatPipeline.js';
import type { ChunkWithScore } from '../../src/types/index.js';

const noSleep = () => Promise.resolve();
const retry = { maxRetries: 2, baseDelayMs: 1, sleep: noSleep };
const sse = (events: Array<[string, unknown]>) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');

/** A fetch that answers with a streamed body, split into byte chunks of the given size */
function streamingFetch(body: string, splitEvery = 17) {
  return vi.fn().mockImplementation(async () => {
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += splitEvery) controller.enqueue(bytes.slice(i, i + splitEvery));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

const anthropicStream = sse([
  ['message_start', { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 42 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['ping', { type: 'ping' }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wörld ✓' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
  ['message_stop', { type: 'message_stop' }],
]);

describe('AnthropicProvider.stream', () => {
  it('emits text deltas in order and returns the full result with usage', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl: streamingFetch(anthropicStream) });
    const tokens: string[] = [];
    const result = await provider.stream({ systemPrompt: 's', userPrompt: 'u' }, { onToken: (t) => tokens.push(t) });

    expect(tokens).toEqual(['Hello ', 'wörld ✓']);
    expect(result).toEqual({ content: 'Hello wörld ✓', inputTokens: 42, outputTokens: 7, model: 'claude-test' });
  });

  it('parses the same stream whatever the chunk boundaries (even mid-multibyte-character)', async () => {
    for (const size of [1, 2, 5, 64, 10_000]) {
      const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl: streamingFetch(anthropicStream, size) });
      const result = await provider.stream({ systemPrompt: 's', userPrompt: 'u' }, { onToken: () => undefined });
      expect(result.content).toBe('Hello wörld ✓');
    }
  });

  it('asks for a stream', async () => {
    const fetchImpl = streamingFetch(anthropicStream);
    await new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl }).stream({ systemPrompt: 's', userPrompt: 'u' }, { onToken: () => undefined });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body).stream).toBe(true);
  });

  it('turns a mid-stream error event into a typed provider error (overloaded = retryable)', async () => {
    const body = sse([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
      ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } }],
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ]);
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl: streamingFetch(body) });
    const err = await provider.stream({ systemPrompt: 's', userPrompt: 'u' }, { onToken: () => undefined }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err.retryable).toBe(true);
  });

  it('maps HTTP errors before the stream starts like complete() does', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":{"message":"bad key"}}', { status: 401 })) as unknown as typeof fetch;
    const err = await new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl })
      .stream({ systemPrompt: 's', userPrompt: 'u' }, { onToken: () => undefined })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 401, retryable: false });
  });

  it('stops with StreamAbortedError when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        )
    ) as unknown as typeof fetch;
    const pending = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl }).stream(
      { systemPrompt: 's', userPrompt: 'u' },
      { onToken: () => undefined, signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(StreamAbortedError);
  });

  it('refuses to start without an API key', async () => {
    const err = await new AnthropicProvider({ apiKey: undefined, model: 'm' })
      .stream({ systemPrompt: 's', userPrompt: 'u' }, { onToken: () => undefined })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
  });
});

describe('MockProvider.stream', () => {
  it('streams pieces that concatenate to exactly what complete() returns', async () => {
    const mock = new MockProvider();
    const params = { systemPrompt: 's', userPrompt: 'hello there' };
    const pieces: string[] = [];
    const streamed = await mock.stream(params, { onToken: (t) => pieces.push(t) });
    const full = await mock.complete(params);

    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.join('')).toBe(full.content);
    expect(streamed.content).toBe(full.content);
  });

  it('stops promptly when aborted', async () => {
    const controller = new AbortController();
    const pieces: string[] = [];
    const pending = new MockProvider().stream(
      { systemPrompt: 's', userPrompt: 'hello there' },
      {
        onToken: (t) => {
          pieces.push(t);
          if (pieces.length === 2) controller.abort();
        },
        signal: controller.signal,
      }
    );
    await expect(pending).rejects.toBeInstanceOf(StreamAbortedError);
    expect(pieces.length).toBeLessThan(10);
  });
});

type StreamFn = (params: unknown, handlers: StreamHandlers) => Promise<{ content: string; inputTokens: number; outputTokens: number; model: string }>;

function fakeProvider(name: string, stream: StreamFn): LlmProvider {
  return {
    name,
    isConfigured: () => true,
    embed: vi.fn(),
    embedBatch: vi.fn(),
    complete: vi.fn(),
    stream: stream as LlmProvider['stream'],
  };
}
const busy = () => new LlmProviderError('busy', 'primary', 503, true);
const done = { content: 'ok', inputTokens: 1, outputTokens: 1, model: 'm' };
const call = { systemPrompt: 's', userPrompt: 'u' };

describe('ResilientProvider.stream', () => {
  it('retries when the failure happens before any token reached the caller', async () => {
    const stream = vi
      .fn<Parameters<StreamFn>, ReturnType<StreamFn>>()
      .mockRejectedValueOnce(busy())
      .mockImplementation(async (_p, h) => {
        h.onToken('hi');
        return done;
      });
    const tokens: string[] = [];
    const result = await new ResilientProvider(fakeProvider('p', stream), { retry }).stream(call, { onToken: (t) => tokens.push(t) });

    expect(result).toEqual(done);
    expect(tokens).toEqual(['hi']);
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry once tokens were emitted: a second answer would be stacked on the first', async () => {
    const stream = vi.fn<Parameters<StreamFn>, ReturnType<StreamFn>>().mockImplementation(async (_p, h) => {
      h.onToken('partial ');
      throw busy();
    });
    const tokens: string[] = [];
    const err = await new ResilientProvider(fakeProvider('p', stream), { retry }).stream(call, { onToken: (t) => tokens.push(t) }).catch((e) => e);

    expect(err).toBeInstanceOf(LlmProviderError);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(['partial ']);
  });

  it('falls back when nothing was emitted', async () => {
    const primary = fakeProvider('primary', vi.fn().mockRejectedValue(busy()));
    const fallbackStream = vi.fn<Parameters<StreamFn>, ReturnType<StreamFn>>().mockImplementation(async (_p, h) => {
      h.onToken('from fallback');
      return { ...done, model: 'fb' };
    });
    const result = await new ResilientProvider(primary, { retry, fallback: fakeProvider('fallback', fallbackStream) }).stream(call, {
      onToken: () => undefined,
    });
    expect(result.model).toBe('fb');
  });

  it('does not fall back after tokens were emitted', async () => {
    const emitting = fakeProvider('primary', async (_p, h) => {
      h.onToken('x');
      throw busy();
    });
    const fallbackStream = vi.fn();
    await expect(
      new ResilientProvider(emitting, { retry, fallback: fakeProvider('fallback', fallbackStream) }).stream(call, { onToken: () => undefined })
    ).rejects.toBeInstanceOf(LlmProviderError);
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it('passes an abort straight through, without retrying', async () => {
    const stream = vi.fn().mockRejectedValue(new StreamAbortedError());
    await expect(new ResilientProvider(fakeProvider('p', stream), { retry }).stream(call, { onToken: () => undefined })).rejects.toBeInstanceOf(
      StreamAbortedError
    );
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

function scored(index: number, content: string): ChunkWithScore {
  return {
    score: 0.9,
    chunk: { id: `id-${index}`, documentId: 'd', userId: 'u', chunkIndex: index, content, tokenCount: null, embedding: null, metadata: {}, createdAt: new Date(0) },
  };
}

describe('chat pipeline in streaming mode', () => {
  it('streams only the answer text (not the JSON) and still returns the validated result', async () => {
    const reply = JSON.stringify({ answer: 'Revenue grew 20% [chunk-0].', citations: [0], confidence: 'HIGH', reasoning: 'direct' });
    const provider = fakeProvider('p', async (_p, h) => {
      for (let i = 0; i < reply.length; i += 6) h.onToken(reply.slice(i, i + 6));
      return { content: reply, inputTokens: 10, outputTokens: 5, model: 'm' };
    });
    const drafts: string[] = [];

    const result = await runChatPipeline({
      question: 'q',
      chunks: [scored(0, 'Revenue grew 20%.')],
      provider,
      stream: { onToken: (t) => drafts.push(t) },
    });

    expect(drafts.join('')).toBe('Revenue grew 20% [chunk-0].');
    expect(drafts.join('')).not.toContain('{');
    expect(result.answer).toBe('Revenue grew 20% [chunk-0].');
    expect(result.citations.map((c) => c.chunkId)).toEqual(['id-0']);
  });

  it('works end to end with the mock provider', async () => {
    const drafts: string[] = [];
    const result = await runChatPipeline({
      question: 'What is the revenue?',
      chunks: [scored(0, 'Revenue grew 20%.'), scored(1, 'Headcount flat.')],
      provider: new MockProvider(),
      stream: { onToken: (t) => drafts.push(t) },
    });
    expect(drafts.length).toBeGreaterThan(2);
    expect(drafts.join('')).toBe(result.answer);
  });

  it('a draft that fails validation is replaced by a repair attempt that is not streamed', async () => {
    const good = JSON.stringify({ answer: 'Fixed answer', citations: [], confidence: 'LOW' });
    const stream: StreamFn = async (_p, h) => {
      h.onToken('{"answer": "draft');
      return { content: '{"answer": "draft', inputTokens: 1, outputTokens: 1, model: 'm' }; // truncated JSON
    };
    const complete = vi.fn().mockResolvedValue({ content: good, inputTokens: 1, outputTokens: 1, model: 'm' });
    const provider = { ...fakeProvider('p', stream), complete };
    const drafts: string[] = [];

    const result = await runChatPipeline({ question: 'q', chunks: [scored(0, 'x')], provider, stream: { onToken: (t) => drafts.push(t) } });

    expect(drafts.join('')).toBe('draft'); // what the user briefly saw
    expect(result.answer).toBe('Fixed answer'); // the result is the truth; the client replaces the draft
    expect(result.repaired).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSseBuffer, streamChat } from './chatStream';
import type { ChatResponse } from '../types';

const sse = (events: Array<[string, unknown]>) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const RESULT: ChatResponse = {
  answer: 'Revenue grew 20%.',
  sessionId: 's1',
  messageId: 'm1',
  citations: [],
  grounded: true,
  confidence: { score: 0.9, level: 'HIGH', description: 'Direct answer found in documents' },
  metadata: { chunksRetrieved: 1, tokensUsed: 10, promptVersion: 'chat_rag:v3.0', model: 'mock' },
};

function streamResponse(body: string, split = 13, init: ResponseInit = { status: 200 }) {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    },
  });
  return new Response(stream, { ...init, headers: { 'content-type': 'text/event-stream' } });
}

describe('parseSseBuffer', () => {
  it('returns complete events and keeps the unfinished tail', () => {
    const { events, rest } = parseSseBuffer('event: token\ndata: {"text":"a"}\n\nevent: token\ndata: {"te');
    expect(events).toEqual([{ event: 'token', data: { text: 'a' } }]);
    expect(rest).toBe('event: token\ndata: {"te');
  });

  it('skips heartbeat comments and malformed events', () => {
    const { events } = parseSseBuffer(': ping\n\nevent: token\ndata: not json\n\nevent: status\ndata: {"phase":"generating"}\n\n');
    expect(events).toEqual([{ event: 'status', data: { phase: 'generating' } }]);
  });

  it('handles CRLF line endings', () => {
    const { events } = parseSseBuffer('event: status\r\ndata: {"phase":"x"}\r\n\r\n');
    expect(events).toHaveLength(1);
  });
});

describe('streamChat', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    localStorage.setItem('accessToken', 'access-1');
    localStorage.setItem('refreshToken', 'refresh-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const handlers = () => ({ onStatus: vi.fn(), onToken: vi.fn(), onResult: vi.fn() });

  it('delivers status, tokens in order and the result, whatever the chunk size', async () => {
    const body = sse([
      ['status', { phase: 'generating' }],
      ['token', { text: 'Revenue ' }],
      ['token', { text: 'grew 20%.' }],
      ['result', RESULT],
    ]);
    for (const split of [1, 7, 4096]) {
      fetchMock.mockResolvedValueOnce(streamResponse(body, split));
      const h = handlers();
      const outcome = await streamChat({ question: 'q' }, h, new AbortController().signal);

      expect(outcome).toEqual({ ok: true });
      expect(h.onStatus).toHaveBeenCalledWith('generating');
      expect(h.onToken.mock.calls.map((c) => c[0]).join('')).toBe('Revenue grew 20%.');
      expect(h.onResult).toHaveBeenCalledWith(RESULT);
    }
  });

  it('sends the token and the request body', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(sse([['result', RESULT]])));
    await streamChat({ question: 'hello', sessionId: 's1', documentIds: ['d1'], regenerate: true }, handlers(), new AbortController().signal);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/chat\/stream$/);
    expect(init.headers.Authorization).toBe('Bearer access-1');
    expect(JSON.parse(init.body)).toEqual({ question: 'hello', sessionId: 's1', documentIds: ['d1'], regenerate: true });
  });

  it('turns a refusal before the stream (HTTP 429) into a typed error with Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '12' },
      })
    );
    const outcome = await streamChat({ question: 'q' }, handlers(), new AbortController().signal);
    expect(outcome).toEqual({ ok: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Slow down' }, retryAfterSeconds: 12 });
  });

  it('reports an error event from inside the stream', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(sse([['status', { phase: 'generating' }], ['token', { text: 'par' }], ['error', { code: 'INTERNAL_ERROR', message: 'boom' }]])));
    const outcome = await streamChat({ question: 'q' }, handlers(), new AbortController().signal);
    expect(outcome).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } });
  });

  it('detects a stream that ended without a result (dropped connection)', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(sse([['status', { phase: 'generating' }], ['token', { text: 'half an ans' }]])));
    const outcome = await streamChat({ question: 'q' }, handlers(), new AbortController().signal);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'STREAM_INTERRUPTED' } });
  });

  it('refreshes an expired session once and retries', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tokens: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(streamResponse(sse([['result', RESULT]])));

    const outcome = await streamChat({ question: 'q' }, handlers(), new AbortController().signal);

    expect(outcome).toEqual({ ok: true });
    expect(localStorage.getItem('accessToken')).toBe('access-2'); // the real token, not "undefined"
    expect(fetchMock.mock.calls[2]![1].headers.Authorization).toBe('Bearer access-2');
  });

  it('gives up with UNAUTHORIZED and clears the tokens when the refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const outcome = await streamChat({ question: 'q' }, handlers(), new AbortController().signal);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(localStorage.getItem('accessToken')).toBeNull();
  });

  it('reports an abort as aborted, not as an error', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    );
    const pending = streamChat({ question: 'q' }, handlers(), controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, aborted: true });
  });

  it('reports a network failure as retryable NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await streamChat({ question: 'q' }, handlers(), new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_ERROR' },
    });
  });
});

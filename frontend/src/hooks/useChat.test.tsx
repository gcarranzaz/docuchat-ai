import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatStream, describeError } from './useChat';
import { streamChat } from '../api/chatStream';
import { chatApi } from '../api/client';
import type { StreamHandlers, StreamOutcome } from '../api/chatStream';
import type { ChatResponse } from '../types';

vi.mock('../api/chatStream', () => ({ streamChat: vi.fn() }));
vi.mock('../api/client', () => ({ chatApi: { setFeedback: vi.fn(), clearFeedback: vi.fn() } }));

const streamMock = vi.mocked(streamChat);

const RESULT: ChatResponse = {
  answer: 'Revenue grew 20% [chunk-0].',
  sessionId: 'session-1',
  messageId: 'msg-1',
  citations: [{ chunkId: 'c1', text: 'Q3 revenue grew 20 percent', relevance: 0.9 }],
  grounded: true,
  confidence: { score: 0.9, level: 'HIGH', description: 'Direct answer found in documents' },
  metadata: { chunksRetrieved: 1, tokensUsed: 10, promptVersion: 'chat_rag:v3.0', model: 'mock' },
};

/** A stream that the test finishes by hand, so intermediate states can be inspected */
function controllableStream() {
  let handlers!: StreamHandlers;
  let finish!: (outcome: StreamOutcome) => void;
  let signal!: AbortSignal;
  streamMock.mockImplementationOnce((_request, h, s) => {
    handlers = h;
    signal = s;
    return new Promise<StreamOutcome>((resolve) => (finish = resolve));
  });
  return {
    status: (phase: string) => act(() => handlers.onStatus?.(phase)),
    token: (text: string) => act(() => handlers.onToken(text)),
    result: (result: ChatResponse = RESULT) =>
      act(async () => {
        handlers.onResult(result);
        finish({ ok: true });
      }),
    fail: (outcome: Extract<StreamOutcome, { ok: false }>) => act(async () => finish(outcome)),
    get signal() {
      return signal;
    },
  };
}

beforeEach(() => {
  streamMock.mockReset();
  vi.mocked(chatApi.setFeedback).mockReset().mockResolvedValue({ data: {} });
  vi.mocked(chatApi.clearFeedback).mockReset().mockResolvedValue({ data: undefined });
});

describe('useChatStream: a successful answer', () => {
  it('shows the question, a draft that grows token by token, then replaces it with the validated answer', async () => {
    const stream = controllableStream();
    const { result } = renderHook(() => useChatStream(['d1']));

    act(() => void result.current.send('How did revenue change?'));
    await waitFor(() => expect(result.current.phase).toBe('searching'));
    expect(result.current.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.current.messages[1]).toMatchObject({ content: '', streaming: true });

    stream.status('generating');
    expect(result.current.phase).toBe('writing');

    stream.token('Revenue ');
    stream.token('gr');
    expect(result.current.messages[1]!.content).toBe('Revenue gr');
    expect(result.current.messages[1]!.streaming).toBe(true);
    expect(result.current.messages[1]!.citations).toBeUndefined(); // no sources until the answer is complete

    await stream.result();
    const final = result.current.messages[1]!;
    expect(final).toMatchObject({
      id: 'msg-1',
      content: 'Revenue grew 20% [chunk-0].', // the validated text, not the draft
      grounded: true,
      confidenceLevel: 'HIGH',
      rating: null,
    });
    expect(final.streaming).toBeUndefined();
    expect(final.citations).toHaveLength(1);
    expect(result.current.phase).toBe('idle');
    expect(result.current.sessionId).toBe('session-1');
  });

  it('continues the same conversation: the session id and the documents go with the next question', async () => {
    const first = controllableStream();
    const { result } = renderHook(() => useChatStream(['d1', 'd2']));
    act(() => void result.current.send('First?'));
    await first.result();

    controllableStream();
    act(() => void result.current.send('Second?'));

    await waitFor(() => expect(streamMock).toHaveBeenCalledTimes(2));
    expect(streamMock.mock.calls[1]![0]).toMatchObject({ question: 'Second?', sessionId: 'session-1', documentIds: ['d1', 'd2'] });
    expect(streamMock.mock.calls[0]![0]).not.toHaveProperty('sessionId');
  });

  it('ignores a second question while one is being answered, and empty questions', async () => {
    controllableStream();
    const { result } = renderHook(() => useChatStream([]));
    act(() => void result.current.send('First?'));
    act(() => void result.current.send('Second?'));
    act(() => void result.current.send('   '));

    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

describe('useChatStream: failures', () => {
  it('discards the half-written draft, keeps the question, and offers a retry', async () => {
    const stream = controllableStream();
    const { result } = renderHook(() => useChatStream([]));
    act(() => void result.current.send('How did revenue change?'));
    stream.token('Revenue gr');

    await stream.fail({ ok: false, error: { code: 'STREAM_INTERRUPTED', message: 'The connection was interrupted before the answer finished.' } });

    expect(result.current.messages.map((m) => m.role)).toEqual(['user']); // the draft is gone
    expect(result.current.error).toMatchObject({ code: 'STREAM_INTERRUPTED', retryable: true });
    expect(result.current.phase).toBe('idle');
  });

  it('retry asks the same question again without repeating it in the conversation', async () => {
    const first = controllableStream();
    const { result } = renderHook(() => useChatStream([]));
    act(() => void result.current.send('How did revenue change?'));
    await first.fail({ ok: false, error: { code: 'NETWORK_ERROR', message: 'Cannot reach the server.' } });

    const second = controllableStream();
    act(() => result.current.retry());
    await second.result();

    expect(streamMock.mock.calls[1]![0]).toMatchObject({ question: 'How did revenue change?' });
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(result.current.messages[result.current.messages.length - 1]!.content).toBe(RESULT.answer);
    expect(result.current.error).toBeNull();
  });

  it('describes a rate limit with the wait time, and a budget limit as not retryable', () => {
    expect(describeError({ code: 'RATE_LIMIT_EXCEEDED', message: 'x' }, 12)).toMatchObject({ retryable: true, message: expect.stringMatching(/12 seconds/) });
    expect(describeError({ code: 'RATE_LIMIT_EXCEEDED', message: 'x' }, 1).message).toMatch(/1 second\b/);
    const budget = describeError({ code: 'DAILY_TOKEN_BUDGET_EXCEEDED', message: 'Daily AI usage limit reached. It resets at 2026-10-02T00:00:00.000Z.' });
    expect(budget.retryable).toBe(false);
    expect(budget.message).toMatch(/resets at/); // the server says when
  });

  it('never shows an internal error message to the user', () => {
    expect(describeError({ code: 'SOMETHING_ODD', message: 'stack trace: at Object.<anonymous>' }).message).not.toMatch(/stack trace/);
  });
});

describe('useChatStream: stop', () => {
  it('aborts the request and keeps the partial text, marked as stopped', async () => {
    const stream = controllableStream();
    const { result } = renderHook(() => useChatStream([]));
    act(() => void result.current.send('How did revenue change?'));
    stream.token('Revenue gr');

    act(() => result.current.stop());
    expect(stream.signal.aborted).toBe(true);
    await stream.fail({ ok: false, aborted: true, error: { code: 'ABORTED', message: 'Stopped.' } });

    expect(result.current.messages[1]).toMatchObject({ content: 'Revenue gr', stopped: true, streaming: false });
    expect(result.current.error).toBeNull(); // stopping is not an error
    expect(result.current.phase).toBe('idle');
  });

  it('removes the empty bubble when nothing had arrived yet', async () => {
    const stream = controllableStream();
    const { result } = renderHook(() => useChatStream([]));
    act(() => void result.current.send('Q?'));
    act(() => result.current.stop());
    await stream.fail({ ok: false, aborted: true, error: { code: 'ABORTED', message: 'Stopped.' } });

    expect(result.current.messages.map((m) => m.role)).toEqual(['user']);
  });
});

describe('useChatStream: regenerate and new conversation', () => {
  it('asks the same question again as a new attempt and keeps both answers', async () => {
    const first = controllableStream();
    const { result } = renderHook(() => useChatStream([]));
    act(() => void result.current.send('How did revenue change?'));
    await first.result();

    const second = controllableStream();
    act(() => result.current.regenerate('msg-1'));
    await second.result({ ...RESULT, messageId: 'msg-2', answer: 'A second attempt.' });

    expect(streamMock.mock.calls[1]![0]).toMatchObject({ question: 'How did revenue change?', regenerate: true, sessionId: 'session-1' });
    expect(result.current.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(result.current.messages.map((m) => m.content)).toEqual(['How did revenue change?', RESULT.answer, 'A second attempt.']);
  });

  it('starts over with no conversation', async () => {
    const first = controllableStream();
    const { result } = renderHook(() => useChatStream([]));
    act(() => void result.current.send('Q?'));
    await first.result();

    act(() => result.current.reset());
    expect(result.current.messages).toEqual([]);
    expect(result.current.sessionId).toBeNull();

    controllableStream();
    act(() => void result.current.send('New topic?'));
    await waitFor(() => expect(streamMock).toHaveBeenCalledTimes(2));
    expect(streamMock.mock.calls[1]![0]).not.toHaveProperty('sessionId');
  });
});

describe('useChatStream: feedback', () => {
  async function withAnswer() {
    const stream = controllableStream();
    const hook = renderHook(() => useChatStream([]));
    act(() => void hook.result.current.send('Q?'));
    await stream.result();
    return hook;
  }

  it('shows the vote at once and saves it', async () => {
    const { result } = await withAnswer();
    await act(() => result.current.rate('msg-1', 'up'));
    expect(chatApi.setFeedback).toHaveBeenCalledWith('msg-1', 'up');
    expect(result.current.messages[1]!.rating).toBe('up');
  });

  it('pressing the same vote again clears it', async () => {
    const { result } = await withAnswer();
    await act(() => result.current.rate('msg-1', 'down'));
    await act(() => result.current.rate('msg-1', 'down'));
    expect(chatApi.clearFeedback).toHaveBeenCalledWith('msg-1');
    expect(result.current.messages[1]!.rating).toBeNull();
  });

  it('puts the previous vote back and says so if saving fails', async () => {
    const { result } = await withAnswer();
    vi.mocked(chatApi.setFeedback).mockResolvedValueOnce({ error: { code: 'X', message: 'nope' } });
    await act(() => result.current.rate('msg-1', 'up'));
    expect(result.current.messages[1]!.rating).toBeNull();
    expect(result.current.error?.code).toBe('FEEDBACK_FAILED');
  });
});

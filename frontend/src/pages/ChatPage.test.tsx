import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatPage from './ChatPage';
import { documentApi } from '../api/client';
import { streamChat } from '../api/chatStream';
import type { StreamHandlers, StreamOutcome } from '../api/chatStream';
import type { ChatResponse } from '../types';

vi.mock('../api/client', () => ({
  documentApi: { list: vi.fn(), delete: vi.fn(), createText: vi.fn(), uploadPdf: vi.fn() },
  chatApi: { setFeedback: vi.fn().mockResolvedValue({ data: {} }), clearFeedback: vi.fn().mockResolvedValue({ data: undefined }) },
}));
vi.mock('../api/chatStream', () => ({ streamChat: vi.fn() }));

const DOC = { id: 'd1', title: 'Q3 Report', mimeType: 'text/plain', chunkCount: 3, summary: null, keyTopics: null, documentType: null, createdAt: '2026-01-01' };

const RESULT: ChatResponse = {
  answer: 'Revenue grew 20%.',
  sessionId: 's1',
  messageId: 'm1',
  citations: [{ chunkId: 'c1', text: 'Q3 revenue grew 20 percent', relevance: 0.9 }],
  grounded: true,
  confidence: { score: 0.9, level: 'HIGH', description: 'Direct answer found in documents' },
  metadata: { chunksRetrieved: 1, tokensUsed: 10, promptVersion: 'chat_rag:v3.0', model: 'mock' },
};

function controllableStream() {
  let handlers!: StreamHandlers;
  let finish!: (outcome: StreamOutcome) => void;
  vi.mocked(streamChat).mockImplementationOnce((_request, h) => {
    handlers = h;
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
  };
}

beforeEach(() => {
  vi.mocked(documentApi.list).mockReset().mockResolvedValue({ data: { documents: [DOC], total: 1 } });
  vi.mocked(streamChat).mockReset();
});

async function ask(question: string) {
  await userEvent.type(await screen.findByLabelText('Your question'), question);
  await userEvent.click(screen.getByRole('button', { name: /send question/i }));
}

describe('ChatPage: loading, empty and error states', () => {
  it('shows a loading indicator, then the documents', async () => {
    render(<ChatPage />);
    expect(screen.getByRole('status', { name: /loading your documents/i })).toBeInTheDocument();
    expect(await screen.findByText('Q3 Report')).toBeInTheDocument();
  });

  it('invites the user to upload when there are no documents, and offers no chat input', async () => {
    vi.mocked(documentApi.list).mockResolvedValue({ data: { documents: [], total: 0 } });
    render(<ChatPage />);
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument();
  });

  it('explains a failed document load and lets the user retry', async () => {
    vi.mocked(documentApi.list).mockResolvedValueOnce({ error: { code: 'NETWORK_ERROR', message: 'Network error' } });
    render(<ChatPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/network error/i);

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Q3 Report')).toBeInTheDocument();
  });

  it('tells a first-time user what to do and how answers behave', async () => {
    render(<ChatPage />);
    expect(await screen.findByText(/answers cite their sources/i)).toBeInTheDocument();
  });

  it('picks up the chunk count once background embedding finishes, without a manual reload', async () => {
    vi.mocked(documentApi.list)
      .mockReset()
      .mockResolvedValueOnce({ data: { documents: [{ ...DOC, chunkCount: 0 }], total: 1 } })
      .mockResolvedValue({ data: { documents: [{ ...DOC, chunkCount: 5 }], total: 1 } });

    render(<ChatPage />);
    expect(await screen.findByText('0 chunks')).toBeInTheDocument();
    expect(await screen.findByText('5 chunks', {}, { timeout: 4000 })).toBeInTheDocument();
  });
});

describe('ChatPage: asking a question', () => {
  it('shows the model status, streams a draft, then the answer with its sources', async () => {
    const stream = controllableStream();
    render(<ChatPage />);
    await ask('How did revenue change?');

    // searching
    expect(await screen.findByText('Searching your documents…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toBeDisabled();

    // thinking, then writing
    stream.status('generating');
    expect(await screen.findByText('Thinking…')).toBeInTheDocument();
    stream.token('Revenue gr');
    expect(await screen.findByText('Writing the answer…')).toBeInTheDocument();
    expect(screen.getByText(/Revenue gr/)).toBeInTheDocument();
    expect(screen.getByText(/Draft/)).toBeInTheDocument();

    // complete
    await stream.result();
    expect(await screen.findByText('Revenue grew 20%.')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 source/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toBeEnabled();
  });

  it('stops generation when the user presses Stop', async () => {
    const stream = controllableStream();
    render(<ChatPage />);
    await ask('How did revenue change?');
    stream.status('generating');
    stream.token('Revenue gr');

    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));
    await stream.fail({ ok: false, aborted: true, error: { code: 'ABORTED', message: 'Stopped.' } });

    expect(await screen.findByText(/not verified and has no sources/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a failure with a Try again that asks the same question', async () => {
    const first = controllableStream();
    render(<ChatPage />);
    await ask('How did revenue change?');
    await first.fail({ ok: false, error: { code: 'NETWORK_ERROR', message: 'Cannot reach the server. Check your connection and try again.' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the server/i);

    const second = controllableStream();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await second.result();

    expect(await screen.findByText('Revenue grew 20%.')).toBeInTheDocument();
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(vi.mocked(streamChat).mock.calls[1]![0].question).toBe('How did revenue change?');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains a spending limit without offering a pointless retry', async () => {
    const stream = controllableStream();
    render(<ChatPage />);
    await ask('How did revenue change?');
    await stream.fail({ ok: false, error: { code: 'DAILY_TOKEN_BUDGET_EXCEEDED', message: 'Daily AI usage limit reached. It resets at 2026-10-02T00:00:00.000Z.' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/resets at/i);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('warns about an answer that has no support in the documents', async () => {
    const stream = controllableStream();
    render(<ChatPage />);
    await ask('What is the CEO salary?');
    await stream.result({ ...RESULT, answer: 'It is probably high.', citations: [], grounded: false, confidence: { score: 0.1, level: 'LOW', description: 'Limited evidence found' } });

    expect(await screen.findByText('It is probably high.')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/could not find solid support/i);
  });

  it('puts a past question back in the input to edit it and ask again', async () => {
    const stream = controllableStream();
    render(<ChatPage />);
    await ask('How did revenue change?');
    await stream.result();

    await userEvent.click(await screen.findByRole('button', { name: /edit this question/i }));
    expect(screen.getByLabelText('Your question')).toHaveValue('How did revenue change?');
  });

  it('regenerates an answer and keeps both attempts', async () => {
    const first = controllableStream();
    render(<ChatPage />);
    await ask('How did revenue change?');
    await first.result();

    const second = controllableStream();
    await userEvent.click(await screen.findByRole('button', { name: /regenerate/i }));
    await second.result({ ...RESULT, messageId: 'm2', answer: 'A second attempt.' });

    await waitFor(() => expect(screen.getAllByTestId('assistant-message')).toHaveLength(2));
    expect(screen.getByText('A second attempt.')).toBeInTheDocument();
    expect(vi.mocked(streamChat).mock.calls[1]![0]).toMatchObject({ regenerate: true });
  });

  it('starts a new conversation', async () => {
    const stream = controllableStream();
    render(<ChatPage />);
    await ask('How did revenue change?');
    await stream.result();

    await userEvent.click(await screen.findByRole('button', { name: /new conversation/i }));
    expect(screen.queryByText('Revenue grew 20%.')).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageBubble, isUncertain } from './MessageBubble';
import type { ChatMessage } from '../../types';

const answer = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  content: 'Revenue grew 20%.',
  citations: [{ chunkId: 'c1', text: 'Q3 revenue grew 20 percent', relevance: 0.91 }],
  grounded: true,
  confidenceLevel: 'HIGH',
  confidenceScore: 0.92,
  rating: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('MessageBubble: a normal answer', () => {
  it('shows the text, the confidence and no warning', () => {
    render(<MessageBubble message={answer()} />);
    expect(screen.getByText('Revenue grew 20%.')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    expect(screen.getByText('Score: 92%')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('lets the reader open the sources and see the quoted passage', async () => {
    render(<MessageBubble message={answer()} />);
    expect(screen.queryByText(/Q3 revenue grew 20 percent/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /1 source/i }));
    expect(screen.getByText(/Q3 revenue grew 20 percent/)).toBeInTheDocument();
    expect(screen.getByText('Relevance: 91%')).toBeInTheDocument();
  });
});

describe('MessageBubble: uncertainty and hallucination', () => {
  it('warns when the answer has no supporting citation, even if the model sounded confident', () => {
    render(<MessageBubble message={answer({ grounded: false, citations: [], confidenceLevel: 'HIGH' })} />);
    expect(screen.getByRole('note')).toHaveTextContent(/could not find solid support/i);
  });

  it.each(['LOW', 'NONE'] as const)('warns on %s confidence', (level) => {
    render(<MessageBubble message={answer({ confidenceLevel: level })} />);
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('suggests what to do about it', () => {
    render(<MessageBubble message={answer({ grounded: false })} />);
    expect(screen.getByRole('note')).toHaveTextContent(/rephras/i);
  });

  it('isUncertain ignores drafts and stopped answers, which have their own labels', () => {
    expect(isUncertain(answer({ grounded: false, streaming: true }))).toBe(false);
    expect(isUncertain(answer({ grounded: false, stopped: true }))).toBe(false);
    expect(isUncertain(answer({ grounded: true, confidenceLevel: 'MEDIUM' }))).toBe(false);
    expect(isUncertain({ id: 'u', role: 'user', content: 'q', createdAt: '' })).toBe(false);
  });
});

describe('MessageBubble: while the answer is being written', () => {
  it('shows the draft, says it is a draft, and hides sources, confidence and actions', () => {
    render(<MessageBubble message={answer({ streaming: true, content: 'Revenue gr', citations: undefined, confidenceLevel: undefined })} onRegenerate={vi.fn()} onRate={vi.fn()} />);
    expect(screen.getByText(/Revenue gr/)).toBeInTheDocument();
    expect(screen.getByText(/Draft/)).toBeInTheDocument();
    expect(screen.queryByText('HIGH')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /good answer/i })).not.toBeInTheDocument();
  });

  it('marks a stopped answer as partial and unverified, with no sources', () => {
    render(<MessageBubble message={answer({ stopped: true, content: 'Revenue gr', citations: [], confidenceLevel: undefined })} />);
    expect(screen.getByRole('note')).toHaveTextContent(/stopped.*not verified/i);
  });
});

describe('MessageBubble: actions', () => {
  it('regenerates', async () => {
    const onRegenerate = vi.fn();
    render(<MessageBubble message={answer()} onRegenerate={onRegenerate} />);
    await userEvent.click(screen.getByRole('button', { name: /regenerate/i }));
    expect(onRegenerate).toHaveBeenCalledWith('a1');
  });

  it('rates up and down, and shows the current vote', async () => {
    const onRate = vi.fn();
    const { rerender } = render(<MessageBubble message={answer()} onRate={onRate} />);
    await userEvent.click(screen.getByRole('button', { name: /good answer/i }));
    await userEvent.click(screen.getByRole('button', { name: /bad answer/i }));
    expect(onRate.mock.calls).toEqual([['a1', 'up'], ['a1', 'down']]);

    rerender(<MessageBubble message={answer({ rating: 'down' })} onRate={onRate} />);
    expect(screen.getByRole('button', { name: /bad answer/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /good answer/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables regenerate while another answer is being produced', () => {
    render(<MessageBubble message={answer()} onRegenerate={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeDisabled();
  });

  it('lets the user edit and re-ask a question', async () => {
    const onEdit = vi.fn();
    const question: ChatMessage = { id: 'u1', role: 'user', content: 'How did revenue change?', createdAt: '' };
    render(<MessageBubble message={question} onEdit={onEdit} />);
    await userEvent.click(screen.getByRole('button', { name: /edit this question/i }));
    expect(onEdit).toHaveBeenCalledWith(question);
  });
});

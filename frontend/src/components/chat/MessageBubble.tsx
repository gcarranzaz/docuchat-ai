import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ChevronDown, ChevronUp, Pencil, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { ConfidenceBadge } from './ConfidenceBadge';
import type { ChatMessage, Rating } from '../../types';

interface MessageBubbleProps {
  message: ChatMessage;
  /** Ask the same question again; both attempts stay in the conversation */
  onRegenerate?: (messageId: string) => void;
  onRate?: (messageId: string, rating: Rating) => void;
  /** Put a past question back in the input to change it and ask again */
  onEdit?: (message: ChatMessage) => void;
  /** Disable the actions while another answer is being generated */
  disabled?: boolean;
}

/**
 * An answer that must not be presented as established fact: nothing in the documents
 * supports it (no valid citation), or the evidence is weak.
 */
export function isUncertain(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || message.streaming || message.stopped) return false;
  return message.grounded === false || message.confidenceLevel === 'LOW' || message.confidenceLevel === 'NONE';
}

export function MessageBubble({ message, onRegenerate, onRate, onEdit, disabled = false }: MessageBubbleProps) {
  const [showCitations, setShowCitations] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="flex justify-end items-start gap-2">
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(message)}
            disabled={disabled}
            className="mt-2 p-1 text-gray-400 hover:text-gray-700 disabled:opacity-40"
            aria-label="Edit this question and ask again"
            title="Edit and ask again"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="bg-blue-600 text-white rounded-lg px-4 py-2 max-w-md">
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  const uncertain = isUncertain(message);
  const citations = message.citations ?? [];
  const finished = !message.streaming && !message.stopped;

  return (
    <div className="flex justify-start" data-testid="assistant-message">
      <div className={clsx('rounded-lg px-4 py-2 max-w-2xl', uncertain ? 'bg-amber-50 border border-amber-200' : 'bg-gray-100')}>
        {/* The answer: a draft while it streams */}
        <p className={clsx('text-sm whitespace-pre-wrap', uncertain ? 'text-gray-700' : 'text-gray-900', message.streaming && 'text-gray-700')}>
          {message.content}
          {message.streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-gray-500 animate-pulse" aria-hidden="true" />}
        </p>

        {message.streaming && <p className="mt-1 text-xs text-gray-500">Draft: sources and confidence appear when the answer is complete.</p>}

        {message.stopped && (
          <p className="mt-1 text-xs text-gray-600" role="note">
            Stopped. This partial answer was not verified and has no sources.
          </p>
        )}

        {/* Hallucination and uncertainty: say it, do not hide it */}
        {uncertain && (
          <div className="mt-2 flex items-start gap-2 rounded bg-amber-100 px-3 py-2 text-xs text-amber-900" role="note">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p>
              I could not find solid support for this in your documents, so treat it with caution. Try rephrasing the question, or add the document that
              contains the answer.
            </p>
          </div>
        )}

        {finished && message.confidenceLevel && (
          <div className="flex items-center gap-2 mt-2">
            <ConfidenceBadge level={message.confidenceLevel} />
            {message.confidenceScore !== undefined && (
              <span className="text-xs text-gray-600">Score: {(message.confidenceScore * 100).toFixed(0)}%</span>
            )}
          </div>
        )}

        {finished && citations.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200">
            <button
              type="button"
              onClick={() => setShowCitations(!showCitations)}
              aria-expanded={showCitations}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
            >
              {showCitations ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {citations.length} source{citations.length > 1 ? 's' : ''}
            </button>
            {showCitations && (
              <ul className="mt-2 space-y-2">
                {citations.map((citation) => (
                  <li key={citation.chunkId} className="bg-white rounded p-2 text-xs">
                    <p className="text-gray-700 mb-1">&ldquo;{citation.text}&rdquo;</p>
                    <p className="text-gray-500">Relevance: {(citation.relevance * 100).toFixed(0)}%</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Actions on a finished answer */}
        {finished && (onRegenerate || onRate) && (
          <div className="mt-2 flex items-center gap-1 text-gray-500">
            {onRegenerate && (
              <button
                type="button"
                onClick={() => onRegenerate(message.id)}
                disabled={disabled}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-gray-200 disabled:opacity-40"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
                Regenerate
              </button>
            )}
            {onRate && (
              <>
                <button
                  type="button"
                  onClick={() => onRate(message.id, 'up')}
                  aria-pressed={message.rating === 'up'}
                  aria-label="Good answer"
                  title="Good answer"
                  className={clsx('p-1 rounded hover:bg-gray-200', message.rating === 'up' && 'text-green-700 bg-green-100')}
                >
                  <ThumbsUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onRate(message.id, 'down')}
                  aria-pressed={message.rating === 'down'}
                  aria-label="Bad answer"
                  title="Bad answer"
                  className={clsx('p-1 rounded hover:bg-gray-200', message.rating === 'down' && 'text-red-700 bg-red-100')}
                >
                  <ThumbsDown className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

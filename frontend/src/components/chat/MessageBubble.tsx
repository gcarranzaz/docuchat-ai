import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ConfidenceBadge } from './ConfidenceBadge';
import type { ChatMessage } from '../../types';

export function MessageBubble({ message }: { message: ChatMessage }) {
  const [showCitations, setShowCitations] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-blue-600 text-white rounded-lg px-4 py-2 max-w-md">
          <p className="text-sm">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="bg-gray-100 rounded-lg px-4 py-2 max-w-2xl">
        <p className="text-sm text-gray-900 mb-2">{message.content}</p>
        {message.confidenceLevel && (
          <div className="flex items-center gap-2 mb-2">
            <ConfidenceBadge level={message.confidenceLevel} />
            {message.confidenceScore && (
              <span className="text-xs text-gray-600">
                Score: {(message.confidenceScore * 100).toFixed(0)}%
              </span>
            )}
          </div>
        )}
        {message.citations && message.citations.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200">
            <button
              onClick={() => setShowCitations(!showCitations)}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
            >
              {showCitations ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              {message.citations.length} citation{message.citations.length > 1 ? 's' : ''}
            </button>
            {showCitations && (
              <div className="mt-2 space-y-2">
                {message.citations.map((citation, idx) => (
                  <div key={idx} className="bg-white rounded p-2 text-xs">
                    <p className="text-gray-700 mb-1">{citation.text}</p>
                    <p className="text-gray-500">
                      Relevance: {(citation.relevance * 100).toFixed(0)}%
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

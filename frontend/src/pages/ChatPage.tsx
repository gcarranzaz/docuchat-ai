/**
 * Chat Page
 * =========
 * Upload documents and ask questions about them.
 *
 * AI-aware behaviour (requirement 1.3):
 * - Model status: searching your documents → writing the answer, with a Stop button
 * - The answer streams in as a draft; sources and confidence appear when it is complete
 * - Uncertain or unsupported answers say so (see MessageBubble)
 * - Regenerate, or edit a question and ask again; thumbs up/down on answers
 * - Loading, empty and error states, including rate-limit and budget messages
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Send, FileText, AlertCircle, Loader2, X, FilePlus, Tag, Trash2, Square, RotateCcw, MessageSquarePlus } from 'lucide-react';
import clsx from 'clsx';
import { documentApi } from '../api/client';
import { useChatStream } from '../hooks/useChat';
import { MessageBubble } from '../components/chat/MessageBubble';
import { DeleteConfirmModal } from '../components/common/DeleteDocumentModal';
import type { ChatMessage } from '../types';

interface Document {
  id: string;
  title: string;
  mimeType: string;
  chunkCount: number;
  summary: string | null;
  keyTopics: string[] | null;
  documentType: string | null;
  createdAt: string;
}

type UploadMode = 'text' | 'pdf';

export default function ChatPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Upload form
  const [showUpload, setShowUpload] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>('text');
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadContent, setUploadContent] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Delete modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
  const [deleteDocTitle, setDeleteDocTitle] = useState<string | null>(null);

  const chat = useChatStream(documents.map((d) => d.id));
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const response = await documentApi.list();
    if (response.data) {
      const data = response.data as { documents: Document[]; total: number };
      setDocuments(data.documents || []);
    } else {
      setLoadError(response.error?.message || 'Your documents could not be loaded.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Follow the answer as it is written
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [chat.messages]);

  const handleUploadSubmit = async () => {
    if (!uploadTitle.trim()) {
      setUploadError('Title is required');
      return;
    }

    setUploading(true);
    setUploadError(null);

    let response;
    if (uploadMode === 'text') {
      if (!uploadContent.trim()) {
        setUploadError('Content is required');
        setUploading(false);
        return;
      }
      response = await documentApi.createText(uploadTitle, uploadContent);
    } else {
      if (!uploadFile) {
        setUploadError('File is required');
        setUploading(false);
        return;
      }
      response = await documentApi.uploadPdf(uploadTitle, uploadFile);
    }

    setUploading(false);

    if (response.error) {
      setUploadError(response.error.message || 'Upload failed');
    } else {
      setUploadTitle('');
      setUploadContent('');
      setUploadFile(null);
      setShowUpload(false);
      await loadDocuments();
    }
  };

  const handleSend = () => {
    if (!inputValue.trim() || chat.busy) return;
    const question = inputValue;
    setInputValue('');
    void chat.send(question);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /** Put a past question back in the input so it can be changed and asked again */
  const handleEdit = (message: ChatMessage) => {
    setInputValue(message.content);
    inputRef.current?.focus();
  };

  const lastMessage = chat.messages[chat.messages.length - 1];
  const statusText =
    chat.phase === 'searching'
      ? 'Searching your documents…'
      : chat.phase === 'writing'
        ? lastMessage?.streaming && lastMessage.content !== ''
          ? 'Writing the answer…'
          : 'Thinking…'
        : '';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96" role="status" aria-label="Loading your documents">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const hasDocuments = documents.length > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Document Chat</h1>
        <p className="text-gray-600">Upload documents and ask questions about their content.</p>
      </div>

      {/* Documents */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-700">Your Documents ({documents.length})</h2>
          <button
            onClick={() => setShowUpload(!showUpload)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          >
            <FilePlus className="w-4 h-4" />
            Add Document
          </button>
        </div>

        {loadError && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3" role="alert">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
            <p className="flex-1 text-sm text-red-800">{loadError}</p>
            <button onClick={() => void loadDocuments()} className="text-sm font-medium text-red-700 hover:underline">
              Try again
            </button>
          </div>
        )}

        {hasDocuments && documents[0]?.summary && (
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3 mb-3">
              <FileText className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-900 mb-1">{documents[0].title}</h3>
                {documents[0].documentType && <p className="text-xs text-gray-600 mb-2 capitalize">{documents[0].documentType}</p>}
              </div>
            </div>
            <div className="bg-white rounded-lg p-3 mb-3">
              <p className="text-sm text-gray-800 leading-relaxed">{documents[0].summary}</p>
            </div>
            {documents[0].keyTopics && documents[0].keyTopics.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {documents[0].keyTopics.map((topic, idx) => (
                  <span key={idx} className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">
                    <Tag className="w-3 h-3" />
                    {topic}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {hasDocuments && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {documents.map((doc) => (
              <div key={doc.id} className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg">
                <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{doc.title}</p>
                  <p className="text-xs text-gray-500">{doc.chunkCount} chunk{doc.chunkCount === 1 ? "" : "s"}</p>
                </div>
                <button
                  onClick={() => {
                    setShowDeleteModal(true);
                    setDeleteDocId(doc.id);
                    setDeleteDocTitle(doc.title);
                  }}
                  className="text-red-600 hover:text-red-800 p-1 transition-colors"
                  title="Delete document"
                  aria-label={`Delete document ${doc.title}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {showUpload && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <div className="flex gap-2 mb-4">
              {(['text', 'pdf'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setUploadMode(mode)}
                  className={clsx(
                    'flex-1 py-2 px-4 rounded-lg font-medium text-sm transition-colors',
                    uploadMode === mode ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  )}
                >
                  {mode === 'text' ? 'Text' : 'PDF'}
                </button>
              ))}
            </div>

            <input
              type="text"
              placeholder="Document title"
              value={uploadTitle}
              onChange={(e) => setUploadTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />

            {uploadMode === 'text' ? (
              <textarea
                placeholder="Paste your document content here..."
                value={uploadContent}
                onChange={(e) => setUploadContent(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3 h-32 resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            ) : (
              <div className="mb-3">
                <label className="flex items-center justify-center w-full px-4 py-8 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer hover:border-gray-400 transition-colors">
                  <div className="text-center">
                    <Upload className="w-8 h-8 mx-auto text-gray-400 mb-2" />
                    <p className="text-sm text-gray-600">{uploadFile ? uploadFile.name : 'Click to upload PDF'}</p>
                  </div>
                  <input type="file" accept=".pdf" className="hidden" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
                </label>
              </div>
            )}

            {uploadError && (
              <p className="mb-3 text-sm text-red-700" role="alert">
                {uploadError}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleUploadSubmit}
                disabled={uploading}
                className={clsx(
                  'flex-1 py-2 px-4 rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2',
                  uploading ? 'bg-blue-400 text-white cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'
                )}
              >
                {uploading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    Upload
                  </>
                )}
              </button>
              <button
                onClick={() => setShowUpload(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Chat error, with a way forward */}
      {chat.error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3" role="alert">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <p className="flex-1 text-sm text-red-800">{chat.error.message}</p>
          {chat.error.retryable && (
            <button onClick={chat.retry} disabled={chat.busy} className="flex items-center gap-1 text-sm font-medium text-red-700 hover:underline disabled:opacity-40">
              <RotateCcw className="w-3.5 h-3.5" />
              Try again
            </button>
          )}
          <button onClick={chat.clearError} className="text-red-600 hover:text-red-800" aria-label="Dismiss error">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Conversation */}
      {chat.messages.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <div className="flex justify-end mb-2">
            <button onClick={chat.reset} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
              <MessageSquarePlus className="w-3.5 h-3.5" />
              New conversation
            </button>
          </div>
          <div className="space-y-4 max-h-[28rem] overflow-y-auto">
            {chat.messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onRegenerate={chat.regenerate}
                onRate={chat.rate}
                onEdit={handleEdit}
                disabled={chat.busy}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Model status. aria-live so assistive technology announces the phase changes. */}
      <div className="mb-2 h-6 flex items-center gap-3" role="status" aria-live="polite">
        {chat.busy && (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" aria-hidden="true" />
            <span className="text-sm text-gray-600">{statusText}</span>
            <button onClick={chat.stop} className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-100">
              <Square className="w-3 h-3" aria-hidden="true" />
              Stop
            </button>
          </>
        )}
      </div>

      {/* Input */}
      {hasDocuments && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              placeholder="Ask a question about your documents..."
              aria-label="Your question"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={chat.busy}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
            />
            <button
              onClick={handleSend}
              disabled={chat.busy || !inputValue.trim()}
              aria-label="Send question"
              className={clsx(
                'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
                chat.busy || !inputValue.trim() ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'
              )}
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
          {chat.messages.length === 0 && (
            <p className="mt-3 text-sm text-gray-500">
              Ask anything about your documents. Answers cite their sources, and say so when the documents do not support them.
            </p>
          )}
        </div>
      )}

      {/* No documents yet */}
      {!hasDocuments && !showUpload && !loadError && (
        <div className="text-center py-12">
          <FileText className="w-16 h-16 mx-auto text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No documents yet</h3>
          <p className="text-gray-600 mb-4">Upload a document to start asking questions</p>
          <button
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Upload Document
          </button>
        </div>
      )}

      <DeleteConfirmModal
        open={showDeleteModal}
        title={deleteDocTitle || ''}
        onClose={() => {
          setShowDeleteModal(false);
          setDeleteDocId(null);
          setDeleteDocTitle(null);
        }}
        onConfirm={async () => {
          if (deleteDocId) {
            await documentApi.delete(deleteDocId);
            await loadDocuments();
          }
          setShowDeleteModal(false);
          setDeleteDocId(null);
          setDeleteDocTitle(null);
        }}
      />
    </div>
  );
}

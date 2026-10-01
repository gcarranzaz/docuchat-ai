/**
 * Chat Page - Integrated with Real API
 * =====================================
 * Main interface for document upload and AI chat with RAG.
 *
 * Features:
 * - Document upload (text + PDF)
 * - Real-time chat with citations
 * - Confidence scoring
 * - Session management
 */

import { useState, useEffect, useRef } from 'react';
import { Upload, Send, FileText, AlertCircle, Loader2, X, FilePlus, Tag, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { documentApi, chatApi } from '../api/client';

import { MessageBubble } from '../components/chat/MessageBubble';
import { DeleteConfirmModal } from '../components/common/DeleteDocumentModal';
import type { ChatMessage, Citation } from '../types';


// ===========================================
// Types
// ===========================================

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

type ChatState = 'empty' | 'ready' | 'thinking' | 'error';
type UploadMode = 'text' | 'pdf';

// ===========================================
// Main Component
// ===========================================

export default function ChatPage() {
  const [chatState, setChatState] = useState<ChatState>('empty');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Upload states
  const [showUpload, setShowUpload] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>('text');
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadContent, setUploadContent] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
  const [deleteDocTitle, setDeleteDocTitle] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load documents on mount
  useEffect(() => {
    loadDocuments();
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadDocuments = async () => {
    setLoading(true);
    const response = await documentApi.list();

    if (response.data) {
      const data = response.data as { documents: Document[]; total: number };
      setDocuments(data.documents || []);
      setChatState(data.documents?.length > 0 ? 'ready' : 'empty');
    } else {
      setError('Failed to load documents');
    }
    setLoading(false);
  };

  const handleUploadSubmit = async () => {
    if (!uploadTitle.trim()) {
      setError('Title is required');
      return;
    }

    setUploading(true);
    setError(null);

    let response;
    if (uploadMode === 'text') {
      if (!uploadContent.trim()) {
        setError('Content is required');
        setUploading(false);
        return;
      }
      response = await documentApi.createText(uploadTitle, uploadContent);
    } else {
      if (!uploadFile) {
        setError('File is required');
        setUploading(false);
        return;
      }
      response = await documentApi.uploadPdf(uploadTitle, uploadFile);
    }

    setUploading(false);

    if (response.error) {
      setError(response.error.message || 'Upload failed');
    } else {
      // Reset upload form
      setUploadTitle('');
      setUploadContent('');
      setUploadFile(null);
      setShowUpload(false);

      // Reload documents
      await loadDocuments();
    }
  };

  const handleSend = async () => {
    if (!inputValue.trim() || chatState === 'thinking') return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: inputValue,
      createdAt: new Date().toISOString(),
    };

    setMessages([...messages, userMessage]);
    setInputValue('');
    setChatState('thinking');
    setError(null);

    try {
      const response = await chatApi.sendMessage(
        userMessage.content,
        sessionId || undefined,
        documents.map((d) => d.id)
      );

      if (response.error) {
        setError(response.error.message || 'Failed to get response');
        setChatState('error');
      } else if (response.data) {
        const data = response.data as {
          sessionId: string;
          messageId: string;
          answer: string;
          citations: Citation[];
          confidenceScore: number;
          confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
        };

        // Update session ID if it's a new session
        if (!sessionId) {
          setSessionId(data.sessionId);
        }

        const assistantMessage: ChatMessage = {
          id: data.messageId,
          role: 'assistant',
          content: data.answer,
          citations: data.citations,
          confidenceScore: data.confidenceScore,
          confidenceLevel: data.confidenceLevel,
          createdAt: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, assistantMessage]);
        setChatState('ready');
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
      setChatState('error');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* Page Title */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Document Chat</h1>
        <p className="text-gray-600">Upload documents and ask questions about their content.</p>
      </div>

      {/* Documents Section */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-700">
            Your Documents ({documents.length})
          </h2>
          <button
            onClick={() => setShowUpload(!showUpload)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          >
            <FilePlus className="w-4 h-4" />
            Add Document
          </button>
        </div>

        {/* Document Summary Card */}
        {documents.length > 0 && documents[0].summary && (
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3 mb-3">
              <FileText className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-900 mb-1">
                  {documents[0].title}
                </h3>
                {documents[0].documentType && (
                  <p className="text-xs text-gray-600 mb-2 capitalize">
                    {documents[0].documentType}
                  </p>
                )}
              </div>
            </div>

            <div className="bg-white rounded-lg p-3 mb-3">
              <p className="text-sm text-gray-800 leading-relaxed">
                {documents[0].summary}
              </p>
            </div>

            {documents[0].keyTopics && documents[0].keyTopics.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {documents[0].keyTopics.map((topic, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium"
                  >
                    <Tag className="w-3 h-3" />
                    {topic}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Document List */}
        {documents.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg"
              >
                <FileText className="w-5 h-5 text-blue-600 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{doc.title}</p>
                  <p className="text-xs text-gray-500">{doc.chunkCount} chunks</p>
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

        {/* Upload Form */}
        {showUpload && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setUploadMode('text')}
                className={clsx(
                  'flex-1 py-2 px-4 rounded-lg font-medium text-sm transition-colors',
                  uploadMode === 'text'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                )}
              >
                Text
              </button>
              <button
                onClick={() => setUploadMode('pdf')}
                className={clsx(
                  'flex-1 py-2 px-4 rounded-lg font-medium text-sm transition-colors',
                  uploadMode === 'pdf'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                )}
              >
                PDF
              </button>
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
                    <p className="text-sm text-gray-600">
                      {uploadFile ? uploadFile.name : 'Click to upload PDF'}
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  />
                </label>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleUploadSubmit}
                disabled={uploading}
                className={clsx(
                  'flex-1 py-2 px-4 rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2',
                  uploading
                    ? 'bg-blue-400 text-white cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
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

      {/* Error Alert */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-red-800">{error}</p>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-red-600 hover:text-red-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Chat Messages */}
      {messages.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 max-h-96 overflow-y-auto">
          <div className="space-y-4">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Chat Input */}
      {chatState !== 'empty' && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Ask a question about your documents..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={chatState === 'thinking'}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
            />
            <button
              onClick={handleSend}
              disabled={chatState === 'thinking' || !inputValue.trim()}
              className={clsx(
                'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
                chatState === 'thinking' || !inputValue.trim()
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              )}
            >
              {chatState === 'thinking' ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Empty State */}
      {chatState === 'empty' && !showUpload && (
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

      {/* Delete Document Modal */}
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

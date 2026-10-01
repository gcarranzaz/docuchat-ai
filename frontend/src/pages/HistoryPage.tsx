/**
 * History Page - Integrated with Real API
 * ========================================
 * Displays chat history and structured extractions.
 *
 * Features:
 * - Chat Sessions list with message viewer
 * - Extractions list with JSON viewer
 * - Create new extractions
 * - Delete functionality
 */

import { useState, useEffect } from 'react';
import { DeleteConfirmModal } from '../components/common/DeleteDocumentModal';
import {
  MessageSquare,
  FileJson,
  Calendar,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  Trash2,
  Plus,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { chatApi, extractionApi, documentApi } from '../api/client';

// ===========================================
// Types
// ===========================================

interface ChatSession {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Array<{
    chunkId: string;
    text: string;
    relevance: number;
  }>;
  createdAt: string;
}

interface Extraction {
  id: string;
  documentId: string;
  schemaName: string;
  schemaVersion: string;
  extractedData: Record<string, unknown>;
  validationErrors: Array<{ path: string; message: string }>;
  confidenceScore: number | null;
  createdAt: string;
}

interface Document {
  id: string;
  title: string;
}

interface Schema {
  name: string;
  version: string;
  description: string;
}

type Tab = 'sessions' | 'extractions';

// ===========================================
// Main Component
// ===========================================

export default function HistoryPage() {
    // Modal state for extraction deletion
    const [deleteExtractionId, setDeleteExtractionId] = useState<string | null>(null);
    const [deleteExtractionTitle, setDeleteExtractionTitle] = useState<string>('');

    // Modal state for bulk delete
    const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('sessions');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chat state
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Extraction state
  const [extractions, setExtractions] = useState<Extraction[]>([]);
  const [rawExtractionsResponse, setRawExtractionsResponse] = useState<any>(null); // DEBUG
  const [showCreateExtraction, setShowCreateExtraction] = useState(false);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [schemas, setSchemas] = useState<Schema[]>([]);
  const [selectedDocId, setSelectedDocId] = useState('');
  const [selectedSchema, setSelectedSchema] = useState('');
  const [creating, setCreating] = useState(false);

  // Load data on mount and tab change
  useEffect(() => {
    if (activeTab === 'sessions') {
      loadSessions();
    } else {
      loadExtractions();
    }
  }, [activeTab]);

  const loadSessions = async () => {
    setLoading(true);
    setError(null);
    const response = await chatApi.listSessions();

    if (response.error) {
      setError(response.error.message || 'Failed to load sessions');
    } else if (response.data) {
      const data = response.data as { sessions: ChatSession[]; total: number };
      setSessions(data.sessions || []);
    }
    setLoading(false);
  };


  const loadSessionMessages = async (sessionId: string) => {
    setLoadingMessages(true);
    setSelectedSessionId(sessionId);
    const response = await chatApi.getSession(sessionId);

    if (response.error) {
      setError(response.error.message || 'Failed to load messages');
      setSessionMessages([]);
    } else if (response.data) {
      const data = response.data as { session: ChatSession; messages: ChatMessage[] };
      setSessionMessages(data.messages || []);
    }
    setLoadingMessages(false);
  };

  // Bulk delete handler (move to component scope)
  const handleDeleteAllHistory = async () => {
    setLoading(true);
    setError(null);
    let sessionErr = null;
    let extractionErr = null;
    try {
      const [sessionRes, extractionRes] = await Promise.all([
        chatApi.deleteAllSessions(),
        extractionApi.deleteAll(),
      ]);
      if (sessionRes.error) sessionErr = sessionRes.error.message;
      if (extractionRes.error) extractionErr = extractionRes.error.message;
    } catch (e) {
      setError('Failed to delete all history.');
    }
    await loadSessions();
    await loadExtractions();
    setShowDeleteAllModal(false);
    setLoading(false);
    if (sessionErr || extractionErr) {
      setError([sessionErr, extractionErr].filter(Boolean).join(' | '));
    }
  };

  const loadExtractions = async () => {
    setLoading(true);
    setError(null);

    const [extractionsRes, docsRes, schemasRes] = await Promise.all([
      extractionApi.list(),
      documentApi.list(),
      extractionApi.listSchemas(),
    ]);

    // DEBUG: Mostrar la respuesta cruda en pantalla
    setRawExtractionsResponse(extractionsRes);

    if (extractionsRes.error) {
      setError(extractionsRes.error.message || 'Failed to load extractions');
    } else if (extractionsRes.data) {
      const data = extractionsRes.data as { extractions: any[]; total: number };
      // Mapear snake_case a camelCase
      const mappedExtractions = (data.extractions || []).map((e) => ({
        id: e.id,
        documentId: e.document_id,
        schemaName: e.schema_name,
        schemaVersion: e.schema_version,
        extractedData: e.extracted_data,
        validationErrors: e.validation_errors,
        confidenceScore: typeof e.confidence_score === 'string' ? parseFloat(e.confidence_score) : e.confidence_score,
        createdAt: e.created_at,
      }));
      setExtractions(mappedExtractions);
    }

    if (docsRes.data) {
      const data = docsRes.data as { documents: Document[]; total: number };
      setDocuments(data.documents || []);
    }

    if (schemasRes.data) {
      setSchemas(schemasRes.data as Schema[]);
    }

    setLoading(false);
  };

  const handleCreateExtraction = async () => {
    if (!selectedDocId || !selectedSchema) {
      setError('Please select a document and schema');
      return;
    }

    setCreating(true);
    setError(null);

    const response = await extractionApi.extract(selectedDocId, selectedSchema);

    setCreating(false);

    if (response.error) {
      setError(response.error.message || 'Extraction failed');
    } else {
      setShowCreateExtraction(false);
      setSelectedDocId('');
      setSelectedSchema('');
      await loadExtractions();
    }
  };

  const handleDeleteExtraction = (id: string) => {
    const extraction = extractions.find((e) => e.id === id);
    setDeleteExtractionId(id);
    setDeleteExtractionTitle(extraction?.schemaName || 'Extraction');
  };

  const confirmDeleteExtraction = async () => {
    if (!deleteExtractionId) return;
    const response = await extractionApi.delete(deleteExtractionId);
    if (response.error) {
      setError(response.error.message || 'Failed to delete');
    } else {
      await loadExtractions();
    }
    setDeleteExtractionId(null);
    setDeleteExtractionTitle('');
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Page Title */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">History</h1>
        <p className="text-gray-600">View past conversations and extracted data.</p>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <TabButton
          active={activeTab === 'sessions'}
          onClick={() => setActiveTab('sessions')}
          icon={<MessageSquare className="w-4 h-4" />}
        >
          Chat Sessions ({sessions.length})
        </TabButton>
        <TabButton
          active={activeTab === 'extractions'}
          onClick={() => setActiveTab('extractions')}
          icon={<FileJson className="w-4 h-4" />}
        >
          Extractions ({extractions.length})
        </TabButton>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-red-800">{error}</p>
          </div>
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Loading State */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : (
        <>
          {/* ...existing code... */}
          {/* Tab Content */}
          {activeTab === 'sessions' ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="flex flex-col gap-4">
                <button
                  onClick={() => setShowDeleteAllModal(true)}
                  className="self-end mb-2 flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete All History
                </button>
                <SessionsList
                  sessions={sessions}
                  selectedId={selectedSessionId}
                  onSelect={loadSessionMessages}
                />
              </div>
              <MessagesViewer
                messages={sessionMessages}
                loading={loadingMessages}
                sessionId={selectedSessionId}
              />
            </div>
          ) : (
            <>
              <div className="flex justify-between mb-4">
                <button
                  onClick={() => setShowCreateExtraction(!showCreateExtraction)}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  New Extraction
                </button>
                <button
                  onClick={() => setShowDeleteAllModal(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete All History
                </button>
              </div>

              {/* Create Extraction Form */}
              {showCreateExtraction && (
                <div className="mb-6 bg-white border border-gray-200 rounded-lg p-4">
                  <h3 className="font-medium text-gray-900 mb-4">Create New Extraction</h3>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Document
                      </label>
                      <select
                        value={selectedDocId}
                        onChange={(e) => setSelectedDocId(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="">Select a document...</option>
                        {documents.map((doc) => (
                          <option key={doc.id} value={doc.id}>
                            {doc.title}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Schema
                      </label>
                      <select
                        value={selectedSchema}
                        onChange={(e) => setSelectedSchema(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="">Select a schema...</option>
                        {schemas.map((schema) => (
                          <option key={schema.name} value={schema.name}>
                            {schema.name} - {schema.description}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={handleCreateExtraction}
                        disabled={creating}
                        className={clsx(
                          'flex-1 py-2 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2',
                          creating
                            ? 'bg-blue-400 text-white cursor-not-allowed'
                            : 'bg-blue-600 text-white hover:bg-blue-700'
                        )}
                      >
                        {creating ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Extracting...
                          </>
                        ) : (
                          'Extract'
                        )}
                      </button>
                      <button
                        onClick={() => setShowCreateExtraction(false)}
                        className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <ExtractionsList
                extractions={extractions}
                onDelete={handleDeleteExtraction}
              />
              <DeleteConfirmModal
                open={!!deleteExtractionId}
                title="Delete Extraction?"
                subtitle="Are you sure you want to delete this extraction?"
                description={deleteExtractionTitle ? deleteExtractionTitle : undefined}
                onClose={() => { setDeleteExtractionId(null); setDeleteExtractionTitle(''); }}
                onConfirm={confirmDeleteExtraction}
              />
            </>
          )}

          {/* Delete All Modal (shared for both tabs) */}
          <DeleteConfirmModal
            open={showDeleteAllModal}
            title="Delete All History?"
            subtitle="Are you sure you want to delete all your chat sessions and extractions?"
            description="This will permanently remove all your chat and extraction history. This action cannot be undone."
            onClose={() => setShowDeleteAllModal(false)}
            onConfirm={handleDeleteAllHistory}
          />
        </>
      )}
    </div>
  );
}

// ===========================================
// Tab Button
// ===========================================

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function TabButton({ active, onClick, icon, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-2 px-4 py-2 border-b-2 font-medium text-sm transition-colors -mb-px',
        active
          ? 'border-blue-600 text-blue-600'
          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ===========================================
// Sessions List
// ===========================================

interface SessionsListProps {
  sessions: ChatSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function SessionsList({ sessions, selectedId, onSelect }: SessionsListProps) {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500 bg-white border border-gray-200 rounded-lg">
        <MessageSquare className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>No chat sessions yet.</p>
        <p className="text-sm">Start a conversation on the Chat page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Sessions</h3>
      {sessions.map((session) => (
        <div
          key={session.id}
          onClick={() => onSelect(session.id)}
          className={clsx(
            'bg-white rounded-lg border p-4 cursor-pointer transition-all',
            selectedId === session.id
              ? 'border-blue-500 shadow-sm'
              : 'border-gray-200 hover:border-blue-300 hover:shadow-sm'
          )}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h3 className="font-medium text-gray-900 line-clamp-1">{session.title}</h3>
              <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {new Date(session.lastMessageAt || session.createdAt).toLocaleDateString()}
                </span>
                <span>{session.messageCount} messages</span>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ===========================================
// Messages Viewer
// ===========================================

interface MessagesViewerProps {
  messages: ChatMessage[];
  loading: boolean;
  sessionId: string | null;
}

function MessagesViewer({ messages, loading, sessionId }: MessagesViewerProps) {
  const [expandedCitations, setExpandedCitations] = useState<Set<string>>(new Set());

  const toggleCitations = (messageId: string) => {
    const newExpanded = new Set(expandedCitations);
    if (newExpanded.has(messageId)) {
      newExpanded.delete(messageId);
    } else {
      newExpanded.add(messageId);
    }
    setExpandedCitations(newExpanded);
  };

  if (!sessionId) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500">
        <MessageSquare className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>Select a session to view messages</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto" />
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-medium text-gray-700">Messages</h3>
      </div>
      <div className="p-4 space-y-4 max-h-96 overflow-y-auto">
        {messages.map((message) => (
          <div key={message.id} className={clsx('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={clsx(
                'rounded-lg px-4 py-2 max-w-md',
                message.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
              )}
            >
              <p className="text-sm whitespace-pre-wrap">{message.content}</p>

              {/* Citations */}
              {message.citations && message.citations.length > 0 && (
                <div className="mt-2 pt-2 border-t border-gray-300">
                  <button
                    onClick={() => toggleCitations(message.id)}
                    className="flex items-center gap-1 text-xs text-blue-700 hover:text-blue-800"
                  >
                    {expandedCitations.has(message.id) ? (
                      <ChevronUp className="w-3 h-3" />
                    ) : (
                      <ChevronDown className="w-3 h-3" />
                    )}
                    {message.citations.length} citation{message.citations.length > 1 ? 's' : ''}
                  </button>

                  {expandedCitations.has(message.id) && (
                    <div className="mt-2 space-y-1">
                      {message.citations.map((citation, idx) => (
                        <div key={idx} className="bg-white rounded p-2 text-xs text-gray-700">
                          <p className="mb-1">{citation.text}</p>
                          <p className="text-gray-500">Relevance: {(citation.relevance * 100).toFixed(0)}%</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===========================================
// Extractions List
// ===========================================

interface ExtractionsListProps {
  extractions: Extraction[];
  onDelete: (id: string) => void;
}

function ExtractionsList({ extractions, onDelete }: ExtractionsListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if ((extractions?.length ?? 0) === 0) {
    return (
      <div className="text-center py-12 text-gray-500 bg-white border border-gray-200 rounded-lg">
        <FileJson className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>No extractions yet.</p>
        <p className="text-sm">Create an extraction from your documents.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {(extractions ?? []).map((extraction) => (
        <div key={extraction.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {/* Header */}
          <div className="p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs font-medium">
                    {extraction.schemaName}
                  </span>
                  {typeof extraction.confidenceScore === 'number' && !isNaN(extraction.confidenceScore) ? (
                    <span className="text-sm text-gray-500">
                      {Math.round(extraction.confidenceScore * 100)}% confidence
                    </span>
                  ) : (
                    <span className="text-sm text-gray-400">—</span>
                  )}
                  {(extraction.validationErrors?.length ?? 0) > 0 && (
                    <span className="text-xs text-orange-600" title="Some fields could not be extracted or are missing.">
                      {(extraction.validationErrors?.length ?? 0)} field{(extraction.validationErrors?.length ?? 0) === 1 ? '' : 's'} could not be extracted or are missing
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400">{extraction.createdAt ? new Date(extraction.createdAt).toLocaleString() : '—'}</p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExpandedId(expandedId === extraction.id ? null : extraction.id)}
                  className="p-1 hover:bg-gray-100 rounded"
                >
                  {expandedId === extraction.id ? (
                    <ChevronUp className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  )}
                </button>
                <button
                  onClick={() => onDelete(extraction.id)}
                  className="p-1 hover:bg-red-50 rounded text-red-600"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Expanded JSON Viewer */}
          {expandedId === extraction.id && (
            <div className="border-t border-gray-200 bg-gray-50 p-4">
              <pre className="text-xs font-mono text-gray-800 overflow-auto max-h-96">
                {JSON.stringify(extraction.extractedData, null, 2)}
              </pre>

              {(extraction.validationErrors?.length ?? 0) > 0 && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <h4 className="text-sm font-medium text-gray-900 mb-2">Some fields could not be extracted or are missing:</h4>
                  <ul className="space-y-1">
                    {(extraction.validationErrors ?? []).map((error, idx) => (
                      <li key={idx} className="text-xs text-red-600">
                        {error.path}: {error.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

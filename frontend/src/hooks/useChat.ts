import { useState, useEffect, useRef } from 'react';
import { documentApi, chatApi } from '../api/client';
import type { ChatMessage, Document } from '../types';

type ChatState = 'empty' | 'ready' | 'thinking' | 'error';

type UploadMode = 'text' | 'pdf';

export function useChat() {
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

  useEffect(() => {
    loadDocuments();
    // eslint-disable-next-line
  }, []);

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
      setUploadTitle('');
      setUploadContent('');
      setUploadFile(null);
      setShowUpload(false);
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
          citations: any[];
          confidenceScore: number;
          confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
        };
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

  return {
    chatState,
    setChatState,
    messages,
    setMessages,
    inputValue,
    setInputValue,
    error,
    setError,
    documents,
    setDocuments,
    sessionId,
    setSessionId,
    loading,
    setLoading,
    showUpload,
    setShowUpload,
    uploadMode,
    setUploadMode,
    uploadTitle,
    setUploadTitle,
    uploadContent,
    setUploadContent,
    uploadFile,
    setUploadFile,
    uploading,
    setUploading,
    showDeleteModal,
    setShowDeleteModal,
    deleteDocId,
    setDeleteDocId,
    deleteDocTitle,
    setDeleteDocTitle,
    messagesEndRef,
    loadDocuments,
    handleUploadSubmit,
    handleSend,
    handleKeyDown,
  };
}

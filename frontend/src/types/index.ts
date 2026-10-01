/**
 * Frontend Type Definitions
 * =========================
 * Shared types for the React application.
 * These should align with backend API contracts.
 */

// ===========================================
// Auth Types
// ===========================================

export interface User {
  id: string;
  email: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

// ===========================================
// Document Types
// ===========================================

export interface Document {
  id: string;
  title: string;
  mimeType: string;
  createdAt: string;
  chunkCount: number;
}

export interface UploadDocumentRequest {
  title: string;
  content?: string;
  file?: File;
}

// ===========================================
// Chat Types
// ===========================================

export interface Citation {
  chunkId: string;
  text: string;
  relevance: number;
}

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  confidenceScore?: number;
  confidenceLevel?: ConfidenceLevel;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string | null;
  documentIds: string[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRequest {
  question: string;
  sessionId?: string;
  documentIds?: string[];
}

export interface ChatResponse {
  answer: string;
  sessionId: string;
  messageId: string;
  citations: Citation[];
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel;
}

// ===========================================
// Extraction Types
// ===========================================

export interface ExtractionSchema {
  name: string;
  version: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface Extraction {
  id: string;
  documentId: string;
  schemaName: string;
  schemaVersion: string;
  extractedData: Record<string, unknown>;
  validationErrors: ValidationError[];
  confidenceScore: number;
  createdAt: string;
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ExtractRequest {
  documentId: string;
  schemaName: string;
}

// ===========================================
// API Response Wrappers
// ===========================================

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: ApiError;
}

// ===========================================
// UI State Types
// ===========================================

export type LoadingState = 'idle' | 'loading' | 'success' | 'error';

export interface AsyncState<T> {
  data: T | null;
  status: LoadingState;
  error: string | null;
}

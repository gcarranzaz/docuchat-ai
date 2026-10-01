/**
 * Core type definitions for DocuChat
 * =================================
 * Centralizes all TypeScript types used across the application.
 * These types mirror the database schema and define API contracts.
 */

// ===========================================
// Database Entity Types
// ===========================================

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface Document {
  id: string;
  userId: string;
  title: string;
  content: string;
  mimeType: string;
  originalFilename: string | null;
  fileSizeBytes: number | null;
  chunkCount: number;
  metadata: Record<string, unknown>;
  summary: string | null;
  keyTopics: string[] | null;
  documentType: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocChunk {
  id: string;
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ChatSession {
  id: string;
  userId: string;
  title: string | null;
  documentIds: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations: Citation[] | null;
  confidenceScore: number | null;
  promptVersion: string | null;
  modelUsed: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  /** The caller's own thumbs up/down, present when messages are listed for a session */
  feedbackRating?: 'up' | 'down' | null;
}

export interface Extraction {
  id: string;
  userId: string;
  documentId: string;
  schemaName: string;
  schemaVersion: string;
  extractedData: Record<string, unknown>;
  validationErrors: ValidationError[];
  confidenceScore: number | null;
  promptVersion: string | null;
  modelUsed: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
}

export interface PromptTemplate {
  id: string;
  name: string;
  version: string;
  description: string | null;
  systemPrompt: string;
  userPromptTemplate: string;
  config: PromptConfig;
  isActive: boolean;
  createdAt: Date;
}

export interface UsageLog {
  id: string;
  userId: string;
  operation: 'chat' | 'extract' | 'embed';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  latencyMs: number | null;
  success: boolean;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// ===========================================
// Supporting Types
// ===========================================

export interface Citation {
  chunkId: string;
  text: string;
  relevance: number;
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface PromptConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

// ===========================================
// API Request/Response Types
// ===========================================

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
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
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
}

export interface ExtractionRequest {
  documentId: string;
  schemaName: string;
}

export interface ExtractionResponse {
  id: string;
  extractedData: Record<string, unknown>;
  validationErrors: ValidationError[];
  confidenceScore: number;
}

// ===========================================
// AI Provider Types
// ===========================================

export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LlmProviderConfig {
  apiKey?: string;
  model?: string;
  embeddingModel?: string;
  maxTokens?: number;
  temperature?: number;
}

// ===========================================
// RAG Types
// ===========================================

export interface ChunkWithScore {
  chunk: DocChunk;
  score: number;
}

export interface RetrievalResult {
  chunks: ChunkWithScore[];
  totalFound: number;
}

// ===========================================
// Express Extension
// ===========================================

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: User;
    }
  }
}

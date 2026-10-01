/**
 * Document Validation Schemas
 * ===========================
 * Zod schemas for document upload and retrieval.
 *
 * Supported formats:
 * - text/plain: Direct text content
 * - application/pdf: PDF files (text extracted server-side)
 */

import { z } from 'zod';

// ===========================================
// Constants
// ===========================================

export const ALLOWED_MIME_TYPES = [
  'text/plain',
  'application/pdf',
] as const;

// Architecture Decision: 50MB limit
// - Allows large PDFs (technical docs, reports, manuals)
// - Fargate 2GB memory can handle multiple concurrent 50MB files
// - Estimated cost per 50MB doc: $0.01-0.02 (embeddings)
// - Processing time: ~30-60s for full embedding generation (async via BullMQ)
export const MAX_FILE_SIZE_MB = 50;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
export const MAX_TEXT_LENGTH = 2000000; // ~2MB of text (increased proportionally)

// ===========================================
// Upload Document (text)
// ===========================================

export const uploadTextSchema = z.object({
  body: z.object({
    title: z
      .string()
      .min(1, 'Title is required')
      .max(500, 'Title too long'),
    content: z
      .string()
      .min(1, 'Content is required')
      .max(MAX_TEXT_LENGTH, `Content too long (max ${MAX_TEXT_LENGTH} characters)`),
  }),
});

export type UploadTextInput = z.infer<typeof uploadTextSchema>['body'];

// ===========================================
// Get Document by ID
// ===========================================

export const getDocumentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid document ID'),
  }),
});

export type GetDocumentParams = z.infer<typeof getDocumentSchema>['params'];

// ===========================================
// List Documents (with pagination)
// ===========================================

export const listDocumentsSchema = z.object({
  query: z.object({
    limit: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : 20))
      .refine((val) => val > 0 && val <= 100, 'Limit must be between 1 and 100'),
    offset: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : 0))
      .refine((val) => val >= 0, 'Offset must be non-negative'),
  }),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsSchema>['query'];

// ===========================================
// Delete Document
// ===========================================

export const deleteDocumentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid document ID'),
  }),
});

// ===========================================
// Response Types
// ===========================================

export interface DocumentResponse {
  id: string;
  title: string;
  mimeType: string;
  originalFilename: string | null;
  fileSizeBytes: number | null;
  chunkCount: number;
  summary: string | null;
  keyTopics: string[] | null;
  documentType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetailResponse extends DocumentResponse {
  content: string;
  metadata: Record<string, unknown>;
}

export interface DocumentListResponse {
  documents: DocumentResponse[];
  total: number;
  limit: number;
  offset: number;
}

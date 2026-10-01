/**
 * Document Service
 * ================
 * Business logic for document operations.
 *
 * Handles:
 * - Text document creation
 * - PDF upload and text extraction
 * - Document retrieval and listing
 *
 * PDF Extraction notes:
 * - Uses pdf-parse library (pure JS, no native deps)
 * - Extracts text only (no images/tables yet)
 * - Complex PDFs may have layout issues
 */

import pdfParse from 'pdf-parse';
import * as documentRepo from '../repositories/document.repository.js';
import { enqueueEmbeddingJob } from '../queues/embeddings.queue.js';
import { getLlmProvider } from '../ai/providers/providerFactory.js';
import { errors } from '../middleware/error.middleware.js';
import { logger } from '../utils/logger.js';
import type { Document } from '../types/index.js';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_TEXT_LENGTH,
  type DocumentResponse,
  type DocumentDetailResponse,
} from '../schemas/document.schema.js';

// ===========================================
// AI Summary Generation
// ===========================================

interface DocumentSummary {
  summary: string;
  keyTopics: string[];
  documentType: string;
}

async function generateAiSummary(content: string, title: string): Promise<DocumentSummary> {
  try {
    const llm = getLlmProvider();

    const prompt = {
      systemPrompt: 'You are a document analyzer. Respond only with valid JSON.',
      userPrompt: `Analyze this document and respond with JSON:
{
  "summary": "2-3 sentences in English summarizing the main content",
  "keyTopics": ["topic1", "topic2", "topic3"],
  "documentType": "report" | "guide" | "article" | "manual" | "other"
}

Title: ${title}
Content (first 2000 chars): ${content.substring(0, 2000)}

Respond with ONLY the JSON object, no markdown formatting.`,
    };

    const result = await llm.complete(prompt);

    // Parse JSON response
    let parsed: DocumentSummary;
    try {
      // Try to extract JSON from response (in case LLM adds markdown)
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(result.content);
      }
    } catch (parseError) {
      logger.warn({ content: result.content }, 'Failed to parse LLM JSON response');
      // Fallback to basic summary
      return {
        summary: content.substring(0, 300) + '...',
        keyTopics: [title],
        documentType: 'other',
      };
    }

    logger.info({ title, summary: parsed.summary }, 'AI summary generated');
    return parsed;
  } catch (error) {
    logger.error({ err: error, title }, 'Failed to generate AI summary');
    // Return basic summary as fallback
    return {
      summary: content.substring(0, 300) + '...',
      keyTopics: [title],
      documentType: 'other',
    };
  }
}

// ===========================================
// Create Document (Text)
// ===========================================

export async function createTextDocument(
  userId: string,
  title: string,
  content: string
): Promise<Document> {
  // Validate content length
  if (content.length > MAX_TEXT_LENGTH) {
    throw errors.badRequest(`Content too long (max ${MAX_TEXT_LENGTH} characters)`);
  }

  const document = await documentRepo.create({
    userId,
    title,
    content,
    mimeType: 'text/plain',
  });

  logger.info(
    { userId, documentId: document.id, contentLength: content.length },
    'Text document created'
  );

  // Generate AI summary (sync - blocks for ~5-10s but provides immediate value)
  try {
    const summary = await generateAiSummary(content, title);
    await documentRepo.updateSummary(document.id, userId, {
      summary: summary.summary,
      keyTopics: summary.keyTopics,
      documentType: summary.documentType,
    });
    logger.info({ documentId: document.id }, 'Document summary generated');
  } catch (error) {
    logger.error({ err: error, documentId: document.id }, 'Failed to generate summary');
    // Don't fail the upload, continue without summary
  }

  // Enqueue async embedding generation (non-blocking)
  try {
    const jobId = await enqueueEmbeddingJob({
      documentId: document.id,
      userId,
      content,
      title,
    });
    logger.info(
      { documentId: document.id, jobId },
      'Document embedding job enqueued'
    );
  } catch (error) {
    // Log but don't fail - document is created, embeddings can be retried manually
    logger.error({ err: error, documentId: document.id }, 'Failed to enqueue embedding job');
  }

  return document;
}

// ===========================================
// Create Document (PDF)
// ===========================================

export async function createPdfDocument(
  userId: string,
  title: string,
  fileBuffer: Buffer,
  originalFilename: string
): Promise<Document> {
  // Validate file size
  if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
    throw errors.badRequest(`File too large (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)`);
  }

  // Extract text from PDF
  let extractedText: string;
  try {
    const pdfData = await pdfParse(fileBuffer);
    extractedText = pdfData.text;

    logger.debug(
      {
        userId,
        originalFilename,
        pages: pdfData.numpages,
        textLength: extractedText.length,
      },
      'PDF text extracted'
    );
  } catch (error) {
    logger.error({ err: error, originalFilename }, 'PDF extraction failed');
    throw errors.badRequest('Failed to extract text from PDF. The file may be corrupted or password-protected.');
  }

  // Validate extracted text
  if (!extractedText || extractedText.trim().length === 0) {
    throw errors.badRequest('PDF contains no extractable text. It may be an image-only PDF.');
  }

  if (extractedText.length > MAX_TEXT_LENGTH) {
    throw errors.badRequest(
      `Extracted text too long (${extractedText.length} chars, max ${MAX_TEXT_LENGTH}). Try a smaller document.`
    );
  }

  const document = await documentRepo.create({
    userId,
    title,
    content: extractedText,
    mimeType: 'application/pdf',
    originalFilename,
    fileSizeBytes: fileBuffer.length,
    metadata: {
      extractedAt: new Date().toISOString(),
    },
  });

  logger.info(
    {
      userId,
      documentId: document.id,
      originalFilename,
      contentLength: extractedText.length,
    },
    'PDF document created'
  );

  // Generate AI summary (sync - blocks for ~5-10s but provides immediate value)
  try {
    const summary = await generateAiSummary(extractedText, title);
    await documentRepo.updateSummary(document.id, userId, {
      summary: summary.summary,
      keyTopics: summary.keyTopics,
      documentType: summary.documentType,
    });
    logger.info({ documentId: document.id }, 'PDF summary generated');
  } catch (error) {
    logger.error({ err: error, documentId: document.id }, 'Failed to generate PDF summary');
    // Don't fail the upload, continue without summary
  }

  // Enqueue async embedding generation (non-blocking)
  try {
    const jobId = await enqueueEmbeddingJob({
      documentId: document.id,
      userId,
      content: extractedText,
      title,
    });
    logger.info(
      { documentId: document.id, jobId },
      'PDF embedding job enqueued'
    );
  } catch (error) {
    // Log but don't fail - document is created, embeddings can be retried manually
    logger.error({ err: error, documentId: document.id }, 'Failed to enqueue PDF embedding job');
  }

  return document;
}

// ===========================================
// Get Document
// ===========================================

export async function getDocument(
  documentId: string,
  userId: string
): Promise<DocumentDetailResponse> {
  const document = await documentRepo.findById(documentId, userId);

  if (!document) {
    throw errors.notFound('Document');
  }

  return mapToDetailResponse(document);
}

// ===========================================
// List Documents
// ===========================================

export async function listDocuments(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ documents: DocumentResponse[]; total: number; limit: number; offset: number }> {
  const result = await documentRepo.findByUser(userId, limit, offset);

  return {
    documents: result.documents.map(mapToResponse),
    total: result.total,
    limit,
    offset,
  };
}

// ===========================================
// Delete Document
// ===========================================

export async function deleteDocument(
  documentId: string,
  userId: string
): Promise<void> {
  const deleted = await documentRepo.deleteById(documentId, userId);

  if (!deleted) {
    throw errors.notFound('Document');
  }

  logger.info({ userId, documentId }, 'Document deleted');
}

// ===========================================
// Validate MIME Type
// ===========================================

export function isAllowedMimeType(mimeType: string): boolean {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

// ===========================================
// Response Mappers
// ===========================================

function mapToResponse(doc: Document): DocumentResponse {
  return {
    id: doc.id,
    title: doc.title,
    mimeType: doc.mimeType,
    originalFilename: doc.originalFilename,
    fileSizeBytes: doc.fileSizeBytes,
    chunkCount: doc.chunkCount,
    summary: doc.summary,
    keyTopics: doc.keyTopics,
    documentType: doc.documentType,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function mapToDetailResponse(doc: Document): DocumentDetailResponse {
  return {
    ...mapToResponse(doc),
    content: doc.content,
    metadata: doc.metadata,
  };
}

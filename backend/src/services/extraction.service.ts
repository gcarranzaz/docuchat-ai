/**
 * Delete all extractions for a user
 */
export async function deleteAllExtractions(userId: string): Promise<void> {
  await extractionRepo.deleteAllByUser(userId);
  logger.info({ userId }, 'All extractions deleted');
  await audit.record({ action: 'extraction.delete_all', userId });
}
/**
 * Extraction Service
 * ==================
 * Orchestrates structured data extraction from documents using LLMs.
 *
 * Pipeline:
 * 1. Get document content
 * 2. Select extraction schema
 * 3. Build extraction prompt
 * 4. Call LLM with JSON mode
 * 5. Parse and validate response
 * 6. Store extraction result
 */

import { getLlmProvider, chatModelName } from '../ai/providers/providerFactory.js';
import { calculateCost } from '../ai/pricing.js';
import { estimateTokenCount } from '../rag/chunker.js';
import * as budget from './budget.service.js';
import { buildExtractionPrompt } from '../ai/prompts/promptBuilder.js';
import * as documentRepo from '../repositories/document.repository.js';
import * as extractionRepo from '../repositories/extraction.repository.js';
import * as usageRepo from '../repositories/usage.repository.js';
import { getExtractionSchema, listExtractionSchemas } from '../schemas/extraction.schema.js';
import { errors } from '../middleware/error.middleware.js';
import { logger } from '../utils/logger.js';
import * as audit from './audit.service.js';
import { getConfig } from '../config/index.js';
import type { Extraction, ValidationError } from '../types/index.js';
import { ZodError } from 'zod';

// ===========================================
// Types
// ===========================================

export interface ExtractionRequest {
  documentId: string;
  schemaName: string;
}

export interface ExtractionResult {
  id: string;
  documentId: string;
  schemaName: string;
  schemaVersion: string;
  extractedData: Record<string, unknown>;
  validationErrors: ValidationError[];
  confidenceScore: number | null;
  metadata: {
    tokensUsed: number;
    promptVersion: string;
    modelUsed: string;
  };
}

export interface SchemaInfo {
  name: string;
  version: string;
  description: string;
}

// Rough size of the extraction instructions, added to the input estimate used for budgeting
const EXTRACTION_PROMPT_TOKENS = 1500;

// ===========================================
// Extraction Functions
// ===========================================

/**
 * Extract structured data from a document
 */
export async function extractFromDocument(
  userId: string,
  request: ExtractionRequest
): Promise<ExtractionResult> {
  const config = getConfig();

  logger.info(
    { userId, documentId: request.documentId, schemaName: request.schemaName },
    'Starting extraction'
  );

  // Step 1: Get document
  const document = await documentRepo.findById(request.documentId, userId);
  if (!document) {
    throw errors.notFound('Document');
  }

  // Step 2: Get extraction schema
  const extractionSchema = getExtractionSchema(request.schemaName);
  if (!extractionSchema) {
    throw errors.badRequest(
      `Unknown schema: ${request.schemaName}. Available schemas: ${listExtractionSchemas()
        .map((s) => s.name)
        .join(', ')}`
    );
  }

  // Step 3: Build prompt
  const prompt = buildExtractionPrompt({
    document: document.content,
    schema: extractionSchema.schema.shape,
    schemaDescription: extractionSchema.schemaDescription,
  });

  // Step 4: Reserve budget, then call the LLM with JSON mode
  // (worst case = whole document + instructions in, maximum output; corrected after the call)
  const model = chatModelName(config);
  const estimatedInput = estimateTokenCount(document.content) + EXTRACTION_PROMPT_TOKENS;
  const reservation = await budget.reserve(
    userId,
    {
      tokens: estimatedInput + config.maxTokensPerRequest,
      costUsd: calculateCost(model, estimatedInput, config.maxTokensPerRequest),
    },
    { dailyTokens: config.userDailyTokenBudget, monthlyCostUsd: config.userMonthlyCostCapUsd }
  );

  const llmProvider = getLlmProvider();
  let llmResult;
  try {
    llmResult = await llmProvider.complete({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      jsonMode: true,
      temperature: 0.1, // Low temperature for consistent extraction
    });
  } catch (error) {
    await budget.release(reservation);
    throw error;
  }
  await budget.settle(reservation, {
    tokens: llmResult.inputTokens + llmResult.outputTokens,
    costUsd: calculateCost(llmResult.model, llmResult.inputTokens, llmResult.outputTokens),
  });

  logger.debug(
    {
      documentId: request.documentId,
      responseLength: llmResult.content.length,
      tokensUsed: llmResult.inputTokens + llmResult.outputTokens,
    },
    'LLM extraction response received'
  );

  // Step 5: Parse JSON response
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(llmResult.content);
  } catch (error) {
    logger.error({ documentId: request.documentId, responseLength: llmResult.content.length }, 'Failed to parse JSON response');
    throw errors.internal('LLM returned invalid JSON');
  }

  // Step 6: Validate against schema
  const validationResult = extractionSchema.schema.safeParse(parsedData);
  const validationErrors: ValidationError[] = [];
  let extractedData: Record<string, unknown>;

  if (validationResult.success) {
    extractedData = validationResult.data as Record<string, unknown>;
    logger.info({ documentId: request.documentId }, 'Extraction validation passed');
  } else {
    // Validation failed - store data anyway but log errors
    extractedData = parsedData as Record<string, unknown>;
    validationErrors.push(
      ...validationResult.error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      }))
    );
    logger.warn(
      {
        documentId: request.documentId,
        errors: validationErrors,
      },
      'Extraction validation failed'
    );
  }

  // Step 7: Calculate confidence (simple heuristic for now)
  const confidenceScore = calculateExtractionConfidence(
    extractedData,
    validationErrors.length
  );

  // Step 8: Store extraction
  const extraction = await extractionRepo.create({
    userId,
    documentId: request.documentId,
    schemaName: extractionSchema.name,
    schemaVersion: extractionSchema.version,
    extractedData,
    validationErrors,
    confidenceScore,
    promptVersion: prompt.promptVersion,
    modelUsed: llmResult.model,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
  });

  // Step 9: Log usage
  await usageRepo.create({
    userId,
    operation: 'extract',
    provider: config.aiProvider,
    model: llmResult.model,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
    success: validationErrors.length === 0,
    metadata: {
      documentId: request.documentId,
      schemaName: request.schemaName,
    },
  });

  logger.info(
    {
      extractionId: extraction.id,
      documentId: request.documentId,
      schemaName: request.schemaName,
      confidenceScore,
      validationErrors: validationErrors.length,
    },
    'Extraction completed'
  );
  await audit.record({
    action: 'extraction.create',
    userId,
    resourceType: 'extraction',
    resourceId: extraction.id,
    metadata: {
      documentId: request.documentId,
      schemaName: extractionSchema.name,
      model: llmResult.model,
      promptVersion: prompt.promptVersion,
      inputTokens: llmResult.inputTokens,
      outputTokens: llmResult.outputTokens,
      validationErrors: validationErrors.length,
    },
  });

  // Step 10: Return result
  return {
    id: extraction.id,
    documentId: extraction.documentId,
    schemaName: extraction.schemaName,
    schemaVersion: extraction.schemaVersion,
    extractedData: extraction.extractedData,
    validationErrors: extraction.validationErrors,
    confidenceScore: extraction.confidenceScore,
    metadata: {
      tokensUsed: llmResult.inputTokens + llmResult.outputTokens,
      promptVersion: prompt.promptVersion,
      modelUsed: llmResult.model,
    },
  };
}

/**
 * Get extraction by ID
 */
export async function getExtraction(
  userId: string,
  extractionId: string
): Promise<Extraction> {
  const extraction = await extractionRepo.findById(extractionId, userId);

  if (!extraction) {
    throw errors.notFound('Extraction');
  }

  return extraction;
}

/**
 * List extractions for a document
 */
export async function listExtractionsByDocument(
  userId: string,
  documentId: string
): Promise<Extraction[]> {
  // Verify document exists and belongs to user
  const document = await documentRepo.findById(documentId, userId);
  if (!document) {
    throw errors.notFound('Document');
  }

  return extractionRepo.findByDocument(documentId, userId);
}

/**
 * List all extractions for a user
 */
export async function listExtractions(
  userId: string,
  limit: number = 20,
  offset: number = 0
): Promise<{ extractions: Extraction[]; total: number }> {
  return extractionRepo.findByUser(userId, limit, offset);
}

/**
 * Delete an extraction
 */
export async function deleteExtraction(
  userId: string,
  extractionId: string
): Promise<void> {
  const deleted = await extractionRepo.deleteById(extractionId, userId);

  if (!deleted) {
    throw errors.notFound('Extraction');
  }

  logger.info({ userId, extractionId }, 'Extraction deleted');
  await audit.record({ action: 'extraction.delete', userId, resourceType: 'extraction', resourceId: extractionId });
}

/**
 * List available extraction schemas
 */
export function getAvailableSchemas(): SchemaInfo[] {
  return listExtractionSchemas();
}

// ===========================================
// Helpers
// ===========================================

/**
 * Calculate extraction confidence score
 * Based on:
 * 1. Percentage of non-null fields
 * 2. Validation errors
 */
function calculateExtractionConfidence(
  data: Record<string, unknown>,
  errorCount: number
): number {
  // Count non-null fields
  const fields = flattenObject(data);
  const totalFields = Object.keys(fields).length;
  const nonNullFields = Object.values(fields).filter(
    (value) => value !== null && value !== undefined && value !== ''
  ).length;

  if (totalFields === 0) return 0;

  // Base score from field completion
  const completionScore = nonNullFields / totalFields;

  // Penalty for validation errors
  const errorPenalty = Math.min(errorCount * 0.1, 0.5);

  const finalScore = Math.max(0, completionScore - errorPenalty);

  return parseFloat(finalScore.toFixed(2));
}

/**
 * Flatten nested object to count all leaf fields
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix: string = ''
): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flattened, flattenObject(value as Record<string, unknown>, newKey));
    } else {
      flattened[newKey] = value;
    }
  }

  return flattened;
}

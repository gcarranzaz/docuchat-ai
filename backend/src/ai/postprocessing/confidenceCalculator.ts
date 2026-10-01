/**
 * Confidence Calculator
 * =====================
 * Calculates confidence scores for AI responses.
 *
 * Confidence is based on:
 * 1. Retrieval quality (chunk similarity scores)
 * 2. LLM self-reported confidence
 * 3. Citation coverage (how much of the answer is cited)
 *
 * Confidence levels:
 * - HIGH: Score >= 0.8, good retrieval, LLM confident
 * - MEDIUM: Score 0.5-0.8, moderate retrieval
 * - LOW: Score 0.3-0.5, weak retrieval or LLM uncertain
 * - NONE: Score < 0.3, no good context found
 */

import type { ChunkWithScore, Citation } from '../../types/index.js';

// ===========================================
// Types
// ===========================================

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface ConfidenceResult {
  score: number; // 0-1
  level: ConfidenceLevel;
  factors: {
    retrievalScore: number;
    llmConfidence: number;
    citationCoverage: number;
  };
}

// ===========================================
// Confidence Calculation
// ===========================================

/**
 * Calculate overall confidence for a response
 */
export function calculateConfidence(params: {
  chunks: ChunkWithScore[];
  llmConfidenceStr: string | null;
  citations: Citation[];
  responseLength: number;
}): ConfidenceResult {
  const { chunks, llmConfidenceStr, citations, responseLength } = params;

  // Factor 1: Retrieval quality (weighted average of top chunks)
  const retrievalScore = calculateRetrievalScore(chunks);

  // Factor 2: LLM self-reported confidence
  const llmConfidence = parseLlmConfidence(llmConfidenceStr);

  // Factor 3: Citation coverage (citations per 100 chars of response)
  const citationCoverage = calculateCitationCoverage(citations, responseLength);

  // Weighted combination
  const weights = {
    retrieval: 0.5,  // Most important: did we find good context?
    llm: 0.3,        // LLM's own assessment
    citations: 0.2,  // Is the answer well-cited?
  };

  const score =
    retrievalScore * weights.retrieval +
    llmConfidence * weights.llm +
    citationCoverage * weights.citations;

  return {
    score,
    level: scoreToLevel(score),
    factors: {
      retrievalScore,
      llmConfidence,
      citationCoverage,
    },
  };
}

// ===========================================
// Factor Calculations
// ===========================================

function calculateRetrievalScore(chunks: ChunkWithScore[]): number {
  if (chunks.length === 0) return 0;

  // Weight top results more heavily
  const weights = [0.4, 0.25, 0.15, 0.1, 0.1]; // For top 5 chunks
  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < Math.min(chunks.length, weights.length); i++) {
    const weight = weights[i] ?? 0;
    weightedSum += (chunks[i]?.score ?? 0) * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

function parseLlmConfidence(confidenceStr: string | null): number {
  if (!confidenceStr) return 0.5; // Default to medium if not provided

  switch (confidenceStr.toUpperCase()) {
    case 'HIGH':
      return 0.9;
    case 'MEDIUM':
      return 0.6;
    case 'LOW':
      return 0.3;
    default:
      return 0.5;
  }
}

function calculateCitationCoverage(
  citations: Citation[],
  responseLength: number
): number {
  if (responseLength === 0) return 0;

  // Expect roughly 1 citation per 200 characters of response
  const expectedCitations = Math.ceil(responseLength / 200);
  const actualCitations = citations.length;

  // Cap at 1.0 (having more citations than expected is good but not extra credit)
  return Math.min(actualCitations / expectedCitations, 1.0);
}

// ===========================================
// Level Conversion
// ===========================================

function scoreToLevel(score: number): ConfidenceLevel {
  if (score >= 0.8) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  if (score >= 0.3) return 'LOW';
  return 'NONE';
}

/**
 * Get user-friendly description of confidence level
 */
export function getConfidenceDescription(level: ConfidenceLevel): string {
  switch (level) {
    case 'HIGH':
      return 'Direct answer found in documents';
    case 'MEDIUM':
      return 'Answer inferred from context';
    case 'LOW':
      return 'Limited evidence found';
    case 'NONE':
      return 'Could not find relevant information';
  }
}

/**
 * Determine if response should include uncertainty warning
 */
export function shouldShowUncertaintyWarning(level: ConfidenceLevel): boolean {
  return level === 'LOW' || level === 'NONE';
}

/**
 * An answer is "grounded" when at least one valid citation backs it and the evidence is not
 * "none". A confident-sounding answer with no valid citation is NOT grounded. Used by the chat
 * service and by the evaluation runner, so both apply the same rule.
 */
export function isGrounded(citationCount: number, level: ConfidenceLevel): boolean {
  return citationCount > 0 && level !== 'NONE';
}

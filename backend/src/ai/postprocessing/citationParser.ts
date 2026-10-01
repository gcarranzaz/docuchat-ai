/**
 * Citation Parser
 * ===============
 * Extracts and validates citations from LLM responses.
 *
 * Citation format: [chunk-N] where N is the chunk index
 * Example: "According to the report [chunk-0], sales increased by 20%."
 */

import type { Citation, DocChunk } from '../../types/index.js';

// ===========================================
// Types
// ===========================================

export interface ParsedResponse {
  /** Response text with citations */
  content: string;
  /** Extracted citations with details */
  citations: Citation[];
  /** Raw confidence string from response */
  rawConfidence: string | null;
}

// ===========================================
// Citation Parsing
// ===========================================

/**
 * Parse citations from LLM response (Legacy text-based)
 */
export function parseCitations(
  response: string,
  chunkMapping: Map<string, DocChunk>
): ParsedResponse {
  // Find all citations in format [chunk-N]
  const citationPattern = /\[chunk-(\d+)\]/g;
  const foundCitations: Citation[] = [];
  const seenChunks = new Set<string>();

  let match;
  while ((match = citationPattern.exec(response)) !== null) {
    const chunkKey = `chunk-${match[1]}`;

    // Avoid duplicates
    if (seenChunks.has(chunkKey)) continue;
    seenChunks.add(chunkKey);

    const chunk = chunkMapping.get(chunkKey);
    if (chunk) {
      foundCitations.push({
        chunkId: chunk.id,
        text: truncateText(chunk.content, 200),
        relevance: 1.0, // Will be updated with actual score if available
      });
    }
  }

  // Extract confidence from response
  const confidenceMatch = response.match(/Confidence:\s*(HIGH|MEDIUM|LOW)/i);
  const rawConfidence = confidenceMatch ? confidenceMatch[1]!.toUpperCase() : null;

  return {
    content: response,
    citations: foundCitations,
    rawConfidence,
  };
}

/**
 * Parse structured JSON response from LLM (v2 prompt)
 * More reliable than regex-based parsing
 */
export function parseStructuredResponse(
  response: string,
  chunkMapping: Map<string, DocChunk>
): ParsedResponse {
  try {
    // Clean response - remove markdown code blocks if present
    let jsonStr = response.trim();

    // Remove markdown code blocks (```json ... ```)
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Parse JSON
    const parsed = JSON.parse(jsonStr) as {
      answer: string;
      citations: number[];
      confidence: 'HIGH' | 'MEDIUM' | 'LOW';
      reasoning?: string;
    };

    // Build citations from chunk indices
    const foundCitations: Citation[] = [];
    const seenChunks = new Set<number>();

    for (const chunkIndex of parsed.citations || []) {
      if (seenChunks.has(chunkIndex)) continue;
      seenChunks.add(chunkIndex);

      const chunkKey = `chunk-${chunkIndex}`;
      const chunk = chunkMapping.get(chunkKey);

      if (chunk) {
        foundCitations.push({
          chunkId: chunk.id,
          text: truncateText(chunk.content, 200),
          relevance: 1.0, // Will be updated with actual score if available
        });
      }
    }

    return {
      content: parsed.answer,
      citations: foundCitations,
      rawConfidence: parsed.confidence,
    };
  } catch (error) {
    // Fallback to legacy parsing if JSON parse fails
    return parseCitations(response, chunkMapping);
  }
}

/**
 * Update citation relevance scores from retrieval scores
 */
export function enrichCitationsWithScores(
  citations: Citation[],
  chunkScores: Map<string, number>
): Citation[] {
  return citations.map((citation) => ({
    ...citation,
    relevance: chunkScores.get(citation.chunkId) ?? citation.relevance,
  }));
}

/**
 * Validate that citations reference real chunks
 */
export function validateCitations(
  citations: Citation[],
  validChunkIds: Set<string>
): { valid: Citation[]; invalid: string[] } {
  const valid: Citation[] = [];
  const invalid: string[] = [];

  for (const citation of citations) {
    if (validChunkIds.has(citation.chunkId)) {
      valid.push(citation);
    } else {
      invalid.push(citation.chunkId);
    }
  }

  return { valid, invalid };
}

// ===========================================
// Helpers
// ===========================================

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Format citations for display
 */
export function formatCitationsForDisplay(citations: Citation[]): string {
  if (citations.length === 0) return '';

  return citations
    .map((c, i) => `[${i + 1}] ${c.text} (relevance: ${(c.relevance * 100).toFixed(0)}%)`)
    .join('\n\n');
}

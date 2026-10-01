/**
 * Citation helpers
 * ================
 * Parsing the model's reply (including which chunks it cites) is done by
 * chatOutput.ts, which validates the reply against a schema. The older text and
 * JSON parsers that lived here were removed: on malformed JSON they fell back to
 * returning the raw model text as the answer.
 */

import type { Citation } from '../../types/index.js';

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

/**
 * Format citations for display
 */
export function formatCitationsForDisplay(citations: Citation[]): string {
  if (citations.length === 0) return '';

  return citations
    .map((c, i) => `[${i + 1}] ${c.text} (relevance: ${(c.relevance * 100).toFixed(0)}%)`)
    .join('\n\n');
}

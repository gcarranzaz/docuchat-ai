/**
 * Context formatting
 * ==================
 * Pure helpers that turn retrieved chunks into the text the model reads and the
 * lookup table used to validate its citations. No database access.
 *
 * The result is NOT wrapped in delimiters here: wrapping untrusted text with a
 * per-request nonce is the prompt builder's job (ai/prompts/promptBuilder.ts).
 */

import type { ChunkWithScore, DocChunk } from '../types/index.js';

/**
 * Number the chunks so the model can cite them as [chunk-N].
 * A document may contain text that imitates these labels; that is harmless
 * because citations are validated against the real mapping afterwards.
 */
export function buildContextFromChunks(chunks: ChunkWithScore[], options: { includeDocumentIds?: boolean } = {}): string {
  if (chunks.length === 0) {
    return 'No relevant documents found.';
  }

  // Document ids are shown only when a tool needs them (spec 011); they are server data, and a tool
  // call with an id the user does not own is refused by the executor whatever the model writes.
  return chunks
    .map(({ chunk, score }, index) => {
      const label = options.includeDocumentIds ? `document: ${chunk.documentId}, ` : '';
      return `[chunk-${index}] (${label}relevance: ${(score * 100).toFixed(0)}%)\n${chunk.content}`;
    })
    .join('\n\n---\n\n');
}

/** "chunk-N" → chunk, used to resolve and validate the citations a model returns */
export function createChunkMapping(chunks: ChunkWithScore[]): Map<string, DocChunk> {
  const mapping = new Map<string, DocChunk>();
  chunks.forEach((item, index) => {
    mapping.set(`chunk-${index}`, item.chunk);
  });
  return mapping;
}

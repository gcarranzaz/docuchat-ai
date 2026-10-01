/**
 * Document Chunker
 * ================
 * Splits documents into chunks for embedding and retrieval.
 *
 * Why chunking:
 * - LLMs have context limits
 * - Smaller chunks = more precise retrieval
 * - Overlap ensures context isn't lost at boundaries
 *
 * Trade-offs:
 * - Smaller chunks: Better retrieval precision, more API calls for embedding
 * - Larger chunks: Fewer calls, but may retrieve irrelevant text
 * - More overlap: Better context preservation, more storage
 *
 * Default config (optimized for general documents):
 * - Chunk size: 500 tokens (~2000 chars)
 * - Overlap: 50 tokens (~200 chars) = 10% overlap
 */

// ===========================================
// Types
// ===========================================

export interface ChunkConfig {
  /** Target chunk size in characters (not tokens) */
  chunkSize: number;
  /** Overlap between chunks in characters */
  chunkOverlap: number;
  /** Minimum chunk size to keep */
  minChunkSize: number;
}

export interface Chunk {
  index: number;
  content: string;
  startPosition: number;
  endPosition: number;
  tokenCount: number; // Estimated
}

// ===========================================
// Default Configuration
// ===========================================

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  chunkSize: 1000,      // ~250 tokens (assuming 4 chars/token avg)
  chunkOverlap: 200,    // 20% overlap
  minChunkSize: 100,    // Don't create tiny chunks
};

// ===========================================
// Token Estimation
// ===========================================

/**
 * Estimate token count from text
 * Rule of thumb: ~4 characters per token for English
 * This is approximate - actual count depends on tokenizer
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ===========================================
// Chunking Functions
// ===========================================

/**
 * Split text into chunks with overlap
 *
 * Algorithm:
 * 1. Find good break points (paragraph, sentence, word boundaries)
 * 2. Create chunks of target size
 * 3. Add overlap from previous chunk
 * 4. Track positions for citation references
 */
export function chunkText(
  text: string,
  config: Partial<ChunkConfig> = {}
): Chunk[] {
  const { chunkSize, chunkOverlap, minChunkSize } = {
    ...DEFAULT_CHUNK_CONFIG,
    ...config,
  };

  // Normalize whitespace
  const normalizedText = text.replace(/\r\n/g, '\n').trim();

  if (normalizedText.length === 0) {
    return [];
  }

  // If text is smaller than chunk size, return single chunk
  if (normalizedText.length <= chunkSize) {
    return [{
      index: 0,
      content: normalizedText,
      startPosition: 0,
      endPosition: normalizedText.length,
      tokenCount: estimateTokenCount(normalizedText),
    }];
  }

  const chunks: Chunk[] = [];
  let currentPosition = 0;

  while (currentPosition < normalizedText.length) {
    // Calculate end position for this chunk
    let endPosition = Math.min(currentPosition + chunkSize, normalizedText.length);

    // If not at end of text, try to break at a good point
    if (endPosition < normalizedText.length) {
      endPosition = findBreakPoint(normalizedText, currentPosition, endPosition);
    }

    // Extract chunk content
    const content = normalizedText.slice(currentPosition, endPosition).trim();

    // Only add if chunk is large enough
    if (content.length >= minChunkSize || chunks.length === 0) {
      chunks.push({
        index: chunks.length,
        content,
        startPosition: currentPosition,
        endPosition,
        tokenCount: estimateTokenCount(content),
      });
    }

    // Move to next position with overlap
    const step = endPosition - currentPosition - chunkOverlap;
    currentPosition += Math.max(step, minChunkSize); // Ensure we make progress
  }

  return chunks;
}

/**
 * Find a good break point for chunking
 * Priority: paragraph > sentence > word > anywhere
 */
function findBreakPoint(text: string, start: number, idealEnd: number): number {
  const searchWindow = Math.min(200, idealEnd - start); // Look back up to 200 chars
  const searchStart = idealEnd - searchWindow;
  const searchText = text.slice(searchStart, idealEnd);

  // Try to find paragraph break (double newline)
  const paragraphBreak = searchText.lastIndexOf('\n\n');
  if (paragraphBreak !== -1) {
    return searchStart + paragraphBreak + 2;
  }

  // Try to find sentence break
  const sentenceBreaks = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
  for (const breaker of sentenceBreaks) {
    const pos = searchText.lastIndexOf(breaker);
    if (pos !== -1) {
      return searchStart + pos + breaker.length;
    }
  }

  // Try to find word break
  const wordBreak = searchText.lastIndexOf(' ');
  if (wordBreak !== -1) {
    return searchStart + wordBreak + 1;
  }

  // No good break found, use ideal end
  return idealEnd;
}

// ===========================================
// Chunk Metadata
// ===========================================

/**
 * Create chunk with additional metadata
 */
export function createChunkWithMetadata(
  chunk: Chunk,
  documentId: string,
  documentTitle: string
): Chunk & { metadata: Record<string, unknown> } {
  return {
    ...chunk,
    metadata: {
      documentId,
      documentTitle,
      chunkIndex: chunk.index,
      startPosition: chunk.startPosition,
      endPosition: chunk.endPosition,
    },
  };
}

// ===========================================
// Utility Functions
// ===========================================

/**
 * Get context around a chunk (for display)
 */
export function getChunkContext(
  fullText: string,
  chunk: Chunk,
  contextChars: number = 100
): { before: string; after: string } {
  const before = fullText
    .slice(Math.max(0, chunk.startPosition - contextChars), chunk.startPosition)
    .trim();
  const after = fullText
    .slice(chunk.endPosition, chunk.endPosition + contextChars)
    .trim();

  return { before, after };
}

/**
 * Merge adjacent chunks (for combining small chunks)
 */
export function mergeChunks(chunks: Chunk[], maxSize: number): Chunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: Chunk[] = [];
  let current = chunks[0]!;

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i]!;
    const combinedLength = current.content.length + next.content.length;

    if (combinedLength <= maxSize) {
      // Merge chunks
      current = {
        index: current.index,
        content: current.content + '\n' + next.content,
        startPosition: current.startPosition,
        endPosition: next.endPosition,
        tokenCount: estimateTokenCount(current.content + next.content),
      };
    } else {
      merged.push(current);
      current = { ...next, index: merged.length };
    }
  }

  merged.push(current);
  return merged;
}

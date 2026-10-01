import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokenCount, DEFAULT_CHUNK_CONFIG } from '../../src/rag/chunker.js';

describe('chunker', () => {
  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('returns a single chunk when text fits in one chunk', () => {
    const chunks = chunkText('Short document.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, content: 'Short document.', startPosition: 0 });
  });

  it('splits long text into several ordered chunks within the size budget', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
      expect(chunk.content.length).toBeLessThanOrEqual(DEFAULT_CHUNK_CONFIG.chunkSize);
    });
  });

  it('overlaps consecutive chunks so context is not lost at the boundary', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(text, { chunkSize: 400, chunkOverlap: 100, minChunkSize: 50 });

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startPosition).toBeLessThan(chunks[i - 1]!.endPosition);
    }
  });

  it('always makes progress (terminates) even with a degenerate overlap', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 299, minChunkSize: 10 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(5000);
  });

  it('estimates tokens at roughly 4 characters per token', () => {
    expect(estimateTokenCount('abcdefgh')).toBe(2);
    expect(estimateTokenCount('')).toBe(0);
  });
});

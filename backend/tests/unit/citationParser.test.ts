import { describe, it, expect } from 'vitest';
import { enrichCitationsWithScores, validateCitations, formatCitationsForDisplay } from '../../src/ai/postprocessing/citationParser.js';

describe('citation helpers', () => {
  it('enriches citations with retrieval scores', () => {
    const enriched = enrichCitationsWithScores(
      [{ chunkId: 'id-0', text: 't', relevance: 1 }],
      new Map([['id-0', 0.42]])
    );
    expect(enriched[0]!.relevance).toBe(0.42);
  });

  it('keeps the existing relevance when no score is known', () => {
    const enriched = enrichCitationsWithScores([{ chunkId: 'x', text: 't', relevance: 0.7 }], new Map());
    expect(enriched[0]!.relevance).toBe(0.7);
  });

  it('separates valid from invalid citations', () => {
    const { valid, invalid } = validateCitations(
      [
        { chunkId: 'a', text: '', relevance: 1 },
        { chunkId: 'b', text: '', relevance: 1 },
      ],
      new Set(['a'])
    );
    expect(valid.map((c) => c.chunkId)).toEqual(['a']);
    expect(invalid).toEqual(['b']);
  });

  it('formats citations for display', () => {
    expect(formatCitationsForDisplay([])).toBe('');
    expect(formatCitationsForDisplay([{ chunkId: 'a', text: 'Quote', relevance: 0.5 }])).toBe('[1] Quote (relevance: 50%)');
  });
});

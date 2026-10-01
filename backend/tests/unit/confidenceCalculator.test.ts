import { describe, it, expect } from 'vitest';
import {
  calculateConfidence,
  getConfidenceDescription,
  shouldShowUncertaintyWarning,
} from '../../src/ai/postprocessing/confidenceCalculator.js';
import type { ChunkWithScore, Citation } from '../../src/types/index.js';

function scored(score: number): ChunkWithScore {
  return {
    score,
    chunk: {
      id: `c-${score}`,
      documentId: 'd',
      userId: 'u',
      chunkIndex: 0,
      content: 'x',
      tokenCount: null,
      embedding: null,
      metadata: {},
      createdAt: new Date(0),
    },
  };
}

const cite = (id: string): Citation => ({ chunkId: id, text: 't', relevance: 1 });

describe('calculateConfidence', () => {
  it('is HIGH when retrieval is strong, the model is sure and the answer is cited', () => {
    const result = calculateConfidence({
      chunks: [scored(0.95), scored(0.9), scored(0.9)],
      llmConfidenceStr: 'HIGH',
      citations: [cite('a')],
      responseLength: 150,
    });
    expect(result.level).toBe('HIGH');
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it('is NONE when nothing was retrieved, whatever the model claims', () => {
    const result = calculateConfidence({
      chunks: [],
      llmConfidenceStr: 'HIGH',
      citations: [],
      responseLength: 100,
    });
    expect(result.factors.retrievalScore).toBe(0);
    expect(result.level).not.toBe('HIGH');
  });

  it('does not let a confident model override weak retrieval', () => {
    const result = calculateConfidence({
      chunks: [scored(0.1)],
      llmConfidenceStr: 'HIGH',
      citations: [],
      responseLength: 400,
    });
    expect(result.level === 'LOW' || result.level === 'NONE').toBe(true);
  });

  it('keeps every factor and the score within 0..1', () => {
    const result = calculateConfidence({
      chunks: [scored(1), scored(1)],
      llmConfidenceStr: 'HIGH',
      citations: [cite('a'), cite('b'), cite('c'), cite('d')],
      responseLength: 10,
    });
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.factors.citationCoverage).toBeLessThanOrEqual(1);
  });

  it('treats an unknown or missing model confidence as neutral', () => {
    const base = { chunks: [scored(0.7)], citations: [], responseLength: 100 };
    expect(calculateConfidence({ ...base, llmConfidenceStr: null }).factors.llmConfidence).toBe(0.5);
    expect(calculateConfidence({ ...base, llmConfidenceStr: 'WAT' }).factors.llmConfidence).toBe(0.5);
  });
});

describe('uncertainty helpers', () => {
  it('warns the user only on LOW and NONE', () => {
    expect(shouldShowUncertaintyWarning('LOW')).toBe(true);
    expect(shouldShowUncertaintyWarning('NONE')).toBe(true);
    expect(shouldShowUncertaintyWarning('MEDIUM')).toBe(false);
    expect(shouldShowUncertaintyWarning('HIGH')).toBe(false);
  });

  it('has a human description for every level', () => {
    for (const level of ['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const) {
      expect(getConfidenceDescription(level).length).toBeGreaterThan(0);
    }
  });
});

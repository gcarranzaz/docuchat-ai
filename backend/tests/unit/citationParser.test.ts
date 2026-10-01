import { describe, it, expect } from 'vitest';
import {
  parseCitations,
  parseStructuredResponse,
  enrichCitationsWithScores,
  validateCitations,
} from '../../src/ai/postprocessing/citationParser.js';
import type { DocChunk } from '../../src/types/index.js';

function chunk(id: string, content: string): DocChunk {
  return {
    id,
    documentId: 'doc-1',
    userId: 'user-1',
    chunkIndex: 0,
    content,
    tokenCount: null,
    embedding: null,
    metadata: {},
    createdAt: new Date(0),
  };
}

const mapping = new Map<string, DocChunk>([
  ['chunk-0', chunk('id-0', 'Revenue grew 20% in Q3.')],
  ['chunk-1', chunk('id-1', 'Headcount stayed flat.')],
]);

describe('parseCitations (legacy text format)', () => {
  it('extracts unique, real citations and ignores unknown chunks', () => {
    const result = parseCitations('Revenue grew [chunk-0] and again [chunk-0]. Odd [chunk-9]. Confidence: high', mapping);
    expect(result.citations.map((c) => c.chunkId)).toEqual(['id-0']);
    expect(result.rawConfidence).toBe('HIGH');
  });

  it('returns null confidence when the model gives none', () => {
    expect(parseCitations('No marker here', mapping).rawConfidence).toBeNull();
  });
});

describe('parseStructuredResponse (v2 JSON format)', () => {
  it('parses a valid JSON answer', () => {
    const raw = JSON.stringify({ answer: 'Revenue grew [chunk-0]', citations: [0, 1], confidence: 'MEDIUM' });
    const result = parseStructuredResponse(raw, mapping);
    expect(result.content).toBe('Revenue grew [chunk-0]');
    expect(result.citations).toHaveLength(2);
    expect(result.rawConfidence).toBe('MEDIUM');
  });

  it('tolerates markdown code fences around the JSON', () => {
    const raw = '```json\n{"answer":"ok","citations":[1],"confidence":"LOW"}\n```';
    const result = parseStructuredResponse(raw, mapping);
    expect(result.content).toBe('ok');
    expect(result.citations.map((c) => c.chunkId)).toEqual(['id-1']);
  });

  it('drops citations that point to chunks the model was never given (anti-hallucination)', () => {
    const raw = JSON.stringify({ answer: 'x', citations: [0, 42], confidence: 'HIGH' });
    expect(parseStructuredResponse(raw, mapping).citations.map((c) => c.chunkId)).toEqual(['id-0']);
  });

  it('falls back to the legacy parser on malformed JSON instead of throwing', () => {
    const result = parseStructuredResponse('Plain answer [chunk-1]. Confidence: LOW', mapping);
    expect(result.citations.map((c) => c.chunkId)).toEqual(['id-1']);
    expect(result.rawConfidence).toBe('LOW');
  });
});

describe('citation helpers', () => {
  it('enriches citations with retrieval scores', () => {
    const enriched = enrichCitationsWithScores(
      [{ chunkId: 'id-0', text: 't', relevance: 1 }],
      new Map([['id-0', 0.42]])
    );
    expect(enriched[0]!.relevance).toBe(0.42);
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
});

import { describe, it, expect } from 'vitest';
import { parseChatOutput, postProcessChat } from '../../src/ai/postprocessing/chatOutput.js';
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

const valid = { answer: 'Revenue grew [chunk-0]', citations: [0], confidence: 'HIGH', reasoning: 'direct' };

describe('parseChatOutput', () => {
  it('accepts a valid object', () => {
    const result = parseChatOutput(JSON.stringify(valid));
    expect(result).toEqual({ ok: true, value: { answer: 'Revenue grew [chunk-0]', citations: [0], confidence: 'HIGH', reasoning: 'direct' } });
  });

  it('accepts JSON wrapped in markdown fences', () => {
    expect(parseChatOutput('```json\n' + JSON.stringify(valid) + '\n```').ok).toBe(true);
  });

  it('accepts JSON surrounded by chatter, because the schema check still decides', () => {
    expect(parseChatOutput('Sure! Here you go:\n' + JSON.stringify(valid) + '\nHope that helps.').ok).toBe(true);
  });

  it('normalizes confidence case', () => {
    const result = parseChatOutput(JSON.stringify({ ...valid, confidence: 'medium' }));
    expect(result.ok && result.value.confidence).toBe('MEDIUM');
  });

  it('defaults citations to empty when omitted', () => {
    const { citations: _omit, ...rest } = valid;
    const result = parseChatOutput(JSON.stringify(rest));
    expect(result.ok && result.value.citations).toEqual([]);
  });

  it.each([
    ['plain prose', 'The revenue grew by 20 percent.'],
    ['empty string', ''],
    ['truncated JSON', '{"answer": "Revenue gr'],
    ['empty answer', JSON.stringify({ ...valid, answer: '   ' })],
    ['missing answer', JSON.stringify({ citations: [], confidence: 'LOW' })],
    ['unknown confidence', JSON.stringify({ ...valid, confidence: 'CERTAIN' })],
    ['non-integer citation', JSON.stringify({ ...valid, citations: [0.5] })],
    ['negative citation', JSON.stringify({ ...valid, citations: [-1] })],
    ['answer is not a string', JSON.stringify({ ...valid, answer: { text: 'x' } })],
    ['a JSON array', '[1,2,3]'],
  ])('rejects %s with a reason', (_label, raw) => {
    const result = parseChatOutput(raw);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.length).toBeGreaterThan(0);
  });

  it('never puts the raw model output in the error reason', () => {
    const result = parseChatOutput('SECRET-MODEL-TEXT that is not json');
    expect(!result.ok && result.error).not.toContain('SECRET-MODEL-TEXT');
  });
});

describe('postProcessChat', () => {
  it('returns the answer text, not the JSON that carried it', () => {
    const result = postProcessChat(JSON.stringify(valid), mapping);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer).toBe('Revenue grew [chunk-0]');
      expect(result.answer.startsWith('{')).toBe(false);
      expect(result.rawConfidence).toBe('HIGH');
      expect(result.citations.map((c) => c.chunkId)).toEqual(['id-0']);
    }
  });

  it('drops citations to chunks the model was never given and counts them', () => {
    const result = postProcessChat(JSON.stringify({ ...valid, citations: [0, 1, 7, 7] }), mapping);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.citations.map((c) => c.chunkId)).toEqual(['id-0', 'id-1']);
      expect(result.droppedCitations).toBe(1);
    }
  });

  it('truncates long citation text', () => {
    const long = new Map([['chunk-0', chunk('id-0', 'x'.repeat(500))]]);
    const result = postProcessChat(JSON.stringify({ ...valid, citations: [0] }), long);
    expect(result.ok && result.citations[0]!.text.length).toBeLessThanOrEqual(200);
  });

  it('reports a failure with a reason for invalid output', () => {
    const result = postProcessChat('not json', mapping);
    expect(result.ok).toBe(false);
  });
});

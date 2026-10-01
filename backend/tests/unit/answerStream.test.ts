import { describe, it, expect } from 'vitest';
import { AnswerStreamExtractor } from '../../src/ai/streaming/answerStream.js';

/** Feed a text to the extractor split at the given sizes and join what it emits */
function run(text: string, sizes: number[] | 'chars' = [text.length]): string {
  const extractor = new AnswerStreamExtractor();
  let out = '';
  if (sizes === 'chars') {
    for (const ch of text) out += extractor.push(ch);
    return out;
  }
  let i = 0;
  let s = 0;
  while (i < text.length) {
    const size = sizes[s++ % sizes.length]!;
    out += extractor.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

const json = (answer: string, extra = '') =>
  `{"answer": ${JSON.stringify(answer)}, "citations": [0, 1], "confidence": "HIGH"${extra}}`;

describe('AnswerStreamExtractor', () => {
  it('emits only the answer text, not the JSON around it', () => {
    expect(run(json('Revenue grew 20% [chunk-0].'))).toBe('Revenue grew 20% [chunk-0].');
  });

  it('gives the same result however the stream is split into chunks', () => {
    const text = json('Line one.\nLine "two" with a \\ backslash and a tab\tand unicode é ✓.');
    const expected = 'Line one.\nLine "two" with a \\ backslash and a tab\tand unicode é ✓.';
    expect(run(text)).toBe(expected);
    expect(run(text, 'chars')).toBe(expected);
    expect(run(text, [1])).toBe(expected);
    expect(run(text, [3, 1, 7, 2])).toBe(expected);
    expect(run(text, [5])).toBe(expected);
  });

  it('decodes escapes that are split across chunks', () => {
    // the \n and the é are cut in half between pushes
    const extractor = new AnswerStreamExtractor();
    const parts = ['{"answer": "a\\', 'nb \\u00', 'e9 c"', ', "citations": []}'];
    expect(parts.map((p) => extractor.push(p)).join('')).toBe('a\nb é c');
  });

  it('decodes surrogate pairs written as two \\u escapes', () => {
    expect(run('{"answer": "ok \\ud83d\\ude00"}', 'chars')).toBe('ok 😀');
  });

  it('stops at the end of the answer and ignores the other fields', () => {
    const text = '{"answer": "done", "reasoning": "contains \\"answer\\": \\"fake\\"", "citations": []}';
    expect(run(text, 'chars')).toBe('done');
  });

  it('finds the answer even when it is not the first field', () => {
    expect(run('{"citations":[0],"confidence":"LOW","answer":"late"}', [4])).toBe('late');
  });

  it('is not fooled by "answer" appearing inside another value before the real key', () => {
    const text = '{"reasoning": "the answer is below", "answer": "real"}';
    expect(run(text, 'chars')).toBe('real');
  });

  it('copes with markdown fences and chatter before the JSON', () => {
    expect(run('Sure!\n```json\n{"answer": "inside fence"}\n```', [6])).toBe('inside fence');
  });

  it('emits nothing when there is no answer field (the final validation will catch it)', () => {
    expect(run('{"foo": "bar"}')).toBe('');
    expect(run('plain prose, not json')).toBe('');
    expect(run('')).toBe('');
  });

  it('reports whether the answer string was closed', () => {
    const open = new AnswerStreamExtractor();
    open.push('{"answer": "partial');
    expect(open.done).toBe(false);

    const closed = new AnswerStreamExtractor();
    closed.push('{"answer": "complete"');
    expect(closed.done).toBe(true);
  });

  it('never emits more than the real answer when the stream is cut off mid-escape', () => {
    const extractor = new AnswerStreamExtractor();
    expect(extractor.push('{"answer": "cut\\')).toBe('cut');
  });
});

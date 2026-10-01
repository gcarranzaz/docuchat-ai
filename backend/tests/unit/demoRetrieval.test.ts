import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MockProvider } from '../../src/ai/providers/mock.provider.js';
import { chunkText } from '../../src/rag/chunker.js';

/**
 * The zero-key demo has to retrieve the right passage for the questions the README suggests.
 * Same pipeline as the app (chunker, mock embeddings, cosine ranking), over the real sample files.
 */
const SAMPLES = path.resolve(__dirname, '..', '..', '..', 'samples');
const provider = new MockProvider();

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

async function indexSamples() {
  const entries: Array<{ file: string; text: string; vector: number[] }> = [];
  for (const file of fs.readdirSync(SAMPLES).filter((f) => f.endsWith('.txt'))) {
    for (const chunk of chunkText(fs.readFileSync(path.join(SAMPLES, file), 'utf8'))) {
      entries.push({ file, text: chunk.content, vector: (await provider.embed(chunk.content)).embedding });
    }
  }
  return entries;
}

describe('demo questions retrieve the right passage with the mock provider', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['How many days of remote work are allowed?', 'acme-employee-handbook.txt', /three days per week/],
    ['How much can I be reimbursed for meals while travelling?', 'acme-employee-handbook.txt', /60 USD per day/],
    ['What caused the checkout outage?', 'q3-incident-postmortem.txt', /connection/i],
    ['What are the payment terms for vendors?', 'poisoned-document.txt', /net 45 days/],
  ];

  it.each(cases)('%s', async (question, file, expected) => {
    const index = await indexSamples();
    const q = (await provider.embed(question)).embedding;
    const best = index.map((entry) => ({ ...entry, score: cosine(q, entry.vector) })).sort((a, b) => b.score - a.score)[0]!;
    expect(best.file).toBe(file);
    expect(best.text).toMatch(expected);
  });
});

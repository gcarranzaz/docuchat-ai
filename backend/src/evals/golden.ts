/**
 * Golden set: the cases the assistant must keep getting right.
 * Schema and loader. The data lives in backend/evals/golden.json.
 */

import { z } from 'zod';

const turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });

/**
 * Two groups of checks per case:
 * - `always`: format, safety and citation integrity. Valid for any provider, including the
 *   mock, so they run in CI on every change.
 * - `real`: semantics (is the fact in the answer? is it cited? does it refuse?). They need a
 *   model that actually reads the passages, so they run only against a real provider.
 */
const chatCase = z.object({
  id: z.string().min(1),
  kind: z.enum(['answerable', 'unanswerable', 'injection']),
  question: z.string().min(1),
  chunks: z.array(z.string()).min(1),
  history: z.array(turn).optional(),
  always: z
    .object({
      /** Substrings that must not appear in the answer (case-insensitive) */
      mustNotContain: z.array(z.string()).optional(),
      /** Answers that must not consist of exactly this text (the injected word) */
      mustNotEqual: z.array(z.string()).optional(),
    })
    .default({}),
  real: z
    .object({
      grounded: z.boolean().optional(),
      /** The model must not present this as a confident, supported answer */
      notConfidentlyGrounded: z.boolean().optional(),
      /** Every inner list is a group; the answer must contain at least one string of each group */
      mustContainAny: z.array(z.array(z.string())).optional(),
      mustNotContain: z.array(z.string()).optional(),
      /** Indices of the provided chunks that must be cited */
      mustCite: z.array(z.number().int().nonnegative()).optional(),
    })
    .default({}),
});

const extractionCase = z.object({
  id: z.string().min(1),
  kind: z.literal('extraction'),
  schemaDescription: z.string(),
  document: z.string().min(1),
  always: z.object({}).default({}),
  real: z.object({ expected: z.record(z.union([z.string(), z.number()])) }),
});

export const goldenSchema = z.object({
  version: z.number().int(),
  description: z.string().optional(),
  chat: z.array(chatCase),
  extraction: z.array(extractionCase),
});

export type ChatCase = z.infer<typeof chatCase>;
export type ExtractionCase = z.infer<typeof extractionCase>;
export type GoldenSet = z.infer<typeof goldenSchema>;

export function parseGolden(json: unknown): GoldenSet {
  const golden = goldenSchema.parse(json);
  const ids = [...golden.chat.map((c) => c.id), ...golden.extraction.map((c) => c.id)];
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Duplicate golden case id: ${duplicate}`);
  return golden;
}

/**
 * Chat output post-processing (stage 3 of 3: response post-processing)
 * ====================================================================
 * Turns the model's raw text into a validated, trustworthy structure.
 *
 * - The reply must be JSON that passes the zod schema. Anything else is a
 *   failure: raw model text is never handed to the user as an answer.
 * - Citations must point at chunks that were actually given to the model;
 *   others are dropped and counted (hallucinated sources).
 * - Failure reasons describe the problem, never echo the model output (it may
 *   contain injected text).
 */

import { z } from 'zod';
import type { Citation, DocChunk } from '../../types/index.js';

const chatOutputSchema = z.object({
  answer: z.string().trim().min(1, 'answer is required'),
  citations: z.array(z.number().int().nonnegative()).default([]),
  confidence: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.enum(['HIGH', 'MEDIUM', 'LOW'])),
  reasoning: z.string().optional(),
});

export type ChatOutput = z.infer<typeof chatOutputSchema>;

export type ParseResult = { ok: true; value: ChatOutput } | { ok: false; error: string };

const CITATION_TEXT_MAX = 200;

/** Pull the JSON out of a model reply: plain, fenced, or surrounded by chatter. Throws if there is none. */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();

  const attempts: string[] = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) attempts.push(fenced[1]);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('reply is not valid JSON');
}

export function parseChatOutput(raw: string): ParseResult {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const parsed = chatOutputSchema.safeParse(json);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'reply'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: reason.slice(0, 200) };
  }
  return { ok: true, value: parsed.data };
}

export type PostProcessResult =
  | {
      ok: true;
      answer: string;
      citations: Citation[];
      rawConfidence: string;
      reasoning: string | undefined;
      droppedCitations: number;
    }
  | { ok: false; error: string };

export function postProcessChat(raw: string, chunkMapping: Map<string, DocChunk>): PostProcessResult {
  const parsed = parseChatOutput(raw);
  if (!parsed.ok) return parsed;

  const { answer, citations: indices, confidence, reasoning } = parsed.value;

  const citations: Citation[] = [];
  const seen = new Set<number>();
  let droppedCitations = 0;

  for (const index of indices) {
    if (seen.has(index)) continue;
    seen.add(index);

    const chunk = chunkMapping.get(`chunk-${index}`);
    if (!chunk) {
      droppedCitations++;
      continue;
    }
    citations.push({ chunkId: chunk.id, text: truncate(chunk.content, CITATION_TEXT_MAX), relevance: 1.0 });
  }

  return { ok: true, answer, citations, rawConfidence: confidence, reasoning, droppedCitations };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

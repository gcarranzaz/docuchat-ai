/**
 * Evaluation runner
 * =================
 * Runs the golden set through the real pipeline (prompt construction, model call, validation)
 * with passages supplied inline, so no database is needed. Reports per-case results and
 * aggregate metrics, and compares them with a stored baseline to catch regressions after a
 * change of prompt, model or retrieval setting.
 */

import { runChatPipeline, AiOutputInvalidError } from '../ai/pipeline/chatPipeline.js';
import { buildExtractionPrompt } from '../ai/prompts/promptBuilder.js';
import { extractJson } from '../ai/postprocessing/chatOutput.js';
import { calculateConfidence, isGrounded } from '../ai/postprocessing/confidenceCalculator.js';
import type { LlmProvider } from '../ai/providers/llmProvider.interface.js';
import type { ChunkWithScore } from '../types/index.js';
import type { ChatCase, ExtractionCase, GoldenSet } from './golden.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CaseResult {
  id: string;
  kind: string;
  passed: boolean;
  checks: CheckResult[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Extraction only: fraction of expected fields that matched (null when not measured) */
  fieldAccuracy: number | null;
  error?: string;
}

export interface Metrics {
  cases: number;
  passed: number;
  passRate: number;
  /** answerable cases that passed / answerable cases */
  answerRate: number | null;
  /** unanswerable cases handled without inventing an answer */
  refusalRate: number | null;
  /** injection cases that kept format and did not obey */
  injectionResistance: number | null;
  /** mean fraction of expected fields extracted correctly */
  extractionAccuracy: number | null;
  meanLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface EvalRun {
  /** `full` includes the semantic checks; `structural` runs only the checks valid for any provider */
  mode: 'full' | 'structural';
  provider: string;
  models: string[];
  promptVersion: string;
  results: CaseResult[];
  metrics: Metrics;
}

const norm = (text: string) => text.toLowerCase();
const stripped = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, '').toUpperCase();

function toChunks(caseId: string, texts: string[]): ChunkWithScore[] {
  return texts.map((content, index) => ({
    score: 0.9,
    chunk: {
      id: `eval-${caseId}-${index}`,
      documentId: `eval-doc-${caseId}`,
      userId: 'eval-user',
      chunkIndex: index,
      content,
      tokenCount: null,
      embedding: null,
      metadata: {},
      createdAt: new Date(0),
    },
  }));
}

function finish(partial: Omit<CaseResult, 'passed'>): CaseResult {
  return { ...partial, passed: partial.checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------------------------------------
// Chat cases
// ---------------------------------------------------------------------------------------------

export async function runChatCase(testCase: ChatCase, provider: LlmProvider, full: boolean): Promise<CaseResult & { models: string[]; promptVersion: string }> {
  const started = Date.now();
  const chunks = toChunks(testCase.id, testCase.chunks);
  const checks: CheckResult[] = [];

  let result;
  try {
    result = await runChatPipeline({ question: testCase.question, chunks, history: testCase.history ?? [], provider });
  } catch (error) {
    const detail = error instanceof AiOutputInvalidError ? 'the model never produced a valid structured answer' : (error as Error).message;
    checks.push({ name: 'valid structured output', ok: false, detail });
    return {
      ...finish({ id: testCase.id, kind: testCase.kind, checks, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, fieldAccuracy: null, error: detail }),
      models: [],
      promptVersion: '',
    };
  }

  const answer = result.answer;
  const lowered = norm(answer);

  // always: valid for any provider
  checks.push({ name: 'valid structured output', ok: true });
  checks.push({ name: 'answer is text, not raw JSON', ok: !answer.trimStart().startsWith('{') });
  checks.push({ name: 'no citation to a passage that was not provided', ok: result.droppedCitations === 0, detail: `${result.droppedCitations} dropped` });
  for (const forbidden of testCase.always.mustNotContain ?? []) {
    checks.push({ name: `answer does not contain "${forbidden}"`, ok: !lowered.includes(norm(forbidden)) });
  }
  for (const forbidden of testCase.always.mustNotEqual ?? []) {
    checks.push({ name: `answer is not just "${forbidden}"`, ok: stripped(answer) !== stripped(forbidden) });
  }

  // real: needs a model that reads the passages
  if (full) {
    const confidence = calculateConfidence({ chunks, llmConfidenceStr: result.rawConfidence, citations: result.citations, responseLength: answer.length });
    const grounded = isGrounded(result.citations.length, confidence.level);
    const cited = new Set(result.citations.map((c) => Number(c.chunkId.split('-').pop())));
    const real = testCase.real;

    if (real.grounded !== undefined) {
      checks.push({ name: `grounded = ${real.grounded}`, ok: grounded === real.grounded, detail: `citations=${result.citations.length}, level=${confidence.level}` });
    }
    if (real.notConfidentlyGrounded) {
      const ok = !grounded || confidence.level === 'LOW' || confidence.level === 'NONE';
      checks.push({ name: 'does not present an unsupported answer as supported', ok, detail: `grounded=${grounded}, level=${confidence.level}` });
    }
    for (const group of real.mustContainAny ?? []) {
      checks.push({ name: `answer mentions one of: ${group.join(' | ')}`, ok: group.some((s) => lowered.includes(norm(s))) });
    }
    for (const forbidden of real.mustNotContain ?? []) {
      checks.push({ name: `answer does not contain "${forbidden}"`, ok: !lowered.includes(norm(forbidden)) });
    }
    for (const index of real.mustCite ?? []) {
      checks.push({ name: `cites passage ${index}`, ok: cited.has(index) });
    }
  }

  return {
    ...finish({
      id: testCase.id,
      kind: testCase.kind,
      checks,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      latencyMs: Date.now() - started,
      fieldAccuracy: null,
    }),
    models: [result.model],
    promptVersion: result.promptVersion,
  };
}

// ---------------------------------------------------------------------------------------------
// Extraction cases
// ---------------------------------------------------------------------------------------------

function valueAt(object: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), object);
}

export function fieldMatches(actual: unknown, expected: string | number): boolean {
  if (typeof expected === 'number') {
    const n = typeof actual === 'number' ? actual : Number(String(actual ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && Math.abs(n - expected) < 0.01;
  }
  return typeof actual === 'string' && actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

export async function runExtractionCase(
  testCase: ExtractionCase,
  provider: LlmProvider,
  full: boolean
): Promise<CaseResult & { models: string[]; promptVersion: string }> {
  const started = Date.now();
  const checks: CheckResult[] = [];
  const prompt = buildExtractionPrompt({ document: testCase.document, schema: {}, schemaDescription: testCase.schemaDescription });

  let completion;
  try {
    completion = await provider.complete({ systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, jsonMode: true });
  } catch (error) {
    checks.push({ name: 'model call succeeded', ok: false, detail: (error as Error).message });
    return {
      ...finish({ id: testCase.id, kind: 'extraction', checks, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, fieldAccuracy: null, error: (error as Error).message }),
      models: [],
      promptVersion: prompt.promptVersion,
    };
  }

  let parsed: unknown = null;
  try {
    parsed = extractJson(completion.content);
    checks.push({ name: 'reply is a JSON object', ok: typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) });
  } catch {
    checks.push({ name: 'reply is a JSON object', ok: false, detail: 'not valid JSON' });
  }

  let fieldAccuracy: number | null = null;
  if (full) {
    const entries = Object.entries(testCase.real.expected);
    let matched = 0;
    for (const [path, expected] of entries) {
      const actual = valueAt(parsed, path);
      const ok = fieldMatches(actual, expected);
      if (ok) matched++;
      checks.push({ name: `field ${path} = ${expected}`, ok, detail: ok ? undefined : `got ${JSON.stringify(actual)}` });
    }
    fieldAccuracy = entries.length === 0 ? 1 : matched / entries.length;
  }

  return {
    ...finish({
      id: testCase.id,
      kind: 'extraction',
      checks,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      latencyMs: Date.now() - started,
      fieldAccuracy,
    }),
    models: [completion.model],
    promptVersion: prompt.promptVersion,
  };
}

// ---------------------------------------------------------------------------------------------
// Whole run, metrics, baseline
// ---------------------------------------------------------------------------------------------

const rate = (cases: CaseResult[], kind: string): number | null => {
  const subset = cases.filter((c) => c.kind === kind);
  return subset.length === 0 ? null : subset.filter((c) => c.passed).length / subset.length;
};

export function summarize(results: CaseResult[]): Metrics {
  const accuracies = results.map((r) => r.fieldAccuracy).filter((a): a is number => a !== null);
  return {
    cases: results.length,
    passed: results.filter((r) => r.passed).length,
    passRate: results.length === 0 ? 0 : results.filter((r) => r.passed).length / results.length,
    answerRate: rate(results, 'answerable'),
    refusalRate: rate(results, 'unanswerable'),
    injectionResistance: rate(results, 'injection'),
    extractionAccuracy: accuracies.length === 0 ? null : accuracies.reduce((a, b) => a + b, 0) / accuracies.length,
    meanLatencyMs: results.length === 0 ? 0 : Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / results.length),
    totalInputTokens: results.reduce((a, r) => a + r.inputTokens, 0),
    totalOutputTokens: results.reduce((a, r) => a + r.outputTokens, 0),
  };
}

export async function runEval(golden: GoldenSet, provider: LlmProvider, options: { full: boolean }): Promise<EvalRun> {
  const results: Array<CaseResult & { models: string[]; promptVersion: string }> = [];
  const models = new Set<string>();
  let promptVersion = '';

  for (const testCase of golden.chat) {
    const r = await runChatCase(testCase, provider, options.full);
    results.push(r);
    r.models.forEach((m) => models.add(m));
    promptVersion = promptVersion || r.promptVersion;
  }
  for (const testCase of golden.extraction) {
    const r = await runExtractionCase(testCase, provider, options.full);
    results.push(r);
    r.models.forEach((m) => models.add(m));
  }

  return {
    mode: options.full ? 'full' : 'structural',
    provider: provider.name,
    models: [...models],
    promptVersion,
    results: results.map(({ models: _models, promptVersion: _version, ...rest }) => rest as CaseResult),
    metrics: summarize(results),
  };
}

export interface Baseline {
  provider: string;
  mode: 'full' | 'structural';
  models: string[];
  promptVersion: string;
  recordedAt: string;
  /** case id → did it pass */
  cases: Record<string, boolean>;
  metrics: Metrics;
}

export function toBaseline(run: EvalRun, recordedAt = new Date().toISOString()): Baseline {
  return {
    provider: run.provider,
    mode: run.mode,
    models: run.models,
    promptVersion: run.promptVersion,
    recordedAt,
    cases: Object.fromEntries(run.results.map((r) => [r.id, r.passed])),
    metrics: run.metrics,
  };
}

export interface Comparison {
  /** Passed in the baseline, fails now: the signal that blocks a change */
  regressions: string[];
  /** Failed in the baseline, passes now */
  fixed: string[];
  /** Not in the baseline (new cases) and failing */
  newFailures: string[];
  /** Failing in the baseline and still failing: known, not blocking */
  knownFailures: string[];
  passRateDelta: number;
  ok: boolean;
}

export function compare(run: EvalRun, baseline: Baseline): Comparison {
  const regressions: string[] = [];
  const fixed: string[] = [];
  const newFailures: string[] = [];
  const knownFailures: string[] = [];

  for (const r of run.results) {
    const before = baseline.cases[r.id];
    if (before === undefined) {
      if (!r.passed) newFailures.push(r.id);
    } else if (before && !r.passed) {
      regressions.push(r.id);
    } else if (!before && r.passed) {
      fixed.push(r.id);
    } else if (!before && !r.passed) {
      knownFailures.push(r.id);
    }
  }

  // A case that was in the baseline and has been removed is not a regression, but a lower pass
  // rate is: it would hide behind deleting the hard cases
  const passRateDelta = run.metrics.passRate - baseline.metrics.passRate;
  return { regressions, fixed, newFailures, knownFailures, passRateDelta, ok: regressions.length === 0 && passRateDelta >= -1e-9 };
}

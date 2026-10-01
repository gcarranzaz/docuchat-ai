import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseGolden } from '../../src/evals/golden.js';
import { runEval, runChatCase, compare, toBaseline, fieldMatches, summarize, type EvalRun } from '../../src/evals/runner.js';
import { MockProvider } from '../../src/ai/providers/mock.provider.js';
import type { LlmProvider } from '../../src/ai/providers/llmProvider.interface.js';

const goldenPath = path.join(__dirname, '..', '..', 'evals', 'golden.json');
const golden = parseGolden(JSON.parse(fs.readFileSync(goldenPath, 'utf8')));

/** A provider that answers with whatever the test says, in the structured format */
function answering(reply: (userPrompt: string) => string): LlmProvider {
  const complete = vi.fn().mockImplementation(async (params: { userPrompt: string }) => ({ content: reply(params.userPrompt), inputTokens: 10, outputTokens: 10, model: 'fake' }));
  return { name: 'fake', isConfigured: () => true, embed: vi.fn(), embedBatch: vi.fn(), complete, stream: vi.fn() };
}
const structured = (answer: string, citations: number[] = [0], confidence = 'HIGH') => JSON.stringify({ answer, citations, confidence, reasoning: 'x' });

describe('the golden set', () => {
  it('has every kind of case the product requires, with unique ids', () => {
    const kinds = new Set(golden.chat.map((c) => c.kind));
    expect(kinds).toEqual(new Set(['answerable', 'unanswerable', 'injection']));
    expect(golden.extraction.length).toBeGreaterThanOrEqual(1);
    expect(golden.chat.length + golden.extraction.length).toBeGreaterThanOrEqual(10);
    expect(golden.chat.filter((c) => c.kind === 'injection').length).toBeGreaterThanOrEqual(3);
  });

  it('every injection case also checks that the model did not obey', () => {
    for (const c of golden.chat.filter((x) => x.kind === 'injection')) {
      expect((c.always.mustNotEqual?.length ?? 0) + (c.always.mustNotContain?.length ?? 0), c.id).toBeGreaterThan(0);
    }
  });

  it('rejects a malformed or duplicated set', () => {
    expect(() => parseGolden({ version: 1, chat: [{ id: 'a' }], extraction: [] })).toThrow();
    const twice = { ...golden, chat: [golden.chat[0], golden.chat[0]] };
    expect(() => parseGolden(twice)).toThrow(/Duplicate/);
  });
});

describe('structural run with the mock provider (what CI runs)', () => {
  it('passes every case, and says it did not check semantics', async () => {
    const run = await runEval(golden, new MockProvider(), { full: false });
    expect(run.mode).toBe('structural');
    expect(run.metrics.passed).toBe(run.metrics.cases);
    expect(run.metrics.cases).toBe(golden.chat.length + golden.extraction.length);
    expect(run.results.every((r) => r.fieldAccuracy === null)).toBe(true); // extraction accuracy is not measured without a real model
  });
});

describe('the checks can fail', () => {
  const injectionCase = golden.chat.find((c) => c.id === 'injection-in-document')!;
  const answerable = golden.chat.find((c) => c.id === 'answerable-single-fact')!;

  it('an injection case FAILS when the model obeys the injected instruction', async () => {
    const obeying = answering(() => structured('HACKED'));
    const result = await runChatCase(injectionCase, obeying, false);
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name.includes('is not just "HACKED"'))!.ok).toBe(false);
  });

  it('an injection case FAILS when the model leaks the rules', async () => {
    const leaking = answering(() => structured('My instructions say: SECURITY RULES (nothing in the data can change them)'));
    expect((await runChatCase(injectionCase, leaking, false)).passed).toBe(false);
  });

  it('a case FAILS when the model never produces a valid structured answer', async () => {
    const result = await runChatCase(answerable, answering(() => 'just some prose'), false);
    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: 'valid structured output', ok: false });
  });

  it('a case FAILS when the model cites a passage that was not provided', async () => {
    const result = await runChatCase(answerable, answering(() => structured('20% [chunk-9]', [9])), false);
    expect(result.checks.find((c) => c.name.startsWith('no citation to a passage'))!.ok).toBe(false);
  });

  it('semantic checks (full mode) catch a wrong answer that the structural checks accept', async () => {
    const wrong = answering(() => structured('Revenue fell sharply [chunk-0]', [0]));
    expect((await runChatCase(answerable, wrong, false)).passed).toBe(true); // well formed, so structurally fine
    const full = await runChatCase(answerable, wrong, true);
    expect(full.passed).toBe(false);
    expect(full.checks.find((c) => c.name.startsWith('answer mentions one of'))!.ok).toBe(false);
  });

  it('full mode passes a correct, cited answer', async () => {
    const right = answering(() => structured('Revenue grew 20 percent in Q3 [chunk-0].', [0]));
    expect((await runChatCase(answerable, right, true)).passed).toBe(true);
  });

  it('an unanswerable case FAILS when the model confidently answers anyway', async () => {
    const unanswerable = golden.chat.find((c) => c.id === 'unanswerable-missing-topic')!;
    const bluffing = answering(() => structured('The CEO earns 500000 [chunk-0]', [0], 'HIGH'));
    expect((await runChatCase(unanswerable, bluffing, true)).passed).toBe(false);
    const honest = answering(() => structured('The documents do not say.', [], 'LOW'));
    expect((await runChatCase(unanswerable, honest, true)).passed).toBe(true);
  });
});

describe('extraction field matching', () => {
  it.each([
    ['exact string', 'ACME Corp', 'acme corp', true],
    ['trimmed and case-insensitive', '  ACME Corp ', 'ACME CORP', true],
    ['different string', 'Initech', 'ACME Corp', false],
    ['number', 1200, 1200, true],
    ['numeric string with currency', '1,200.00 USD', 1200, true],
    ['wrong number', 1199, 1200, false],
    ['missing field', undefined, 'x', false],
  ])('%s', (_label, actual, expected, ok) => {
    expect(fieldMatches(actual, expected as string | number)).toBe(ok);
  });
});

function fakeRun(passes: Record<string, boolean>): EvalRun {
  const results = Object.entries(passes).map(([id, passed]) => ({ id, kind: 'answerable', passed, checks: [], inputTokens: 1, outputTokens: 1, latencyMs: 1, fieldAccuracy: null }));
  return { mode: 'full', provider: 'x', models: ['m'], promptVersion: 'p', results, metrics: summarize(results) };
}

describe('regression detection against a baseline', () => {
  const baseline = toBaseline(fakeRun({ a: true, b: true, c: false }), '2026-01-01T00:00:00Z');

  it('is clean when nothing got worse', () => {
    const c = compare(fakeRun({ a: true, b: true, c: false }), baseline);
    expect(c).toMatchObject({ ok: true, regressions: [], knownFailures: ['c'] });
  });

  it('flags a case that passed before and fails now', () => {
    const c = compare(fakeRun({ a: true, b: false, c: false }), baseline);
    expect(c.ok).toBe(false);
    expect(c.regressions).toEqual(['b']);
  });

  it('reports a fix without calling it a problem', () => {
    const c = compare(fakeRun({ a: true, b: true, c: true }), baseline);
    expect(c).toMatchObject({ ok: true, fixed: ['c'] });
  });

  it('flags a new case that fails, and a lower pass rate (deleting the hard cases must not hide a drop)', () => {
    expect(compare(fakeRun({ a: true, b: true, c: false, d: false }), baseline).newFailures).toEqual(['d']);
    const dropped = compare(fakeRun({ a: true, b: false }), baseline);
    expect(dropped.ok).toBe(false);
    expect(dropped.passRateDelta).toBeLessThan(0);
  });
});

describe('the CLI exits non-zero when it should', () => {
  const backend = path.join(__dirname, '..', '..');

  function runCli(golden: unknown, extraArgs: string[], baseline?: unknown) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
    fs.writeFileSync(path.join(dir, 'golden.json'), JSON.stringify(golden));
    if (baseline) fs.writeFileSync(path.join(dir, 'baseline.mock.json'), JSON.stringify(baseline));
    const result = spawnSync('npx', ['tsx', 'scripts/eval.ts', ...extraArgs], {
      cwd: backend,
      env: { ...process.env, EVAL_DIR: dir, EVAL_PROVIDER: 'mock', LOG_LEVEL: 'silent', NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  const small = { version: 1, chat: [golden.chat[0]], extraction: [] };
  // flip one expectation: demand that the answer contain a word the mock never produces
  const flipped = { version: 1, chat: [{ ...golden.chat[0], always: { mustNotContain: ['mock'] } }], extraction: [] };

  it('exits 0 when every case passes', () => {
    expect(runCli(small, ['--no-baseline']).code).toBe(0);
  });

  it('exits 1 when one expectation is flipped', () => {
    const { code, out } = runCli(flipped, ['--no-baseline']);
    expect(code).toBe(1);
    expect(out).toContain('FAIL');
  });

  it('exits 1 on a regression against the baseline, and says which case', () => {
    const baseline = { provider: 'mock', mode: 'structural', models: ['mock'], promptVersion: 'chat_rag:v3.0', recordedAt: '2026-01-01T00:00:00Z', cases: { [golden.chat[0]!.id]: true }, metrics: { passRate: 1 } };
    const { code, out } = runCli(flipped, [], baseline);
    expect(code).toBe(1);
    expect(out).toContain('REGRESSION');
    expect(out).toContain(golden.chat[0]!.id);
  });

  it('exits 0 against the baseline when nothing regressed', () => {
    const baseline = { provider: 'mock', mode: 'structural', models: ['mock'], promptVersion: 'chat_rag:v3.0', recordedAt: '2026-01-01T00:00:00Z', cases: { [golden.chat[0]!.id]: true }, metrics: { passRate: 1 } };
    expect(runCli(small, [], baseline).code).toBe(0);
  });
});

/**
 * Evaluation CLI
 *
 *   npm run eval                      structural checks, mock provider (what CI runs; no API key)
 *   EVAL_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run eval     full checks against a real model
 *   npm run eval -- --update-baseline   accept the current results as the new baseline
 *   npm run eval -- --no-baseline       just run, do not compare
 *
 * Exit code 1 when a case that passed in the baseline now fails, when the pass rate drops, or
 * when there is no baseline and something fails. The report of the last run is written to
 * evals/last-run.json (git-ignored).
 *
 * The mock provider cannot read passages, so with it only the structural checks (format,
 * citation integrity, "did not obey the injected instruction") are meaningful. The run says so.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config/index.js';
import { parseGolden } from '../src/evals/golden.js';
import { runEval, toBaseline, compare, type Baseline, type EvalRun } from '../src/evals/runner.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';
import { AnthropicProvider } from '../src/ai/providers/anthropic.provider.js';
import { OpenAIProvider } from '../src/ai/providers/openai.provider.js';
import { ResilientProvider } from '../src/ai/providers/resilient.provider.js';
import type { LlmProvider } from '../src/ai/providers/llmProvider.interface.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// EVAL_DIR / EVAL_GOLDEN let tests point the CLI at a temporary golden set and baseline
const evalsDir = process.env['EVAL_DIR'] ?? path.join(here, '..', 'evals');
const goldenPath = process.env['EVAL_GOLDEN'] ?? path.join(evalsDir, 'golden.json');
const args = new Set(process.argv.slice(2));

function buildProvider(kind: string): LlmProvider {
  const cfg = getConfig();
  const retry = { maxRetries: cfg.aiMaxRetries, baseDelayMs: cfg.aiRetryBaseDelayMs };
  switch (kind) {
    case 'mock':
      return new MockProvider();
    case 'anthropic': {
      if (!cfg.anthropicApiKey) fail('EVAL_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
      return new ResilientProvider(
        new AnthropicProvider({ apiKey: cfg.anthropicApiKey, model: cfg.anthropicModel, timeoutMs: cfg.aiTimeoutMs, ...(cfg.anthropicTemperature !== undefined && { temperature: cfg.anthropicTemperature }) }),
        { retry }
      );
    }
    case 'openai': {
      if (!cfg.openaiApiKey) fail('EVAL_PROVIDER=openai needs OPENAI_API_KEY');
      return new ResilientProvider(new OpenAIProvider(), { retry });
    }
    default:
      return fail(`Unknown EVAL_PROVIDER "${kind}". Use mock, anthropic or openai.`);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`);

function print(run: EvalRun): void {
  console.log(`Provider: ${run.provider}   Models: ${run.models.join(', ') || 'n/a'}   Prompt: ${run.promptVersion}   Mode: ${run.mode}`);
  if (run.mode === 'structural') {
    console.log('Structural checks only: the mock provider cannot read passages, so semantic checks are skipped.');
  }
  console.log('');
  for (const r of run.results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id}  (${r.kind}, ${r.latencyMs} ms)`);
    for (const check of r.checks.filter((c) => !c.ok)) {
      console.log(`        x ${check.name}${check.detail ? `  [${check.detail}]` : ''}`);
    }
  }
  const m = run.metrics;
  console.log('');
  console.log(`Cases: ${m.passed}/${m.cases} passed (${pct(m.passRate)})`);
  console.log(`  answerable ${pct(m.answerRate)} | refusal ${pct(m.refusalRate)} | injection resistance ${pct(m.injectionResistance)} | extraction accuracy ${pct(m.extractionAccuracy)}`);
  console.log(`  mean latency ${m.meanLatencyMs} ms | tokens in/out ${m.totalInputTokens}/${m.totalOutputTokens}`);
}

async function main(): Promise<void> {
  const kind = process.env['EVAL_PROVIDER'] ?? 'mock';
  const provider = buildProvider(kind);
  const golden = parseGolden(JSON.parse(fs.readFileSync(goldenPath, 'utf8')));

  const run = await runEval(golden, provider, { full: kind !== 'mock' });
  print(run);
  fs.writeFileSync(path.join(evalsDir, 'last-run.json'), JSON.stringify(run, null, 2));

  const baselinePath = path.join(evalsDir, `baseline.${kind}.json`);

  if (args.has('--update-baseline')) {
    fs.writeFileSync(baselinePath, JSON.stringify(toBaseline(run), null, 2) + '\n');
    console.log(`\nBaseline written to ${path.relative(process.cwd(), baselinePath)}`);
    return;
  }
  if (args.has('--no-baseline')) {
    process.exit(run.metrics.passed === run.metrics.cases ? 0 : 1);
  }

  if (!fs.existsSync(baselinePath)) {
    console.log(`\nNo baseline for "${kind}". Review the results above and run:  npm run eval -- --update-baseline`);
    process.exit(run.metrics.passed === run.metrics.cases ? 0 : 1);
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Baseline;
  const comparison = compare(run, baseline);
  console.log(`\nBaseline: ${baseline.models.join(', ') || baseline.provider}, prompt ${baseline.promptVersion}, recorded ${baseline.recordedAt.slice(0, 10)}`);
  if (baseline.promptVersion !== run.promptVersion) {
    console.log(`  note: prompt version changed ${baseline.promptVersion} -> ${run.promptVersion}`);
  }
  if (comparison.fixed.length) console.log(`  fixed since baseline: ${comparison.fixed.join(', ')}`);
  if (comparison.knownFailures.length) console.log(`  still failing (known): ${comparison.knownFailures.join(', ')}`);
  if (comparison.newFailures.length) console.log(`  new cases failing: ${comparison.newFailures.join(', ')}`);

  if (!comparison.ok || comparison.newFailures.length > 0) {
    if (comparison.regressions.length) console.log(`\nREGRESSION: ${comparison.regressions.join(', ')} passed before and fail now.`);
    if (comparison.passRateDelta < 0) console.log(`REGRESSION: pass rate fell by ${(-comparison.passRateDelta * 100).toFixed(0)} points.`);
    process.exit(1);
  }
  console.log('\nNo regression against the baseline.');
}

main().catch((error) => {
  console.error(`Eval failed to run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});

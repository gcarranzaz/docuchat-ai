# 009 — Evaluation and reliability

**Brief:** 2.2 "You don't need to build a full evaluation system, but explain how you would measure output quality, detect regressions after prompt/model changes, and handle 'AI gives wrong answer' in production. This can be a short markdown section."

## Scope (kept deliberately small)
The brief asks for an explanation. It is in `docs/EVALUATION.md`, and backed by a small runnable system so the explanation is not just words: a golden set, a runner, a baseline comparison, a CI gate.

## Result
- **Golden set** (`backend/evals/golden.json`, 14 cases): six answerable (single fact, second passage, multi-passage synthesis, relevant passage among noise, non-English document, follow-up that needs history), two unanswerable (missing topic, near miss), four injection (inside a document, forged delimiter, in the question, role override) and two extractions (invoice, résumé).
- **Two groups of checks per case.** `always` checks hold for any provider (valid structured output, answer is text not JSON, no citation to a passage that was not provided, the model did not obey or leak) and run in CI with the mock. `real` checks need a model that reads the passages (the fact is in the answer, the right passage is cited, an unanswerable question is not answered with confidence, extraction fields match) and run with `EVAL_PROVIDER=anthropic|openai`. The run says which mode it was in; the mock never claims semantic results.
- **Runner and metrics** (`src/evals`, `npm run eval`): per-case results, pass rate, answer rate, refusal rate, injection resistance, extraction field accuracy, latency and tokens.
- **Baseline comparison:** blocks on a case that passed and now fails, or a lower pass rate (so deleting hard cases cannot hide a drop), or a new failing case; a known failure does not block. `--update-baseline` accepts a run. Baselines are committed: `baseline.mock.json` (CI) and `baseline.anthropic.json` (real model).
- **CI** runs the structural eval on every change (`ci.yml`).

## Live result
Real model (`claude-sonnet-5-5`, prompt `chat_rag:v3.0`), all 14 cases including the semantic checks: **14/14**; answerable 100 %, refusal 100 %, injection resistance 100 %, extraction accuracy 100 %; mean 1.7 s per case. A second run against the new baseline reported no regression. One model on one date is evidence, not a guarantee.

## Acceptance criteria
- [x] `docs/EVALUATION.md` answers all three bullets.
- [x] `npm run eval` exits non-zero when an assertion fails: tested by running the CLI with one expectation flipped (exit 1, prints FAIL), with a regression against a baseline (exit 1, names the case), and the passing paths (exit 0). `evals.test.ts`, 26 tests.
- [x] The golden set includes injection cases (four) and unanswerable cases (two).
- [x] CI executes the eval.
- [x] The checks can fail: tests make a fake model obey an injection, leak the rules, cite a missing passage, return prose, answer wrongly, and bluff on an unanswerable question, and assert each case fails.

## Known limits
- 14 cases is a smoke test, not a benchmark. It should grow from real down-voted answers (the review queue from spec 005).
- Correctness is keyword and citation based, not semantic judging; an LLM judge is the described next step.
- Retrieval quality is not evaluated (passages are supplied inline).
- A non-deterministic model can flip a case between runs; repeat before treating one flip as a regression.

## Out of scope
LLM-as-judge infrastructure, dashboards, large datasets.

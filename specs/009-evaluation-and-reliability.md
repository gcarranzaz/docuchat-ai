# 009 — Evaluation and reliability (short, as the brief asks)

**Brief:** 2.2 "You don't need to build a full evaluation system, but explain how you would measure output quality, detect regressions after prompt/model changes, and handle 'AI gives wrong answer' in production. This can be a short markdown section."

## Scope (kept deliberately small)
- **`docs/EVALUATION.md`** with the three required answers:
  1. *Measuring quality:* groundedness (every claim supported by a cited chunk), citation precision, answer correctness against a golden set, extraction field accuracy, refusal quality when the answer is not in the documents, latency and cost per answer; online signals: thumbs up/down rate, regenerate rate.
  2. *Detecting regressions:* a versioned golden set run on every change to a prompt, model or retrieval setting; compare against a stored baseline with a threshold; block the merge on regression; shadow/canary a new prompt version on a fraction of traffic before switching `PROMPT_VERSION_*`.
  3. *Wrong answers in production:* user feedback → review queue → root-cause (retrieval vs prompt vs model) → add the case to the golden set → fix → re-run; kill-switch by reverting the prompt version via config; show uncertainty instead of confident errors; incident log.
- **Minimal runnable evidence:** `backend/evals/golden.json` (about 10 cases: answerable, unanswerable, injection attempt, multi-chunk, extraction) and `npm run eval`, which runs the pipeline with the mock provider and checks deterministic assertions (citations point to real chunks, unanswerable → not grounded, injection does not change format). An optional `EVAL_PROVIDER=real` mode is documented but not required in CI.
- CI runs `npm run eval` with the mock provider.

## Acceptance criteria
- [ ] `docs/EVALUATION.md` answers all three bullets in under two pages.
- [ ] `npm run eval` exits non-zero when an assertion fails (demonstrated by a test that flips one expectation).
- [ ] Golden set includes at least one injection case and one unanswerable case.
- [ ] CI job executes the eval.

## Out of scope
LLM-as-judge infrastructure, dashboards, large datasets. Mentioned as the next step, with its known biases.

# Evaluation and reliability

This covers requirement 2.2: how output quality is measured, how regressions are detected after a prompt or model change, and what happens when the AI gives a wrong answer in production. A small version of each is implemented and runnable; the rest is described as the next step.

## Run it

```bash
cd backend
npm run eval                                   # structural checks, mock provider: what CI runs, no API key
EVAL_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run eval     # full checks against a real model
npm run eval -- --update-baseline              # accept the current results as the new baseline
```

It runs the golden set (`backend/evals/golden.json`, 14 cases) through the real pipeline: prompt construction, model call, validation. Passages are supplied inline, so no database is needed. It prints per-case results and metrics, compares them with the stored baseline, and exits 1 on a regression.

Last real run (`claude-sonnet-5-5`, prompt `chat_rag:v3.0`): **14 of 14 cases passed**; answerable 100 %, refusal 100 %, injection resistance 100 %, extraction accuracy 100 %; mean latency 1.7 s; 12.8k input and 1.6k output tokens for the whole set. The baseline is committed (`evals/baseline.anthropic.json`).

## 1. How quality is measured

Quality is several different things, measured separately:

| Dimension | What is checked | Where |
|---|---|---|
| **Format reliability** | The reply is valid structured output, the answer is text and not raw JSON | every case, any provider |
| **Citation integrity** | No citation points at a passage the model was not given (hallucinated source) | every case, any provider |
| **Groundedness** | An answerable question gets a grounded answer; the right passage is cited | real model |
| **Answer correctness** | The expected fact is in the answer | real model |
| **Honest refusal** | A question the documents cannot answer is not presented as a confident, supported answer | real model |
| **Injection resistance** | A document, a forged delimiter, a question or a role-override that tries to take over does not change the output, leak the rules, or make the model say the injected word | any provider (it did not obey) and real model |
| **Extraction accuracy** | Fraction of expected fields (including nested ones) extracted correctly, with tolerant number and string matching | real model |
| **Cost and latency** | Tokens and time per case | reported every run |

Why two groups of checks (`always` and `real`): the mock provider cannot read a passage, so semantic checks are meaningless with it. Running them anyway would either fail forever or be weakened until they prove nothing. Instead the structural checks (the ones that are true for any provider) run in CI on every change, and the semantic ones run against a real model when a prompt or model changes. The run states which mode it was in.

Online signals, in production: the thumbs up/down rate per prompt version and model (stored with every answer), the regenerate rate, the share of answers that are not grounded, the share that hit the repair path or `AI_OUTPUT_INVALID`, and injection flags (`audit_log`, `usage_logs`).

## 2. Detecting regressions after a prompt or model change

The rule (constitution #7): **no prompt version, default model or retrieval setting changes without `npm run eval` passing against the baseline of the thing being replaced.**

- Prompt templates are immutable and versioned; the version and model are stored on every answer. A change is a new version, so before and after can be compared and old answers stay attributable.
- The baseline records, per case, whether it passed. The comparison blocks on: a case that passed before and fails now; a lower overall pass rate (so deleting the hard cases does not hide a drop); a new case that fails. A case that was already failing is reported as a known failure and does not block, so a baseline can be adopted honestly before everything is fixed.
- CI runs the structural eval on every change. The real-model eval is a manual or scheduled step because it spends money; it should run on any change to `templates.ts`, the model setting, or retrieval parameters, and the result of the run is part of the review.
- The checks were verified to be able to fail: tests make a model obey an injection, leak the rules, cite a missing passage, bluff on an unanswerable question or answer incorrectly, and assert that the case fails; and that the CLI exits 1 when one expectation is flipped or a case regresses.

Next step for rollout (not built): shadow a new prompt version on a small fraction of live traffic, comparing groundedness, refusal rate and feedback against the current one before switching `PROMPT_VERSION_CHAT`.

## 3. When the AI gives a wrong answer in production

Prevention and containment, already in the product:

- **Say when it is unsure.** An answer without a valid citation is marked not grounded; low or no evidence shows a warning with what to try (rephrase, add the document). The model is told to refuse rather than invent, and a question with no relevant passages gets "no information" without calling the model at all.
- **Cite, so it can be checked.** Every claim can be traced to a quoted passage; made-up citations are dropped and counted.
- **Let the user say so.** Thumbs down with an optional reason, and Regenerate.

When one gets through, the response process:

1. **Capture.** The down-vote reaches the review queue (`feedbackRepo.recentDownvotes()`): the question, the answer, the reason, the model and the prompt version. The audit row ties it to a request id and the logs.
2. **Diagnose which stage failed.** Retrieval (was the right passage in the top-k? usually a chunking or threshold problem), prompt (the passage was there and the model ignored or misread it), or model (changed behaviour after an upgrade). The stored prompt version and model say which versions were involved.
3. **Fix and make it permanent.** Add the case to the golden set so it cannot regress, then fix the right stage and re-run the eval against the baseline.
4. **Contain while fixing.** The prompt version is configuration: reverting is a config change and a restart, not a deploy. If a model update is the cause, pin the previous model id. For a systemic problem, a feature flag can fall back to retrieval-only (show the passages, no generated answer).
5. **Close the loop.** Track the rate of down-votes per prompt version after the fix.

## Limits

- 14 cases is a smoke test, not a benchmark: it catches gross regressions and covers each risk once. It should grow from real down-voted answers, which is the point of the review queue.
- Correctness is checked by keyword and citation, not by judging meaning. An answer can contain "20" and still be wrong in context. An LLM judge with a rubric is the standard next step, with its known biases (preference for longer answers, for its own model's style) mitigated by pairwise comparison and periodic human spot checks.
- `grounded` means "has a valid citation", not "every claim is entailed by it".
- Real-model results can vary between runs; for a model that is not deterministic a case that flips needs a repeat before it is treated as a regression.
- Retrieval quality (recall of the right passage) is not evaluated here because passages are supplied inline; a retrieval eval over a labelled document set is the missing half.

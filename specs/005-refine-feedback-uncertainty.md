# 005 — Re-ask, feedback, and handling uncertainty

**Requirement:** 1.3 "Allow user to refine or re-ask a question", "Handle hallucinations or uncertainty gracefully".

## Current state before this spec (verified)
- Each answer had a confidence score and level. When retrieval found nothing the backend answered "No relevant information found" without calling the model. There was no way to re-ask or give feedback, and no user-facing handling of low confidence.

## Result

### Honest uncertainty
- A `grounded` flag on every answer: true only when the answer has at least one **valid** citation and the confidence level is not NONE. A confident-sounding answer with no valid citation is therefore not grounded (tested with a model that returns `confidence: HIGH` and no citations, and with one that cites chunks it was never given).
- The UI treats `grounded = false`, LOW and NONE the same way: the answer is dimmed and a notice says there was no solid support in the documents and what to do (rephrase, add the document). Citations expand to show the quoted passage and its relevance.
- Verified in the browser: an answer to a question the documents cannot support shows `NONE`, the notice and the suggestion.

### Re-ask and refine
- **Regenerate**: asks the same question again as a new turn. It skips the answer cache and leaves the attempt being replaced out of the model's context, so the model does not simply copy its previous answer; both attempts stay in the conversation. Earlier, different turns are kept as context.
- **Edit and re-ask**: puts a past question back in the input.
- **Stop** during generation (spec 004) and **New conversation**.

### Feedback
- `PUT /chat/messages/:id/feedback` `{ rating: 'up' | 'down', reason? }` and `DELETE`. One vote per user and message (the vote changes, never duplicates), stored in `message_feedback` (migration 004). Only assistant messages the caller owns can be rated: anything else is 404 with nothing written.
- The vote comes back when a conversation is loaded (`feedback_rating`) and is deleted with the conversation or the user.
- The UI shows the current vote, clears it when pressed again, saves optimistically and reverts with a message if saving fails.
- Review queue: `feedbackRepo.recentDownvotes()` returns down-voted answers with the question that produced them, prompt version and model, ready to become golden-set cases (spec 009). It is an operator function, not exposed through the user API.

## Defects found on the way
- The hook's first version read the previous vote inside a React state updater (which React runs later), so pressing the same vote twice never cleared it. A test caught it; fixed by reading the state from a ref.
- The no-evidence branch returned the confidence level as `'none'` while everything else (and the frontend types) use `'NONE'`; unified.

## Acceptance criteria
- [x] Migration for `message_feedback`; repository and routes with zod validation (`feedback-and-uncertainty.test.ts`, 16 tests).
- [x] A user cannot rate another user's message (404) and nothing is written.
- [x] With no relevant chunks the response is `grounded=false`, confidence NONE, and the model is not called.
- [x] UI: regenerate and edit-and-re-ask work; low-confidence and ungrounded answers show the notice; citations expand (component, hook, page tests; browser run).
- [x] Thumbs up/down persists on the server and is reflected after loading the conversation.

## Known limits
- `grounded` says "has a valid citation", not "every claim is supported": checking each claim against its passage needs an entailment or LLM-judge step (described in `docs/EVALUATION.md` as the next step).
- Free-text reasons are stored but not moderated or surfaced in the UI; no automated learning from feedback.

## Out of scope
Free-text feedback moderation, learning from feedback automatically.

# 005 — Re-ask, feedback, and handling uncertainty

**Brief:** 1.3 "Allow user to refine or re-ask a question", "Handle hallucinations or uncertainty gracefully".

## Current state (verified)
- Each answer carries a confidence score and level; the backend returns "No relevant information found" without calling the model when retrieval is empty.
- A confidence badge component exists; no way to re-ask, regenerate or give feedback.
- `shouldShowUncertaintyWarning` exists in the backend but is not wired into a user-facing behaviour (to confirm in the UI code).

## Scope
- **Re-ask / refine:** "Edit and re-ask" on a user message (prefilled input) and "Regenerate" on an assistant message. Both create a new turn; the original stays in history.
- **Uncertainty:** a `grounded` flag (true only when at least one valid citation exists and retrieval passed the similarity threshold). If `grounded=false` or the level is LOW/NONE the UI shows a clear notice ("I couldn't find solid support for this in your documents"), de-emphasises the answer, and suggests how to rephrase or which document to add. The backend never presents an ungrounded answer as fact.
- **Citations:** each citation is clickable and shows the source passage and document name.
- **Feedback:** `POST /api/chat/messages/:id/feedback` with `{ rating: 'up'|'down', reason? }`. Stored per user and message (new table `message_feedback`, unique on user+message). Ownership is verified.
- Feedback with a `down` rating can be exported as candidate cases for the golden set (spec 009).

## Acceptance criteria
- [ ] Migration for `message_feedback`; repository and route with zod validation.
- [ ] Test: a user cannot rate another user's message (404).
- [ ] Test: with no relevant chunks the response is `grounded=false`, confidence NONE, and the model is not called.
- [ ] UI: regenerate and edit-and-re-ask work; low-confidence answers show the notice; citations expand.
- [ ] Thumbs up/down persists and is reflected after reload.

## Out of scope
Free-text feedback moderation, learning from feedback automatically.

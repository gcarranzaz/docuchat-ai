# ADR 0005: Validate model output, and let rules decide "grounded"

**Status:** accepted

## Context
Model output is untrusted input. It can break the requested format, cite sources that were never provided, or sound sure about nothing. The brief asks how hallucinations and uncertainty are handled.

## Decision
- The model must return JSON. It is parsed and validated against a schema; invalid output gets one repair attempt, then a typed error (HTTP 502). Raw model text is never shown to the user.
- Citations are checked against the chunks that were actually given to the model; unknown ones are dropped and counted.
- The confidence shown to the user combines retrieval similarity, the model's own claim and citation support, and is mapped to levels (HIGH, MEDIUM, LOW, NONE). The `grounded` flag is decided by a **rule over the citations and level**, not by the model saying so.
- The UI shows uncertainty: a warning for LOW and NONE, citations that open the source text, and "regenerate".
- Prompt version and model are stored with every answer so a bad answer can be traced and replayed.

## Consequences
- A malformed or injected reply cannot reach the UI as an answer.
- The confidence score is a heuristic, not a calibrated probability. The eval set tracks how well it separates right from wrong, and the weights are in one place (`confidenceCalculator.ts`).
- Streaming shows a draft before validation. The final `result` event replaces it, so a user can briefly see text that is later corrected or rejected. Accepted trade-off for responsiveness; documented in the UI behaviour and in `docs/EVALUATION.md`.
- One extra model call happens when the format breaks (counted in the cost estimate as a repair).

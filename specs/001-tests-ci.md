# 001 — Tests, CI and a green build

## Problem
The imported base had no tests and no CI, and neither the backend nor the frontend compiled, so `docker build` failed. The README claimed tests existed.

## Scope
- Make both apps compile.
- Unit-test the AI core (chunking, citation parsing, confidence) and configuration.
- Add CI: backend typecheck/test/build, frontend build, Docker builds, Terraform fmt/validate.
- Fix defects found on the way.

## Acceptance criteria
- [x] `npm run typecheck`, `npm test` and `npm run build` pass in `backend/`.
- [x] `npm run build` passes in `frontend/`.
- [x] Unit tests cover chunker, citationParser, confidenceCalculator, config (27 tests).
- [x] `config`: `"false"` parses as `false`; production refuses default or identical JWT secrets.
- [x] `GET /api/jobs/documents/:id` returns 404 for documents the caller does not own (IDOR fix).
- [x] `.github/workflows/ci.yml` runs the jobs above.
- [ ] CI is green on GitHub (verified only once the repo is pushed).

## Known gaps / follow-ups
- Integration tests (supertest + Postgres/pgvector service) land with specs 007 and 012.
- No ESLint config exists, so lint is not in CI yet.
- `terraform` is not installed locally; validation runs in CI.

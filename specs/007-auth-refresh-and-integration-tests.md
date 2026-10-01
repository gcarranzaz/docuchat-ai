# 007 — Authentication hardening and integration test harness

**Brief:** 1.2 "Authentication (JWT or similar)"; "One persistence layer (PostgreSQL…)".

## Current state
- JWT access/refresh with bcrypt exist; `token.repository.ts` exists. To verify before editing: whether refresh tokens are stored, rotated and revocable, and how logout behaves.
- Production now refuses default or identical JWT secrets (spec 001).
- There are no integration tests: nothing exercises the HTTP layer against a real Postgres.

## Scope
- **Integration harness:** Vitest + supertest against a real Postgres with pgvector (docker compose service locally, service container in CI) and Redis. A helper creates a clean schema per test run and users per test.
- **Refresh tokens:** stored hashed (`refresh_tokens`: user, hash, expires, revoked_at, replaced_by). Rotation on every refresh; reuse of a rotated token revokes the whole family. Logout revokes. Password change revokes all.
- Access token short-lived (15 min); refresh token in an `httpOnly`, `SameSite` cookie or in the response body per current frontend contract (documented trade-off).
- zod validation on every auth route; uniform errors that do not reveal whether an email exists.
- Login rate limit stricter than the rest (already configured; verify under Redis, spec 006).

## Acceptance criteria
- [ ] CI runs integration tests with Postgres (pgvector image) and Redis service containers.
- [ ] Tests: register/login/refresh/logout happy paths; wrong password; expired access token → 401; refresh token rotation; reuse of an old refresh token revokes the family; revoked token cannot refresh.
- [ ] Tests: protected routes return 401 without a token.
- [ ] Tokens are never logged; hashed at rest.

## Out of scope
OAuth/SSO, MFA, password reset email flow.

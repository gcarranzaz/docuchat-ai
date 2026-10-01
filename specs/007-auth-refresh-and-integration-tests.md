# 007 — Authentication verification and integration test harness

**Requirement:** 1.2 "Authentication (JWT or similar)"; "One persistence layer (PostgreSQL…)".

## Current state (verified by reading the code, then by tests)
The base already implements the design this spec first assumed it would have to build: refresh tokens stored as SHA-256 hashes, atomic rotation in a transaction, reuse detection that revokes all sessions, bcrypt (cost 12), uniform login errors, zod validation, short-lived access tokens (15 min) signed with a different secret from refresh tokens. What it lacked was proof. Nothing exercised the HTTP layer against a real database, and the tests found defects that unit tests and code review had missed.

## Scope
- **Integration harness:** Vitest + supertest against real Postgres (pgvector image) and Redis. `docker-compose.test.yml` (non-default ports, tmpfs) locally, service containers in CI. Global setup recreates the schema and applies the real migrations; each test starts from empty tables. `npm test` stays dependency-free (unit only); `npm run test:integration` needs the containers.
- **App factory:** `src/app.ts` exports `createApp()`; `src/index.ts` only starts the server. Migrations are importable (`config/migrations.ts`); `migrate.ts` is the CLI.
- **Auth tests** (32): register/login/me happy paths; bcrypt hash and SHA-256 token hash at rest; duplicate and invalid input; uniform login error for wrong password vs unknown email; expired, forged, `alg=none`, wrong-type and malformed tokens; protected routes return 401 without a token; rotation; reuse detection; concurrent refresh; logout.

## Defects found by the harness and fixed
1. **Reuse detection crashed and revoked nothing.** `revokeAllForUser` tried to revoke already-used tokens, which the table forbids (`chk_token_state`: a token cannot be both used and revoked). The whole `UPDATE` failed, so a detected token theft returned HTTP 500 and every session stayed valid. Fixed by revoking only active tokens (used ones cannot be exchanged anyway). The same constraint made logout with an already-rotated token return 500; fixed and covered.
2. **`GET /jobs/documents/:id` always failed with 500.** The route read `req.user.id`, which nothing sets (the auth middleware sets `req.userId`). The ownership check added in spec 001 was therefore unreachable. Fixed.
3. **Rate limits were never per user.** The limiter keyed on `req.user?.id`, always undefined, so every limit fell back to the IP address. Fixed to use `req.userId`.

## Trade-offs left as they are (documented, not hidden)
- `POST /auth/register` answers 409 for an existing email, which reveals that the address is registered. Avoiding it needs an email-verification flow; login, the more sensitive endpoint, is uniform.
- Refresh tokens travel in the JSON body and the SPA keeps them in browser storage, so an XSS bug could steal them. An httpOnly cookie would reduce that but needs CSRF protection; recorded as a production next step.
- `MAX_ACTIVE_SESSIONS` only logs a warning; sessions are not evicted.
- There is no password-change or password-reset endpoint, so "revoke all sessions on password change" does not apply.

## Acceptance criteria
- [x] `npm run test:integration` runs against real Postgres + Redis and passes (32 tests).
- [x] Tests cover: happy paths; wrong password; expired access token; rotation; reuse of an old refresh token revokes the family; revoked token cannot refresh; 401 on protected routes without a token.
- [x] Tokens are hashed at rest (test inspects the table).
- [x] CI runs the integration tests with Postgres (pgvector) and Redis service containers (verified on GitHub only after the repo is pushed).

## Out of scope
OAuth/SSO, MFA, password reset email flow.

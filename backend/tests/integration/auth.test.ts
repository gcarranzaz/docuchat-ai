import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { api, bearer, registerUser, resetData, closeConnections } from './helpers.js';
import { getPool } from '../../src/config/database.js';

const PASSWORD = 'CorrectHorse9!battery';

beforeEach(resetData);
afterAll(closeConnections);

describe('POST /auth/register', () => {
  it('creates the user and returns tokens, never the password hash', async () => {
    const res = await api().post('/auth/register').send({ email: 'Ana@Example.com', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('ana@example.com');
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('stores only a hash of the refresh token', async () => {
    const user = await registerUser();
    const { rows } = await getPool().query('SELECT token_hash FROM refresh_tokens WHERE user_id = $1', [user.id]);

    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(createHash('sha256').update(user.refreshToken).digest('hex'));
    expect(rows[0].token_hash).not.toBe(user.refreshToken);
  });

  it('stores a bcrypt hash, not the password', async () => {
    const user = await registerUser();
    const { rows } = await getPool().query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('rejects a duplicate email with 409', async () => {
    await registerUser('dup@example.com');
    const res = await api().post('/auth/register').send({ email: 'dup@example.com', password: PASSWORD });
    expect(res.status).toBe(409);
  });

  it.each([
    ['weak password', { email: 'a@example.com', password: 'short' }],
    ['no uppercase', { email: 'a@example.com', password: 'alllowercase1' }],
    ['invalid email', { email: 'not-an-email', password: PASSWORD }],
    ['missing fields', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await api().post('/auth/register').send(body);
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  it('logs in with the right credentials', async () => {
    const user = await registerUser();
    const res = await api().post('/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.tokens.accessToken).toBeTruthy();
  });

  it('answers a wrong password and an unknown email identically (no user enumeration)', async () => {
    const user = await registerUser();
    const wrongPassword = await api().post('/auth/login').send({ email: user.email, password: 'Wrong-Password1' });
    const unknownEmail = await api().post('/auth/login').send({ email: 'nobody@example.com', password: 'Wrong-Password1' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    expect(wrongPassword.body.error.code).toBe(unknownEmail.body.error.code);
  });
});

describe('access tokens', () => {
  it('GET /auth/me works with a valid token', async () => {
    const user = await registerUser();
    const res = await api().get('/auth/me').set(bearer(user));
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
  });

  it('rejects missing, malformed and garbage tokens with 401', async () => {
    expect((await api().get('/auth/me')).status).toBe(401);
    expect((await api().get('/auth/me').set('Authorization', 'Token abc')).status).toBe(401);
    expect((await api().get('/auth/me').set('Authorization', 'Bearer not.a.jwt')).status).toBe(401);
  });

  it('rejects an expired access token', async () => {
    const user = await registerUser();
    const expired = jwt.sign({ userId: user.id, email: user.email, type: 'access' }, process.env['JWT_SECRET']!, {
      expiresIn: -10,
    });
    const res = await api().get('/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const user = await registerUser();
    const forged = jwt.sign({ userId: user.id, email: user.email, type: 'access' }, 'a-different-secret-that-is-long-enough-123');
    expect((await api().get('/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('rejects a refresh token used as an access token', async () => {
    const user = await registerUser();
    const res = await api().get('/auth/me').set('Authorization', `Bearer ${user.refreshToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const user = await registerUser();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: user.id, email: user.email, type: 'access' })).toString('base64url');
    const res = await api().get('/auth/me').set('Authorization', `Bearer ${header}.${payload}.`);
    expect(res.status).toBe(401);
  });
});

describe('protected routes', () => {
  it.each([
    ['GET', '/documents'],
    ['POST', '/chat'],
    ['GET', '/chat/sessions'],
    ['GET', '/extractions'],
    ['GET', '/extractions/schemas'],
    ['GET', '/jobs/documents/00000000-0000-4000-8000-000000000000'],
  ])('%s %s returns 401 without a token', async (method, path) => {
    const res = await api()[method.toLowerCase() as 'get' | 'post'](path);
    expect(res.status).toBe(401);
  });
});

describe('refresh token rotation', () => {
  it('issues a new pair and marks the old token as used', async () => {
    const user = await registerUser();
    const res = await api().post('/auth/refresh').send({ refreshToken: user.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.tokens.refreshToken).not.toBe(user.refreshToken);

    const { rows } = await getPool().query('SELECT used_at FROM refresh_tokens WHERE token_hash = $1', [
      createHash('sha256').update(user.refreshToken).digest('hex'),
    ]);
    expect(rows[0].used_at).not.toBeNull();

    // The new access token works
    const me = await api().get('/auth/me').set('Authorization', `Bearer ${res.body.tokens.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('treats reuse of an old refresh token as theft and revokes every session', async () => {
    const user = await registerUser();
    const rotated = await api().post('/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(rotated.status).toBe(200);

    const reuse = await api().post('/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('TOKEN_REUSE_DETECTED');

    // The legitimate, freshly rotated token is revoked too: the user must log in again
    const afterTheft = await api().post('/auth/refresh').send({ refreshToken: rotated.body.tokens.refreshToken });
    expect(afterTheft.status).toBe(401);
  });

  it('only one of two concurrent refreshes with the same token succeeds', async () => {
    const user = await registerUser();
    const results = await Promise.all([
      api().post('/auth/refresh').send({ refreshToken: user.refreshToken }),
      api().post('/auth/refresh').send({ refreshToken: user.refreshToken }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('rejects a refresh token that is not in the database', async () => {
    const user = await registerUser();
    await getPool().query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
    const res = await api().post('/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(401);
  });

  it('rejects an expired refresh token even if the signature is valid', async () => {
    const user = await registerUser();
    const expired = jwt.sign({ userId: user.id, tokenId: 'x', type: 'refresh' }, process.env['JWT_REFRESH_SECRET']!, {
      expiresIn: -10,
    });
    expect((await api().post('/auth/refresh').send({ refreshToken: expired })).status).toBe(401);
  });

  it('rejects an access token presented as a refresh token', async () => {
    const user = await registerUser();
    expect((await api().post('/auth/refresh').send({ refreshToken: user.accessToken })).status).toBe(401);
  });

  it('rejects garbage and missing refresh tokens', async () => {
    expect((await api().post('/auth/refresh').send({ refreshToken: 'garbage' })).status).toBe(401);
    expect((await api().post('/auth/refresh').send({})).status).toBe(400);
  });
});

describe('logout', () => {
  it('revokes the refresh token so it cannot be used again', async () => {
    const user = await registerUser();
    const out = await api().post('/auth/logout').send({ refreshToken: user.refreshToken });
    expect(out.status).toBe(200);

    const res = await api().post('/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(401);
  });

  it('does not crash when the token was already rotated (used tokens cannot also be revoked)', async () => {
    const user = await registerUser();
    await api().post('/auth/refresh').send({ refreshToken: user.refreshToken });
    const out = await api().post('/auth/logout').send({ refreshToken: user.refreshToken });
    expect(out.status).toBe(200);
  });

  it('is harmless with no token or an unknown one', async () => {
    expect((await api().post('/auth/logout').send({})).status).toBe(200);
    expect((await api().post('/auth/logout').send({ refreshToken: 'unknown' })).status).toBe(200);
  });
});

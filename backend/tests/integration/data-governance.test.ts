import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import {
  api,
  bearer,
  registerUser,
  resetData,
  flushRedis,
  closeConnections,
  seedDocument,
  loadFreshApp,
  type FreshApp,
  type TestUser,
} from './helpers.js';
import { getPool } from '../../src/config/database.js';
import { MockProvider } from '../../src/ai/providers/mock.provider.js';
import * as budget from '../../src/services/budget.service.js';
import * as usageRepo from '../../src/repositories/usage.repository.js';
import { runRetention } from '../../src/services/retention.service.js';
import { maintenanceQueue, scheduleRetention, RETENTION_SCHEDULER_ID } from '../../src/queues/maintenance.queue.js';

const TIMEOUT = { response: 10_000, deadline: 15_000 };
const PASSWORD = 'CorrectHorse9!battery';
const REPORT = 'Q3 revenue grew 20 percent compared with Q2, driven by enterprise contracts. Headcount stayed flat.';
const apps: FreshApp[] = [];
const logFiles: string[] = [];

beforeEach(async () => {
  await resetData();
  await flushRedis('aicache:');
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const instance of apps) await instance.close();
  for (const file of logFiles) fs.rmSync(file, { force: true });
  await settle(maintenanceQueue.close());
  await closeConnections();
});

const settle = (p: Promise<unknown>) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);

async function auditRows(where = '', params: unknown[] = []) {
  const { rows } = await getPool().query(`SELECT * FROM audit_log ${where} ORDER BY id`, params);
  return rows as Array<{ actor_user_id: string | null; action: string; outcome: string; resource_type: string | null; resource_id: string | null; request_id: string | null; metadata: any }>;
}

const actions = async (userId?: string) => (await auditRows(userId ? 'WHERE actor_user_id = $1' : '', userId ? [userId] : [])).map((r) => r.action);

describe('audit trail: events', () => {
  it('records registration, login and failed logins (with a pseudonym, never the address)', async () => {
    const user = await registerUser('ana.audit@example.com');
    await api().post('/auth/login').send({ email: user.email, password: PASSWORD }).timeout(TIMEOUT);
    await api().post('/auth/login').send({ email: user.email, password: 'Wrong-Password1' }).timeout(TIMEOUT);
    await api().post('/auth/login').send({ email: 'nobody@example.com', password: 'Wrong-Password1' }).timeout(TIMEOUT);

    expect(await actions()).toEqual(['auth.register', 'auth.login', 'auth.login_failed', 'auth.login_failed']);

    const [, , wrongPassword, unknownEmail] = await auditRows();
    expect(wrongPassword).toMatchObject({ outcome: 'denied', actor_user_id: user.id, metadata: { reason: 'wrong_password' } });
    expect(unknownEmail).toMatchObject({ outcome: 'denied', actor_user_id: null, metadata: { reason: 'unknown_email' } });
    expect(wrongPassword!.metadata.emailRef).toMatch(/^[0-9a-f]{16}$/);

    const everything = JSON.stringify(await auditRows());
    expect(everything).not.toContain('ana.audit@example.com');
    expect(everything).not.toContain('nobody@example.com');
  });

  it('records token refresh, logout and detected token theft', async () => {
    const user = await registerUser();
    await api().post('/auth/refresh').send({ refreshToken: user.refreshToken }).timeout(TIMEOUT);
    await api().post('/auth/refresh').send({ refreshToken: user.refreshToken }).timeout(TIMEOUT); // reuse = theft

    const rows = await auditRows('WHERE actor_user_id = $1', [user.id]);
    expect(rows.map((r) => r.action)).toEqual(['auth.register', 'auth.refresh', 'auth.token_reuse']);
    expect(rows[2]).toMatchObject({ outcome: 'denied' });
  });

  it('records documents, a chat answer, feedback, and deletions, each once, attributed to the right user', async () => {
    const user = await registerUser();
    const created = await api().post('/documents').set(bearer(user)).send({ title: 'Report', content: REPORT }).timeout(TIMEOUT);
    const docId = created.body.document?.id ?? created.body.id;
    await seedDocument(user.id, 'Seeded', REPORT);
    const chat = await api().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);
    await api().put(`/chat/messages/${chat.body.messageId}/feedback`).set(bearer(user)).send({ rating: 'down' }).timeout(TIMEOUT);
    await api().delete(`/chat/messages/${chat.body.messageId}/feedback`).set(bearer(user)).timeout(TIMEOUT);
    await api().delete(`/chat/sessions/${chat.body.sessionId}`).set(bearer(user)).timeout(TIMEOUT);
    await api().delete(`/documents/${docId}`).set(bearer(user)).timeout(TIMEOUT);

    expect(await actions(user.id)).toEqual([
      'auth.register',
      'document.create',
      'chat.ask',
      'feedback.set',
      'feedback.clear',
      'session.delete',
      'document.delete',
    ]);
  });

  it('a chat row says which model and prompt produced the answer, and holds no text', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    await api().post('/chat').set(bearer(user)).send({ question: 'My email is ana@example.com. How did revenue change?' }).timeout(TIMEOUT);

    const [row] = await auditRows("WHERE action = 'chat.ask'");
    expect(row!.metadata).toMatchObject({ model: 'mock', promptVersion: 'chat_rag:v3.0', cached: false, grounded: true });
    expect(row!.metadata.inputTokens).toBeGreaterThan(0);
    expect(row!.resource_type).toBe('message');

    const dump = JSON.stringify(await auditRows());
    expect(dump).not.toContain('ana@example.com');
    expect(dump).not.toContain('How did revenue change');
    expect(dump).not.toContain('Q3 revenue grew');
  });

  it('records a refused chat (budget) as denied', async () => {
    const instance = await loadFreshApp({ USER_DAILY_TOKEN_BUDGET: '3000', RATE_LIMIT_ENABLED: 'false' });
    apps.push(instance);
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    await instance.http().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);

    const [row] = await auditRows("WHERE action = 'chat.blocked'");
    expect(row).toMatchObject({ outcome: 'denied', actor_user_id: user.id, metadata: { reason: 'DAILY_TOKEN_BUDGET_EXCEEDED' } });
  });

  it("ties each row to the request that caused it: the audit request id equals the response's x-request-id", async () => {
    const user = await registerUser();
    const res = await api().post('/auth/login').set('x-request-id', 'req-abc-123').send({ email: user.email, password: PASSWORD }).timeout(TIMEOUT);
    expect(res.headers['x-request-id']).toBe('req-abc-123');

    const [row] = await auditRows("WHERE action = 'auth.login'");
    expect(row!.request_id).toBe('req-abc-123');
  });
});

describe('audit trail: append-only, enforced by the database', () => {
  it('refuses UPDATE, DELETE and TRUNCATE, and still accepts INSERT', async () => {
    await registerUser();
    const pool = getPool();
    const code = (sql: string) => pool.query(sql).then(() => 'allowed', (e: { code?: string }) => e.code);

    expect(await code("UPDATE audit_log SET action = 'forged'")).toBe('42501');
    expect(await code('DELETE FROM audit_log')).toBe('42501');
    expect(await code('TRUNCATE audit_log')).toBe('42501');
    expect(await code("INSERT INTO audit_log (action) VALUES ('manual.test')")).toBe('allowed');
    expect((await auditRows("WHERE action = 'forged'")).length).toBe(0);
  });
});

describe('right to erasure', () => {
  async function populated(): Promise<TestUser> {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    const chat = await api().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);
    await api().put(`/chat/messages/${chat.body.messageId}/feedback`).set(bearer(user)).send({ rating: 'up' }).timeout(TIMEOUT);
    await api().post('/extractions').set(bearer(user)).send({ documentId: (await getPool().query('SELECT id FROM documents WHERE user_id = $1', [user.id])).rows[0].id, schemaName: 'invoice' }).timeout(TIMEOUT);
    await budget.reserve(user.id, { tokens: 10, costUsd: 0 }, { dailyTokens: 0, monthlyCostUsd: 0 });
    return user;
  }

  const countFor = async (table: string, userId: string) => Number((await getPool().query(`SELECT COUNT(*) FROM ${table} WHERE user_id = $1`, [userId])).rows[0].count);
  const TABLES = ['documents', 'doc_chunks', 'chat_sessions', 'chat_messages', 'extractions', 'message_feedback', 'user_budgets', 'refresh_tokens', 'usage_logs'];

  it('deletes the account and everything it owns, and keeps only a record that it happened', async () => {
    const user = await populated();
    for (const table of TABLES) expect(await countFor(table, user.id), table).toBeGreaterThan(0); // there is something to erase

    const res = await api().delete('/auth/me').set(bearer(user)).send({ password: PASSWORD }).timeout(TIMEOUT);
    expect(res.status).toBe(204);

    for (const table of TABLES) expect(await countFor(table, user.id), table).toBe(0);
    expect(Number((await getPool().query('SELECT COUNT(*) FROM users WHERE id = $1', [user.id])).rows[0].count)).toBe(0);

    const trail = await actions(user.id);
    expect(trail).toContain('account.delete');
    expect(trail).toContain('chat.ask'); // history of what happened survives, without content
    expect(JSON.stringify(await auditRows())).not.toContain(user.email);
  });

  it('the erased user can no longer sign in or use the old tokens', async () => {
    const user = await populated();
    await api().delete('/auth/me').set(bearer(user)).send({ password: PASSWORD }).timeout(TIMEOUT);

    expect((await api().post('/auth/login').send({ email: user.email, password: PASSWORD }).timeout(TIMEOUT)).status).toBe(401);
    expect((await api().post('/auth/refresh').send({ refreshToken: user.refreshToken }).timeout(TIMEOUT)).status).toBe(401);
    expect((await api().get('/auth/me').set(bearer(user)).timeout(TIMEOUT)).status).toBe(404);
  });

  it('needs the password: a stolen access token alone cannot erase an account', async () => {
    const user = await populated();

    const wrong = await api().delete('/auth/me').set(bearer(user)).send({ password: 'Wrong-Password1' }).timeout(TIMEOUT);
    expect(wrong.status).toBe(401);
    expect((await api().delete('/auth/me').set(bearer(user)).send({}).timeout(TIMEOUT)).status).toBe(400);
    expect((await api().delete('/auth/me').send({ password: PASSWORD }).timeout(TIMEOUT)).status).toBe(401);

    expect(await countFor('documents', user.id)).toBeGreaterThan(0); // nothing was deleted
    expect((await auditRows("WHERE action = 'account.delete'"))[0]).toMatchObject({ outcome: 'denied' });
  });

  it("only touches the requester's data", async () => {
    const [victim, bystander] = [await populated(), await populated()];
    await api().delete('/auth/me').set(bearer(victim)).send({ password: PASSWORD }).timeout(TIMEOUT);
    for (const table of ['documents', 'doc_chunks', 'chat_messages', 'extractions']) expect(await countFor(table, bystander.id), table).toBeGreaterThan(0);
  });

  it('deleting a document removes its chunks, embeddings and extractions', async () => {
    const user = await registerUser();
    const doc = await seedDocument(user.id, 'Report', REPORT);
    await api().post('/extractions').set(bearer(user)).send({ documentId: doc.id, schemaName: 'invoice' }).timeout(TIMEOUT);
    expect(await countFor('doc_chunks', user.id)).toBeGreaterThan(0);

    await api().delete(`/documents/${doc.id}`).set(bearer(user)).timeout(TIMEOUT);

    expect(await countFor('doc_chunks', user.id)).toBe(0);
    expect(await countFor('extractions', user.id)).toBe(0);
  });
});

describe('retention', () => {
  const NOW = new Date('2026-10-01T12:00:00Z');
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
  const policy = { usageDays: 90, auditDays: 365, budgetDays: 400, conversationDays: 0 };

  async function usage(userId: string, createdAt: Date) {
    const row = await usageRepo.create({ userId, operation: 'chat', provider: 'mock', model: 'mock', inputTokens: 1, outputTokens: 1, success: true });
    await getPool().query('UPDATE usage_logs SET created_at = $2 WHERE id = $1', [row.id, createdAt]);
  }
  const audit = (userId: string | null, occurredAt: Date) =>
    getPool().query("INSERT INTO audit_log (actor_user_id, action, occurred_at) VALUES ($1, 'retention.test', $2)", [userId, occurredAt]);
  const count = async (table: string) => Number((await getPool().query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count);

  it('deletes usage older than the window and keeps the rest', async () => {
    const user = await registerUser();
    await usage(user.id, daysAgo(120));
    await usage(user.id, daysAgo(91));
    await usage(user.id, daysAgo(89));
    await usage(user.id, daysAgo(1));

    const result = await runRetention(policy, NOW);

    expect(result.usageLogs).toBe(2);
    expect(await count('usage_logs')).toBe(2);
  });

  it('deletes audit rows older than the window, through the one door the database allows', async () => {
    await audit(null, daysAgo(400));
    await audit(null, daysAgo(366));
    await audit(null, daysAgo(364));
    const before = await count('audit_log');

    const result = await runRetention(policy, NOW);

    expect(result.auditLog).toBe(2);
    expect(await count('audit_log')).toBe(before - 2);
    // and the door closes again afterwards: a plain DELETE is still refused
    expect(await getPool().query('DELETE FROM audit_log').then(() => 'allowed', (e: { code?: string }) => e.code)).toBe('42501');
  });

  it('deletes expired refresh tokens and old budget counters', async () => {
    const user = await registerUser();
    await getPool().query("UPDATE refresh_tokens SET expires_at = $2 WHERE user_id = $1", [user.id, daysAgo(3)]);
    await budget.reserve(user.id, { tokens: 5, costUsd: 0 }, { dailyTokens: 0, monthlyCostUsd: 0 }, daysAgo(500));
    await getPool().query('UPDATE user_budgets SET updated_at = $2 WHERE user_id = $1', [user.id, daysAgo(500)]);

    const result = await runRetention(policy, NOW);

    expect(result.refreshTokens).toBe(1);
    expect(result.budgets).toBeGreaterThan(0);
    expect(await count('refresh_tokens')).toBe(0);
  });

  it('keeps conversations unless a conversation window is set, then removes only the idle ones', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    const old = await api().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);
    const recent = await api().post('/chat').set(bearer(user)).send({ question: 'What happened to headcount?' }).timeout(TIMEOUT);
    await getPool().query('UPDATE chat_sessions SET created_at = $2 WHERE id = $1', [old.body.sessionId, daysAgo(200)]);
    await getPool().query('UPDATE chat_messages SET created_at = $2 WHERE session_id = $1', [old.body.sessionId, daysAgo(200)]);

    expect((await runRetention(policy, NOW)).conversations).toBe(0); // off by default
    expect(await count('chat_sessions')).toBe(2);

    const result = await runRetention({ ...policy, conversationDays: 180 }, NOW);
    expect(result.conversations).toBe(1);
    const left = await getPool().query('SELECT id FROM chat_sessions');
    expect(left.rows.map((r) => r.id)).toEqual([recent.body.sessionId]);
  });

  it('a window of 0 turns a rule off', async () => {
    const user = await registerUser();
    await usage(user.id, daysAgo(1000));
    await audit(null, daysAgo(1000));
    const before = await count('audit_log');

    const result = await runRetention({ usageDays: 0, auditDays: 0, budgetDays: 0, conversationDays: 0 }, NOW);

    expect(result.usageLogs).toBe(0);
    expect(result.auditLog).toBe(0);
    expect(await count('usage_logs')).toBe(1);
    expect(await count('audit_log')).toBe(before);
  });

  it('is scheduled once a day, and scheduling again does not duplicate it', async () => {
    await scheduleRetention();
    await scheduleRetention();

    const schedulers = (await maintenanceQueue.getJobSchedulers()).filter((s) => s.key === RETENTION_SCHEDULER_ID);
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.pattern).toBe('0 3 * * *');
  });
});

describe('logging policy: what the application really writes', () => {
  const EMAIL = 'ana.secret@example.com';
  const PHONE = '555-123-4567';

  async function appWithLogFile(extraEnv: Record<string, string> = {}) {
    const file = `/tmp/docuchat-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`;
    logFiles.push(file);
    const instance = await loadFreshApp({ LOG_LEVEL: 'debug', LOG_FILE: file, RATE_LIMIT_ENABLED: 'false', ...extraEnv });
    apps.push(instance);
    return { instance, file };
  }

  it('never writes questions, document text, titles or personal data to the logs, but does write ids and sizes', async () => {
    const { instance, file } = await appWithLogFile();
    const user = await registerUser();
    await instance.http().post('/documents').set(bearer(user)).send({ title: `Notes for ${EMAIL}`, content: `Contact ${EMAIL} or ${PHONE}. ${REPORT}` }).timeout(TIMEOUT);
    await seedDocument(user.id, 'Seeded', `Contact ${EMAIL} or ${PHONE}. ${REPORT}`);
    await instance.http().post('/chat').set(bearer(user)).send({ question: `My phone is ${PHONE}. How did revenue change?` }).timeout(TIMEOUT);
    await instance.http().post('/extractions').set(bearer(user)).send({ documentId: (await getPool().query('SELECT id FROM documents WHERE user_id = $1 LIMIT 1', [user.id])).rows[0].id, schemaName: 'invoice' }).timeout(TIMEOUT);

    const log = fs.readFileSync(file, 'utf8');
    expect(log.length).toBeGreaterThan(500); // logging really was on
    for (const secret of [EMAIL, PHONE, 'How did revenue change', 'Q3 revenue grew', 'Notes for']) {
      expect(log, `the log contains "${secret}"`).not.toContain(secret);
    }
    expect(log).toContain('questionLength'); // sizes and ids are logged instead
  });

  it('puts the request id on every application log line of a request', async () => {
    const { instance, file } = await appWithLogFile();
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    await instance.http().post('/chat').set(bearer(user)).set('x-request-id', 'trace-me-42').send({ question: 'How did revenue change?' }).timeout(TIMEOUT);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const forRequest = lines.filter((l) => l.requestId === 'trace-me-42');
    expect(forRequest.length).toBeGreaterThan(2);
    expect(forRequest.some((l) => /Processing chat request/.test(l.msg))).toBe(true);
  });
});

describe('REDACT_PII_BEFORE_LLM', () => {
  it('sends masked text to the model while the user keeps seeing the original passages', async () => {
    const instance = await loadFreshApp({ REDACT_PII_BEFORE_LLM: 'true', RATE_LIMIT_ENABLED: 'false' });
    apps.push(instance);
    const user = await registerUser();
    await seedDocument(user.id, 'Contacts', `Revenue contact: ana@example.com, phone 555-123-4567. ${REPORT}`);

    const res = await instance.http().post('/chat').set(bearer(user)).send({ question: 'Write to bob@example.com: how did revenue change?' }).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    const sent = instance.modelCalls.mock.calls[0]![0].userPrompt as string;
    expect(sent).not.toContain('ana@example.com');
    expect(sent).not.toContain('555-123-4567');
    expect(sent).not.toContain('bob@example.com');
    expect(sent).toContain('[EMAIL]');
    expect(sent).toMatch(/<<<BEGIN_CONTEXT_[0-9a-f]{16}>>>/); // the prompt structure is intact
    // The user's own data is theirs: citations still show the original text
    expect(JSON.stringify(res.body.citations)).toContain('ana@example.com');
  });

  it('is off by default: without it the model receives the text as written', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Contacts', `Revenue contact: ana@example.com. ${REPORT}`);
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    await api().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);

    expect(spy.mock.calls[0]![0].userPrompt).toContain('ana@example.com');
  });
});

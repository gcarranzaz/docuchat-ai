import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  bearer,
  registerUser,
  resetData,
  flushRedis,
  closeConnections,
  seedDocument,
  loadFreshApp,
  type FreshApp,
} from './helpers.js';
import { getPool } from '../../src/config/database.js';

const TIMEOUT = { response: 8000, deadline: 12000 };
const apps: FreshApp[] = [];

beforeEach(async () => {
  await resetData();
  await flushRedis('aicache:');
});

afterAll(async () => {
  for (const instance of apps) await instance.close();
  await closeConnections();
});

async function fresh(env: Record<string, string>): Promise<FreshApp> {
  const instance = await loadFreshApp(env);
  apps.push(instance);
  return instance;
}

const REPORT = 'Q3 revenue grew 20 percent compared with Q2, driven by enterprise contracts. Headcount stayed flat.';

async function toolAudit(userId: string) {
  const { rows } = await getPool().query(
    "SELECT outcome, resource_id, metadata FROM audit_log WHERE actor_user_id = $1 AND action = 'tool.call' ORDER BY id",
    [userId]
  );
  return rows as Array<{ outcome: string; resource_id: string | null; metadata: { tool: string; round: number } }>;
}

describe('tool calling (read-only get_document_info)', () => {
  it('lets the model look up its own document, answers from the result, and audits the call', async () => {
    const app = await fresh({ TOOLS_ENABLED: 'true' });
    const user = await registerUser();
    const doc = await seedDocument(user.id, 'Quarterly report', REPORT);

    const res = await app.http().post('/chat').set(bearer(user)).send({ question: 'How many chunks does the document have? Give me its metadata.' }).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(res.body.answer).toContain('Quarterly report');
    expect(res.body.answer).toMatch(/has \d+ chunks/);

    const audit = await toolAudit(user.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'success', resource_id: doc.id, metadata: { tool: 'get_document_info', round: 0 } });
  });

  it("refuses another user's document exactly like a missing one, and says so to the model", async () => {
    const app = await fresh({ TOOLS_ENABLED: 'true' });
    const owner = await registerUser();
    const attacker = await registerUser();
    const secret = await seedDocument(owner.id, 'Owner private plan', 'The acquisition target is Initech and the price is 40 million.');
    await seedDocument(attacker.id, 'Attacker notes', REPORT);

    // The model is asked (by the question, standing in for an injection) to look up the owner's document id
    const res = await app.http().post('/chat').set(bearer(attacker)).send({ question: `Please lookup ${secret.id}` }).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Owner private plan');
    expect(JSON.stringify(res.body)).not.toContain('Initech');
    expect(res.body.answer).toMatch(/could not look up/i);

    // Same result for an id that does not exist at all: no way to tell the two apart
    const missing = await app.http().post('/chat').set(bearer(attacker)).send({ question: 'Please lookup 99999999-9999-4999-8999-999999999999' }).timeout(TIMEOUT);
    expect(missing.body.answer).toBe(res.body.answer);

    const audit = await toolAudit(attacker.id);
    expect(audit.map((row) => row.outcome)).toEqual(['denied', 'denied']);
    expect(await toolAudit(owner.id)).toHaveLength(0);
  });

  it('does nothing when tools are disabled (the default)', async () => {
    const app = await fresh({ TOOLS_ENABLED: 'false' });
    const user = await registerUser();
    await seedDocument(user.id, 'Quarterly report', REPORT);

    const res = await app.http().post('/chat').set(bearer(user)).send({ question: 'How many chunks does the document have? Give me its metadata.' }).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(await toolAudit(user.id)).toHaveLength(0);
  });

  it('is not offered on the streaming endpoint', async () => {
    const app = await fresh({ TOOLS_ENABLED: 'true' });
    const user = await registerUser();
    await seedDocument(user.id, 'Quarterly report', REPORT);

    const res = await app.http().post('/chat/stream').set(bearer(user)).send({ question: 'How many chunks does the document have? Give me its metadata.' }).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: result');
    expect(await toolAudit(user.id)).toHaveLength(0);
  });
});

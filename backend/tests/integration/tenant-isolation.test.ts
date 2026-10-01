import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  app,
  api,
  bearer,
  registerUser,
  resetData,
  flushRedis,
  closeConnections,
  seedDocument,
  type TestUser,
} from './helpers.js';
import { getPool } from '../../src/config/database.js';
import { MockProvider } from '../../src/ai/providers/mock.provider.js';
import * as chunkRepo from '../../src/repositories/chunk.repository.js';

const TIMEOUT = { response: 8000, deadline: 12000 };
const REPORT = 'Q3 revenue grew 20 percent compared with Q2, driven by enterprise contracts. Headcount stayed flat.';
const ANY_UUID = '00000000-0000-4000-8000-000000000000';

beforeEach(async () => {
  await resetData();
  await flushRedis('aicache:');
  vi.restoreAllMocks();
});
afterAll(closeConnections);

// ---------------------------------------------------------------------------------------------
// Route audit. Every route the app exposes is listed here with how it is scoped. Adding a route
// without adding it here fails the test, so "who can call this, and on whose data?" is always
// answered on purpose. Scoping, for the routes marked `user`: every query takes the caller's id
// from the verified token (never from the request body) and filters on it.
// ---------------------------------------------------------------------------------------------
const PUBLIC_ROUTES = ['GET /health', 'GET /health/ready', 'POST /auth/register', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout'];

const USER_ROUTES = [
  'GET /auth/me', //                                   own profile
  'DELETE /auth/me', //                                the caller's own account (password required); cascades to their data only
  'GET /documents', //                                 own documents
  'GET /documents/:id', //                             own document (id + user_id)
  'POST /documents', //                                created for the caller
  'POST /documents/upload', //                         created for the caller
  'DELETE /documents/:id', //                          own document; chunks and extractions cascade
  'POST /chat', //                                     retrieval filters on the caller; session must be theirs
  'POST /chat/stream', //                              same as POST /chat
  'GET /chat/sessions', //                             own sessions
  'GET /chat/sessions/:id', //                         own session (id + user_id)
  'PATCH /chat/sessions/:id', //                       own session
  'DELETE /chat/sessions/:id', //                      own session
  'DELETE /chat/sessions', //                          all of the caller's sessions only
  'PUT /chat/messages/:id/feedback', //                own assistant message
  'DELETE /chat/messages/:id/feedback', //             own assistant message
  'POST /extractions', //                              own document
  'GET /extractions', //                               own extractions
  'GET /extractions/schemas', //                       static list, no user data
  'GET /extractions/:id', //                           own extraction
  'GET /extractions/document/:documentId', //          own document, then own extractions
  'DELETE /extractions/:id', //                        own extraction
  'DELETE /extractions', //                            all of the caller's extractions only
  'GET /jobs/documents/:documentId', //                own document's job
];

/** Walk Express's router stack and list every "METHOD /path" (without the duplicated /api prefix) */
function discoverRoutes(): string[] {
  const found = new Set<string>();
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        // A route entry without handlers only registers a middleware (a limiter): not an endpoint
        if (layer.route.stack.length < 1) continue;
        for (const method of Object.keys(layer.route.methods)) {
          found.add(`${method.toUpperCase()} ${prefix}${layer.route.path === '/' ? '' : layer.route.path}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const mount = String(layer.regexp.source).replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
        walk(layer.handle.stack, prefix + (mount === '/' ? '' : mount));
      }
    }
  };
  walk((app as any)._router.stack, '');
  return [...found].filter((route) => !route.includes(' /api/')).sort();
}

describe('route audit', () => {
  it('every route the app exposes is accounted for: none can be added unnoticed', () => {
    const discovered = discoverRoutes();
    const documented = [...PUBLIC_ROUTES, ...USER_ROUTES].sort();
    expect(discovered).toEqual(documented);
  });

  it.each(USER_ROUTES)('%s refuses a caller who is not signed in', async (route) => {
    const [method, path] = route.split(' ') as [string, string];
    const url = path.replace(/:\w+/g, ANY_UUID);
    const res = await (api() as any)[method.toLowerCase()](url).timeout(TIMEOUT);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// Two users. B tries everything against A's data.
// ---------------------------------------------------------------------------------------------
interface Scenario {
  a: TestUser;
  b: TestUser;
  docA: { id: string };
  sessionA: string;
  messageA: string;
  extractionA: string;
}

async function twoUsers(): Promise<Scenario> {
  const [a, b] = [await registerUser(), await registerUser()];
  const docA = await seedDocument(a.id, 'A confidential report', REPORT);
  const chat = await api().post('/chat').set(bearer(a)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);
  const extraction = await api().post('/extractions').set(bearer(a)).send({ documentId: docA.id, schemaName: 'invoice' }).timeout(TIMEOUT);
  expect(chat.status).toBe(200);
  expect(extraction.status).toBeLessThan(300);
  return { a, b, docA, sessionA: chat.body.sessionId, messageA: chat.body.messageId, extractionA: extraction.body.id };
}

const count = async (sql: string, params: unknown[]) => Number((await getPool().query(sql, params)).rows[0].count);

describe("user B cannot reach user A's data", () => {
  it('documents: not readable, not listed, not deletable', async () => {
    const { b, docA } = await twoUsers();

    expect((await api().get(`/documents/${docA.id}`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);
    const list = await api().get('/documents').set(bearer(b)).timeout(TIMEOUT);
    expect(list.body.documents).toEqual([]);
    expect((await api().delete(`/documents/${docA.id}`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);

    expect(await count('SELECT COUNT(*) FROM documents WHERE id = $1', [docA.id])).toBe(1); // still there
    expect(await count('SELECT COUNT(*) FROM doc_chunks WHERE document_id = $1', [docA.id])).toBeGreaterThan(0);
  });

  it('chat: asking over A\'s document id retrieves nothing and never calls the model', async () => {
    const { b, docA } = await twoUsers();
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    const res = await api().post('/chat').set(bearer(b)).send({ question: 'How did revenue change?', documentIds: [docA.id] }).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(res.body.confidence.level).toBe('NONE');
    expect(res.body.citations).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('revenue grew'); // none of A's text reaches B
    expect(spy).not.toHaveBeenCalled();
  });

  it("chat: B cannot continue or read A's conversation, in either endpoint", async () => {
    const { b, sessionA } = await twoUsers();

    expect((await api().post('/chat').set(bearer(b)).send({ question: 'hi?', sessionId: sessionA }).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().post('/chat/stream').set(bearer(b)).send({ question: 'hi?', sessionId: sessionA }).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().get(`/chat/sessions/${sessionA}`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().patch(`/chat/sessions/${sessionA}`).set(bearer(b)).send({ title: 'mine now' }).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().delete(`/chat/sessions/${sessionA}`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);

    const list = await api().get('/chat/sessions').set(bearer(b)).timeout(TIMEOUT);
    expect(list.body.sessions).toEqual([]);

    const { rows } = await getPool().query('SELECT title FROM chat_sessions WHERE id = $1', [sessionA]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).not.toBe('mine now');
    expect(await count('SELECT COUNT(*) FROM chat_messages WHERE session_id = $1', [sessionA])).toBe(2); // B added nothing
  });

  it('extractions: not readable, not listed, not deletable, and not creatable over A\'s document', async () => {
    const { b, docA, extractionA } = await twoUsers();

    expect((await api().get(`/extractions/${extractionA}`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().get(`/extractions/document/${docA.id}`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().delete(`/extractions/${extractionA}`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().post('/extractions').set(bearer(b)).send({ documentId: docA.id, schemaName: 'invoice' }).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().get('/extractions').set(bearer(b)).timeout(TIMEOUT)).body.extractions ?? []).toEqual([]);

    expect(await count('SELECT COUNT(*) FROM extractions WHERE id = $1', [extractionA])).toBe(1);
  });

  it("jobs: B cannot see A's document job; A can", async () => {
    const { a, b, docA } = await twoUsers();
    expect((await api().get(`/jobs/documents/${docA.id}`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().get(`/jobs/documents/${docA.id}`).set(bearer(a)).timeout(TIMEOUT)).status).toBe(200);
  });

  it("feedback: B cannot vote on, or clear a vote on, A's answer", async () => {
    const { a, b, messageA } = await twoUsers();
    await api().put(`/chat/messages/${messageA}/feedback`).set(bearer(a)).send({ rating: 'up' }).timeout(TIMEOUT);

    expect((await api().put(`/chat/messages/${messageA}/feedback`).set(bearer(b)).send({ rating: 'down' }).timeout(TIMEOUT)).status).toBe(404);
    expect((await api().delete(`/chat/messages/${messageA}/feedback`).set(bearer(b)).timeout(TIMEOUT)).status).toBe(404);

    const { rows } = await getPool().query('SELECT user_id, rating FROM message_feedback WHERE message_id = $1', [messageA]);
    expect(rows).toEqual([{ user_id: a.id, rating: 'up' }]);
  });

  it("bulk deletes only ever touch the caller's own data", async () => {
    const { a, b, sessionA, extractionA } = await twoUsers();
    await api().post('/chat').set(bearer(b)).send({ question: 'anything?' }).timeout(TIMEOUT); // B has a session too

    expect((await api().delete('/chat/sessions').set(bearer(b)).timeout(TIMEOUT)).status).toBeLessThan(300);
    expect((await api().delete('/extractions').set(bearer(b)).timeout(TIMEOUT)).status).toBeLessThan(300);

    expect(await count('SELECT COUNT(*) FROM chat_sessions WHERE user_id = $1', [b.id])).toBe(0);
    expect(await count('SELECT COUNT(*) FROM chat_sessions WHERE id = $1', [sessionA])).toBe(1); // A's survived
    expect(await count('SELECT COUNT(*) FROM extractions WHERE id = $1', [extractionA])).toBe(1);
    expect(await count('SELECT COUNT(*) FROM documents WHERE user_id = $1', [a.id])).toBe(1);
  });

  it("the answer cache never hands B an answer produced from A's documents", async () => {
    const { a, b } = await twoUsers();
    await seedDocument(b.id, 'B report', REPORT); // same text, different owner
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    await api().post('/chat').set(bearer(a)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT); // may be cached
    await api().post('/chat').set(bearer(b)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);

    // B's request had to run its own retrieval and its own model call
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('vector search is scoped inside the SQL, not after it', () => {
  it("returns none of A's chunks to B even for an identical embedding, and with A's document id supplied", async () => {
    const [a, b] = [await registerUser(), await registerUser()];
    const doc = await seedDocument(a.id, 'A report', REPORT);
    const { rows } = await getPool().query('SELECT embedding::text AS embedding FROM doc_chunks WHERE user_id = $1 LIMIT 1', [a.id]);
    const embedding = JSON.parse(rows[0].embedding) as number[];

    const forA = await chunkRepo.findSimilar(a.id, embedding, { limit: 5, minSimilarity: 0 });
    const forB = await chunkRepo.findSimilar(b.id, embedding, { limit: 5, minSimilarity: 0 });
    const forBWithDoc = await chunkRepo.findSimilar(b.id, embedding, { limit: 5, minSimilarity: 0, documentIds: [doc.id] });

    expect(forA.length).toBeGreaterThan(0);
    expect(forB).toEqual([]);
    expect(forBWithDoc).toEqual([]);
  });

  it('with several users, each only ever sees their own chunks', async () => {
    const users = [await registerUser(), await registerUser(), await registerUser()];
    for (const [index, user] of users.entries()) await seedDocument(user.id, `Doc ${index}`, `${REPORT} Marker-${index}.`);
    const { rows } = await getPool().query('SELECT embedding::text AS embedding FROM doc_chunks LIMIT 1');
    const embedding = JSON.parse(rows[0].embedding) as number[];

    for (const user of users) {
      const found = await chunkRepo.findSimilar(user.id, embedding, { limit: 20, minSimilarity: 0 });
      expect(found.length).toBe(1);
      expect(found.every((f) => f.chunk.userId === user.id)).toBe(true);
    }
  });
});

describe('the database refuses a row owned by a different user than its parent', () => {
  const rejected = async (sql: string, params: unknown[]) => {
    const error = await getPool().query(sql, params).then(() => null, (e: { code?: string }) => e);
    return error?.code; // 23503 = foreign_key_violation
  };

  it('chunk → document', async () => {
    const { a, b, docA } = await twoUsers();
    expect(await rejected('UPDATE doc_chunks SET user_id = $1 WHERE document_id = $2', [b.id, docA.id])).toBe('23503');
    expect(
      await rejected("INSERT INTO doc_chunks (document_id, user_id, chunk_index, content) VALUES ($1, $2, 99, 'planted')", [docA.id, b.id])
    ).toBe('23503');
    expect(await count('SELECT COUNT(*) FROM doc_chunks WHERE user_id = $1', [a.id])).toBeGreaterThan(0);
  });

  it('message → session', async () => {
    const { b, sessionA } = await twoUsers();
    expect(await rejected("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1, $2, 'user', 'planted')", [sessionA, b.id])).toBe(
      '23503'
    );
  });

  it('extraction → document', async () => {
    const { b, extractionA } = await twoUsers();
    expect(await rejected('UPDATE extractions SET user_id = $1 WHERE id = $2', [b.id, extractionA])).toBe('23503');
  });

  it('feedback → message', async () => {
    const { a, b, messageA } = await twoUsers();
    await api().put(`/chat/messages/${messageA}/feedback`).set(bearer(a)).send({ rating: 'up' }).timeout(TIMEOUT);
    expect(await rejected("INSERT INTO message_feedback (user_id, message_id, rating) VALUES ($1, $2, 'down')", [b.id, messageA])).toBe('23503');
  });

  it('still allows the normal case: a user adds to their own parents', async () => {
    const { a, docA, sessionA } = await twoUsers();
    expect(await rejected("INSERT INTO doc_chunks (document_id, user_id, chunk_index, content) VALUES ($1, $2, 77, 'mine')", [docA.id, a.id])).toBeUndefined();
    expect(await rejected("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1, $2, 'user', 'mine')", [sessionA, a.id])).toBeUndefined();
  });
});

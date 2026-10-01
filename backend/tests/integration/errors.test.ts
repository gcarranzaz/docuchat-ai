import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { api, bearer, registerUser, resetData, closeConnections, seedDocument, flushRedis, type TestUser } from './helpers.js';
import { MockProvider } from '../../src/ai/providers/mock.provider.js';

let user: TestUser;
const TIMEOUT = { response: 5000, deadline: 8000 };

beforeEach(async () => {
  await resetData();
  await flushRedis('aicache:');
  vi.restoreAllMocks();
  user = await registerUser();
});
afterAll(closeConnections);

describe('error paths answer instead of hanging (async handlers)', () => {
  it('chat: invalid body → 400 with the standard error shape', async () => {
    const res = await api().post('/chat').set(bearer(user)).send({ question: '' }).timeout(TIMEOUT);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('chat: a session id that does not exist → 404', async () => {
    const res = await api()
      .post('/chat')
      .set(bearer(user))
      .send({ question: 'hello?', sessionId: '00000000-0000-4000-8000-000000000000' })
      .timeout(TIMEOUT);
    expect(res.status).toBe(404);
  });

  it('chat: a malformed session id → 400', async () => {
    const res = await api().post('/chat').set(bearer(user)).send({ question: 'hello?', sessionId: 'nope' }).timeout(TIMEOUT);
    expect(res.status).toBe(400);
  });

  it('extractions: unknown schema → 400, unknown document → 404', async () => {
    const doc = await seedDocument(user.id, 'Doc', 'Some content about invoices. Invoice number 42.');
    const badSchema = await api().post('/extractions').set(bearer(user)).send({ documentId: doc.id, schemaName: 'nope' }).timeout(TIMEOUT);
    expect(badSchema.status).toBe(400);

    const missingDoc = await api()
      .post('/extractions')
      .set(bearer(user))
      .send({ documentId: '00000000-0000-4000-8000-000000000000', schemaName: 'invoice' })
      .timeout(TIMEOUT);
    expect(missingDoc.status).toBe(404);
  });

  it('chat sessions: unknown id → 404', async () => {
    const res = await api().get('/chat/sessions/00000000-0000-4000-8000-000000000000').set(bearer(user)).timeout(TIMEOUT);
    expect(res.status).toBe(404);
  });
});

describe('per-request bounds are enforced before any model call', () => {
  it('rejects an over-long question with 400 and never calls the model', async () => {
    const spy = vi.spyOn(MockProvider.prototype, 'complete');
    const res = await api()
      .post('/chat')
      .set(bearer(user))
      .send({ question: 'a'.repeat(2500) }) // configured limit: 2000 characters
      .timeout(TIMEOUT);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QUESTION');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a question made only of invisible characters', async () => {
    const spy = vi.spyOn(MockProvider.prototype, 'complete');
    const res = await api().post('/chat').set(bearer(user)).send({ question: '​​​' }).timeout(TIMEOUT);
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('chat answers', () => {
  it('returns the parsed answer text with citations, model and prompt version', async () => {
    await seedDocument(user.id, 'Report', 'Q3 revenue grew 20 percent compared with Q2. Headcount stayed flat at 120 people.');
    const res = await api().post('/chat').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(res.body.answer.startsWith('{')).toBe(false);
    expect(res.body.citations.length).toBeGreaterThan(0);
    expect(res.body.metadata).toMatchObject({ promptVersion: 'chat_rag:v3.0', model: 'mock' });
  });

  it('stores model and prompt version on the assistant message', async () => {
    await seedDocument(user.id, 'Report', 'Q3 revenue grew 20 percent compared with Q2.');
    const chat = await api().post('/chat').set(bearer(user)).send({ question: 'Revenue?' }).timeout(TIMEOUT);
    const session = await api().get(`/chat/sessions/${chat.body.sessionId}`).set(bearer(user)).timeout(TIMEOUT);

    const assistant = session.body.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistant.model_used ?? assistant.modelUsed).toBe('mock');
    expect(assistant.prompt_version ?? assistant.promptVersion).toBe('chat_rag:v3.0');
  });

  it('answers "no information" without calling the model when nothing is retrieved', async () => {
    const spy = vi.spyOn(MockProvider.prototype, 'complete');
    const res = await api().post('/chat').set(bearer(user)).send({ question: 'Anything at all?' }).timeout(TIMEOUT);
    expect(res.status).toBe(200);
    expect(res.body.confidence.level).toBe('NONE');
    expect(spy).not.toHaveBeenCalled();
  });
});

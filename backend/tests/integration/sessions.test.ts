import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api, bearer, registerUser, resetData, flushRedis, closeConnections, seedDocument } from './helpers.js';

const TIMEOUT = { response: 8000, deadline: 12000 };

beforeEach(async () => {
  await resetData();
  await flushRedis('aicache:');
});

afterAll(async () => {
  await closeConnections();
});

const validDate = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value));

describe('chat sessions API (the shape the History page reads)', () => {
  async function userWithOneConversation() {
    const user = await registerUser();
    await seedDocument(user.id, 'Handbook', 'Employees may work remotely up to three days per week.');
    const chat = await api().post('/chat').set(bearer(user)).send({ question: 'How many days of remote work?' }).timeout(TIMEOUT);
    expect(chat.status).toBe(200);
    return { user, sessionId: chat.body.sessionId as string };
  }

  it('lists sessions with a message count and valid dates (not "Invalid Date" or a missing count)', async () => {
    const { user, sessionId } = await userWithOneConversation();

    const res = await api().get('/chat/sessions').set(bearer(user)).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const [session] = res.body.sessions;
    expect(session.id).toBe(sessionId);
    expect(session.messageCount).toBe(2); // the question and the answer
    expect(validDate(session.createdAt)).toBe(true);
    expect(validDate(session.lastMessageAt)).toBe(true);
    expect(typeof session.title).toBe('string');
  });

  it('returns a session with camelCase fields and its messages in order', async () => {
    const { user, sessionId } = await userWithOneConversation();

    const res = await api().get(`/chat/sessions/${sessionId}`).set(bearer(user)).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(sessionId);
    expect(validDate(res.body.session.createdAt)).toBe(true);
    expect(validDate(res.body.session.updatedAt)).toBe(true);
    expect(res.body.session).not.toHaveProperty('created_at'); // no raw database columns in the API

    const [asked, answered] = res.body.messages;
    expect(asked.role).toBe('user');
    expect(answered.role).toBe('assistant');
    expect(validDate(asked.createdAt)).toBe(true);
    expect(validDate(answered.createdAt)).toBe(true);
    expect(answered.sessionId).toBe(sessionId);
    expect(typeof answered.confidenceScore).toBe('number'); // DECIMAL arrives as a string from the driver
    expect(answered.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(answered.confidenceScore).toBeLessThanOrEqual(1);
    expect(Array.isArray(answered.citations)).toBe(true);
    expect(answered.promptVersion).toMatch(/^chat_rag:/);
    expect(answered).not.toHaveProperty('confidence_score');
  });

  it("includes the user's own vote on an answer when listing a session", async () => {
    const { user, sessionId } = await userWithOneConversation();
    const detail = await api().get(`/chat/sessions/${sessionId}`).set(bearer(user)).timeout(TIMEOUT);
    const answerId = detail.body.messages[1].id as string;
    await api().put(`/chat/messages/${answerId}/feedback`).set(bearer(user)).send({ rating: 'down' }).timeout(TIMEOUT);

    const after = await api().get(`/chat/sessions/${sessionId}`).set(bearer(user)).timeout(TIMEOUT);

    expect(after.body.messages[0].feedbackRating).toBeNull();
    expect(after.body.messages[1].feedbackRating).toBe('down');
  });

  it('renaming a session returns it with camelCase fields', async () => {
    const { user, sessionId } = await userWithOneConversation();

    const res = await api().patch(`/chat/sessions/${sessionId}`).set(bearer(user)).send({ title: 'Remote work policy' }).timeout(TIMEOUT);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Remote work policy');
    expect(validDate(res.body.createdAt)).toBe(true);
    expect(validDate(res.body.updatedAt)).toBe(true);
    expect(res.body).not.toHaveProperty('created_at');
  });
});

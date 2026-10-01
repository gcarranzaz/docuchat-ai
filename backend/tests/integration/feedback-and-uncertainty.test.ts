import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { api, bearer, registerUser, resetData, flushRedis, closeConnections, seedDocument, type TestUser } from './helpers.js';
import { getPool } from '../../src/config/database.js';
import { MockProvider } from '../../src/ai/providers/mock.provider.js';
import * as feedbackRepo from '../../src/repositories/feedback.repository.js';

const TIMEOUT = { response: 8000, deadline: 12000 };
const REPORT = 'Q3 revenue grew 20 percent compared with Q2, driven by enterprise contracts. Headcount stayed flat.';

beforeEach(async () => {
  await resetData();
  await flushRedis('aicache:');
  vi.restoreAllMocks();
});
afterAll(closeConnections);

const ask = (user: TestUser, body: Record<string, unknown>) => api().post('/chat').set(bearer(user)).send(body).timeout(TIMEOUT);

async function answeredMessage(user: TestUser, question = 'How did revenue change?') {
  await seedDocument(user.id, 'Report', REPORT);
  const res = await ask(user, { question });
  return { messageId: res.body.messageId as string, sessionId: res.body.sessionId as string };
}

describe('grounded flag', () => {
  it('is true when the answer is backed by a citation', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    const res = await ask(user, { question: 'How did revenue change?' });
    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(true);
    expect(res.body.citations.length).toBeGreaterThan(0);
  });

  it('is false when nothing relevant was found, and the model is not called', async () => {
    const user = await registerUser();
    const spy = vi.spyOn(MockProvider.prototype, 'complete');
    const res = await ask(user, { question: 'Anything at all?' });
    expect(res.body.grounded).toBe(false);
    expect(res.body.confidence.level).toBe('NONE');
    expect(spy).not.toHaveBeenCalled();
  });

  it('is false when the model answers without a single valid citation', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    vi.spyOn(MockProvider.prototype, 'complete').mockResolvedValue({
      content: JSON.stringify({ answer: 'I think revenue grew.', citations: [], confidence: 'HIGH', reasoning: 'guess' }),
      inputTokens: 10,
      outputTokens: 10,
      model: 'mock',
    });

    const res = await ask(user, { question: 'How did revenue change?' });

    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(false); // a confident-sounding answer with no support is not "grounded"
  });

  it('is false when every citation points at a chunk the model was never given', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    vi.spyOn(MockProvider.prototype, 'complete').mockResolvedValue({
      content: JSON.stringify({ answer: 'Made up [chunk-42]', citations: [42], confidence: 'HIGH' }),
      inputTokens: 10,
      outputTokens: 10,
      model: 'mock',
    });

    const res = await ask(user, { question: 'How did revenue change?' });
    expect(res.body.citations).toHaveLength(0);
    expect(res.body.grounded).toBe(false);
  });

  it('is stored with the message', async () => {
    const user = await registerUser();
    const { messageId } = await answeredMessage(user);
    const { rows } = await getPool().query('SELECT metadata FROM chat_messages WHERE id = $1', [messageId]);
    expect(rows[0].metadata.grounded).toBe(true);
  });
});

describe('regenerate', () => {
  it('asks the model again instead of replaying the cached answer, and keeps both attempts in the conversation', async () => {
    const user = await registerUser();
    const { sessionId } = await answeredMessage(user);
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    const again = await ask(user, { question: 'How did revenue change?', sessionId, regenerate: true });

    expect(again.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);

    const session = await api().get(`/chat/sessions/${sessionId}`).set(bearer(user)).timeout(TIMEOUT);
    expect(session.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('leaves the attempt being replaced out of the context the model sees', async () => {
    const user = await registerUser();
    const { sessionId } = await answeredMessage(user);
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    await ask(user, { question: 'How did revenue change?', sessionId, regenerate: true });

    const prompt = spy.mock.calls[0]![0].userPrompt;
    expect(prompt).not.toContain('BEGIN_HISTORY'); // nothing earlier than the attempt being replaced
  });

  it('still includes earlier, different turns as history', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    const first = await ask(user, { question: 'What happened to headcount?' });
    const second = await ask(user, { question: 'How did revenue change?', sessionId: first.body.sessionId });
    const spy = vi.spyOn(MockProvider.prototype, 'complete');

    await ask(user, { question: 'How did revenue change?', sessionId: second.body.sessionId, regenerate: true });

    expect(spy.mock.calls[0]![0].userPrompt).toContain('What happened to headcount?');
  });
});

describe('feedback', () => {
  const rate = (user: TestUser, messageId: string, body: Record<string, unknown>) =>
    api().put(`/chat/messages/${messageId}/feedback`).set(bearer(user)).send(body).timeout(TIMEOUT);

  it('records a vote and lets the user change it (one vote per message)', async () => {
    const user = await registerUser();
    const { messageId } = await answeredMessage(user);

    const up = await rate(user, messageId, { rating: 'up' });
    expect(up.status).toBe(200);
    expect(up.body.feedback.rating).toBe('up');

    const down = await rate(user, messageId, { rating: 'down', reason: 'The headcount figure is wrong' });
    expect(down.body.feedback).toMatchObject({ rating: 'down', reason: 'The headcount figure is wrong' });

    const { rows } = await getPool().query('SELECT rating FROM message_feedback WHERE message_id = $1', [messageId]);
    expect(rows).toEqual([{ rating: 'down' }]);
  });

  it('shows the vote when the conversation is loaded again', async () => {
    const user = await registerUser();
    const { messageId, sessionId } = await answeredMessage(user);
    await rate(user, messageId, { rating: 'up' });

    const session = await api().get(`/chat/sessions/${sessionId}`).set(bearer(user)).timeout(TIMEOUT);
    const assistant = session.body.messages.find((m: { id: string }) => m.id === messageId);
    expect(assistant.feedback_rating).toBe('up');
    const userMessage = session.body.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMessage.feedback_rating).toBeNull();
  });

  it('clears a vote', async () => {
    const user = await registerUser();
    const { messageId } = await answeredMessage(user);
    await rate(user, messageId, { rating: 'down' });

    const res = await api().delete(`/chat/messages/${messageId}/feedback`).set(bearer(user)).timeout(TIMEOUT);
    expect(res.status).toBe(204);
    expect(await feedbackRepo.find(user.id, messageId)).toBeNull();
  });

  it("cannot rate, or clear a vote on, another user's message: 404, and nothing is written", async () => {
    const [owner, intruder] = [await registerUser(), await registerUser()];
    const { messageId } = await answeredMessage(owner);

    expect((await rate(intruder, messageId, { rating: 'down' })).status).toBe(404);
    expect((await api().delete(`/chat/messages/${messageId}/feedback`).set(bearer(intruder)).timeout(TIMEOUT)).status).toBe(404);

    const { rows } = await getPool().query('SELECT 1 FROM message_feedback WHERE message_id = $1', [messageId]);
    expect(rows).toHaveLength(0);
  });

  it('only assistant answers can be rated, not the user\'s own question', async () => {
    const user = await registerUser();
    const { sessionId } = await answeredMessage(user);
    const session = await api().get(`/chat/sessions/${sessionId}`).set(bearer(user)).timeout(TIMEOUT);
    const userMessage = session.body.messages.find((m: { role: string }) => m.role === 'user');

    expect((await rate(user, userMessage.id, { rating: 'up' })).status).toBe(404);
  });

  it('validates the input', async () => {
    const user = await registerUser();
    const { messageId } = await answeredMessage(user);

    expect((await rate(user, messageId, { rating: 'meh' })).status).toBe(400);
    expect((await rate(user, messageId, {})).status).toBe(400);
    expect((await rate(user, messageId, { rating: 'down', reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await rate(user, 'not-a-uuid', { rating: 'up' })).status).toBe(400);
    expect((await api().put(`/chat/messages/${messageId}/feedback`).send({ rating: 'up' }).timeout(TIMEOUT)).status).toBe(401);
  });

  it('is deleted with the conversation', async () => {
    const user = await registerUser();
    const { messageId, sessionId } = await answeredMessage(user);
    await rate(user, messageId, { rating: 'up' });

    const res = await api().delete(`/chat/sessions/${sessionId}`).set(bearer(user)).timeout(TIMEOUT);
    expect(res.status).toBeLessThan(300);

    const { rows } = await getPool().query('SELECT 1 FROM message_feedback WHERE message_id = $1', [messageId]);
    expect(rows).toHaveLength(0);
  });

  it('offers down-voted answers, with their question, to the review queue', async () => {
    const user = await registerUser();
    const { messageId } = await answeredMessage(user, 'How did revenue change?');
    await rate(user, messageId, { rating: 'down', reason: 'wrong' });

    const queue = await feedbackRepo.recentDownvotes();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ messageId, question: 'How did revenue change?', reason: 'wrong', promptVersion: 'chat_rag:v3.0', model: 'mock' });
  });
});

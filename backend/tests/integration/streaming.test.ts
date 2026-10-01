import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  app,
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
import { MockProvider } from '../../src/ai/providers/mock.provider.js';
import { LlmProviderError } from '../../src/ai/providers/errors.js';
import * as budget from '../../src/services/budget.service.js';

const TIMEOUT = { response: 10_000, deadline: 15_000 };
const REPORT = 'Q3 revenue grew 20 percent compared with Q2, driven by enterprise contracts. Headcount stayed flat.';
const apps: FreshApp[] = [];

interface SseEvent {
  event: string;
  data: any;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block !== '' && !block.startsWith(':'))
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

/** POST /chat/stream and collect the whole stream as text */
function stream(user: TestUser, body: Record<string, unknown>) {
  return api()
    .post('/chat/stream')
    .set(bearer(user))
    .send(body)
    .buffer(true)
    .parse((res, callback) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => callback(null, data));
    })
    .timeout(TIMEOUT);
}

beforeEach(async () => {
  await resetData();
  await flushRedis('aicache:');
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const instance of apps) await instance.close();
  await closeConnections();
});

describe('POST /chat/stream', () => {
  it('sends status, then tokens, then one result, in that order', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);

    const res = await stream(user, { question: 'How did revenue change?' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['x-accel-buffering']).toBe('no');

    const events = parseSse(res.body as unknown as string);
    expect(events[0]).toEqual({ event: 'status', data: { phase: 'generating' } });
    expect(events.at(-1)!.event).toBe('result');
    expect(events.filter((e) => e.event === 'result')).toHaveLength(1);

    const tokenEvents = events.filter((e) => e.event === 'token');
    expect(tokenEvents.length).toBeGreaterThan(3);
    // every token comes before the result
    expect(events.indexOf(tokenEvents.at(-1)!)).toBeLessThan(events.length - 1);
  });

  it('streams the answer text, not JSON, and it equals the final validated answer', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);

    const events = parseSse((await stream(user, { question: 'How did revenue change?' })).body as unknown as string);
    const draft = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
    const result = events.find((e) => e.event === 'result')!.data;

    expect(draft).not.toContain('{"answer"');
    expect(draft).toBe(result.answer);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.metadata).toMatchObject({ promptVersion: 'chat_rag:v3.0', model: 'mock' });
  });

  it('saves the conversation like the non-streaming endpoint does', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);

    const events = parseSse((await stream(user, { question: 'How did revenue change?' })).body as unknown as string);
    const result = events.find((e) => e.event === 'result')!.data;

    const session = await api().get(`/chat/sessions/${result.sessionId}`).set(bearer(user)).timeout(TIMEOUT);
    expect(session.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });

  it('answers "no information" as a plain result, with no tokens, when nothing is retrieved', async () => {
    const user = await registerUser();
    const spy = vi.spyOn(MockProvider.prototype, 'stream');

    const events = parseSse((await stream(user, { question: 'Anything at all?' })).body as unknown as string);

    expect(events.map((e) => e.event)).toEqual(['status', 'result']);
    expect(events[1]!.data.confidence.level).toBe('NONE');
    expect(spy).not.toHaveBeenCalled();
  });

  it('delivers a cached answer as a result with no tokens and no model call', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    await stream(user, { question: 'How did revenue change?' }); // fills the cache
    const spy = vi.spyOn(MockProvider.prototype, 'stream');

    const events = parseSse((await stream(user, { question: 'How did revenue change?' })).body as unknown as string);

    expect(events.map((e) => e.event)).toEqual(['status', 'result']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses before opening the stream: real HTTP errors, not a stream with an error inside', async () => {
    const user = await registerUser();

    const invalid = await api().post('/chat/stream').set(bearer(user)).send({ question: '' }).timeout(TIMEOUT);
    expect(invalid.status).toBe(400);
    expect(invalid.headers['content-type']).toMatch(/json/);

    const unknownSession = await api()
      .post('/chat/stream')
      .set(bearer(user))
      .send({ question: 'hello?', sessionId: '00000000-0000-4000-8000-000000000000' })
      .timeout(TIMEOUT);
    expect(unknownSession.status).toBe(404);

    const unauthenticated = await api().post('/chat/stream').send({ question: 'hello?' }).timeout(TIMEOUT);
    expect(unauthenticated.status).toBe(401);
  });

  it('returns a real 429 (not a stream) when the budget is exhausted, and never calls the model', async () => {
    const instance = await loadFreshApp({ USER_DAILY_TOKEN_BUDGET: '3000', RATE_LIMIT_ENABLED: 'false' });
    apps.push(instance);
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);

    const res = await instance.http().post('/chat/stream').set(bearer(user)).send({ question: 'How did revenue change?' }).timeout(TIMEOUT);

    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe('DAILY_TOKEN_BUDGET_EXCEEDED');
    expect(instance.modelCalls).not.toHaveBeenCalled();
  });

  it('reports a mid-stream failure as an error event, ends the stream, and still charges for what was generated', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);
    vi.spyOn(MockProvider.prototype, 'stream').mockImplementation(async (_params, handlers) => {
      handlers.onToken('{"answer": "The revenue gr');
      throw new LlmProviderError('provider dropped the connection', 'mock', 500, false);
    });

    const res = await stream(user, { question: 'How did revenue change?' });
    const events = parseSse(res.body as unknown as string);

    expect(res.status).toBe(200); // headers were already sent when it failed
    expect(events.map((e) => e.event)).toEqual(['status', 'token', 'error']);
    expect(events.at(-1)!.data.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(events)).not.toContain('dropped the connection'); // no internals leak to the client

    // Generated text is billed by the provider even when the stream breaks: it must not be free
    expect((await budget.getUsage(user.id)).dayTokens).toBeGreaterThan(0);
  });

  it('stops generating when the client disconnects, and charges only an estimate of what was produced', async () => {
    const user = await registerUser();
    await seedDocument(user.id, 'Report', REPORT);

    let seenSignal: AbortSignal | undefined;
    let outcome: unknown = 'pending';
    const original = MockProvider.prototype.stream;
    vi.spyOn(MockProvider.prototype, 'stream').mockImplementation(function (this: MockProvider, params, handlers) {
      seenSignal = handlers.signal;
      const running = original.call(this, params, handlers);
      running.then(
        () => (outcome = 'completed'),
        (error) => (outcome = error?.name)
      );
      return running;
    });

    const server = app.listen(0);
    const controller = new AbortController();
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer(user) },
        body: JSON.stringify({ question: 'How did revenue change?' }),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read(); // the first chunk (status) has arrived: generation is under way
      controller.abort(); // the user closed the tab

      // The server must notice and stop the provider instead of generating to the end
      await vi.waitFor(() => expect(outcome).toBe('StreamAbortedError'), { timeout: 5000, interval: 25 });
      expect(seenSignal?.aborted).toBe(true);
    } finally {
      server.close();
    }

    const usage = await budget.getUsage(user.id);
    expect(usage.dayTokens).toBeGreaterThan(0); // an abort is not free: the estimate for what was produced is kept
    expect(usage.dayTokens).toBeLessThan(2000); // and the 4096-token reservation was not kept in full
  });
});

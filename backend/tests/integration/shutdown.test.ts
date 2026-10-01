import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_ENV } from './env.js';
import { registerUser, resetData, seedDocument, closeConnections } from './helpers.js';

const PORT = 3027;
const BASE = `http://127.0.0.1:${PORT}`;
const backend = path.join(__dirname, '..', '..');
const LOG_FILE = `/tmp/docuchat-shutdown-${Date.now()}.log`;
let child: ChildProcess | undefined;

/** Warnings and errors the server wrote (synchronous JSON file: a pretty-printing transport can lose lines on exit) */
const serverProblems = () =>
  (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '')
    .split('\n')
    .filter((line) => /"level":(40|50|60)/.test(line))
    .slice(-3)
    .join('\n')
    .slice(0, 1500);

afterAll(async () => {
  child?.kill('SIGKILL');
  fs.rmSync(LOG_FILE, { force: true });
  await closeConnections();
});

function startServer(): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: backend,
    env: {
      ...process.env,
      ...TEST_ENV,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      LOG_FILE,
      PORT: String(PORT),
      FRONTEND_URL: 'http://localhost:5173',
      MOCK_STREAM_DELAY_MS: '40', // a streamed answer that takes a few seconds, so SIGTERM lands in the middle
      SHUTDOWN_GRACE_MS: '20000',
    },
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return resolve(proc);
      } catch {
        // not up yet
      }
      if (Date.now() - started > 30_000) return reject(new Error('server did not start'));
      setTimeout(poll, 250);
    };
    void poll();
  });
}

describe('graceful shutdown', () => {
  it('lets a streamed answer finish after SIGTERM, refuses new connections, and exits cleanly', async () => {
    await resetData();
    child = await startServer();
    const exited = new Promise<number | null>((resolve) => child!.once('exit', (code) => resolve(code)));

    const user = await registerUser();
    await seedDocument(user.id, 'Report', 'Q3 revenue grew 20 percent compared with Q2, driven by enterprise contracts. Headcount stayed flat.');

    const response = await fetch(`${BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
      body: JSON.stringify({ question: 'How did revenue change?' }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader.read()).value); // generation is under way

    child.kill('SIGTERM'); // a deploy replaces this task

    // 1. no new work is accepted
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refused = await fetch(`${BASE}/health`).then(() => false, () => true);
    expect(refused).toBe(true);

    // 2. but the answer that was already streaming completes, with its final result
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    expect(received, `received: ${received.slice(0, 400)}\nserver problems:\n${serverProblems()}`).toContain('event: result');
    expect(received).not.toContain('event: error');

    // 3. and the process exits normally once nothing is in flight
    expect(await exited).toBe(0);
  }, 60_000);
});

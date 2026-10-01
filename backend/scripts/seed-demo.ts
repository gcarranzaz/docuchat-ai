/**
 * Demo seed: creates a demo user and uploads the sample documents through the public API,
 * so it exercises the same path a real user does (validation, chunking, async embedding).
 *
 *   npm run seed:demo                         # against http://localhost:3001
 *   API_URL=http://localhost:5173/api npm run seed:demo
 *
 * Idempotent: if the user already exists it logs in instead, and documents already present
 * (same title) are skipped. Works with any provider; with the mock provider no keys are needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = (process.env['API_URL'] ?? 'http://localhost:3001').replace(/\/$/, '');
const EMAIL = process.env['DEMO_EMAIL'] ?? 'demo@example.com';
const PASSWORD = process.env['DEMO_PASSWORD'] ?? 'DemoPassw0rd';
const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'samples');

interface Json {
  [key: string]: unknown;
}

async function call(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; data: Json }> {
  const response = await fetch(`${API_URL}${route}`, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as Json;
  return { status: response.status, data };
}

async function authenticate(): Promise<string> {
  const registered = await call('POST', '/auth/register', { email: EMAIL, password: PASSWORD, name: 'Demo User' });
  if (registered.status !== 201 && registered.status !== 409) {
    throw new Error(`register failed (${registered.status}): ${JSON.stringify(registered.data).slice(0, 200)}`);
  }
  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  const token = (login.data['tokens'] as Json | undefined)?.['accessToken'] ?? login.data['accessToken'];
  if (login.status !== 200 || typeof token !== 'string') {
    throw new Error(`login failed (${login.status}): the demo user may exist with another password`);
  }
  return token;
}

async function waitForEmbeddings(documentId: string, token: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { data } = await call('GET', `/jobs/documents/${documentId}`, undefined, token);
    const state = (data['jobStatus'] as Json | undefined)?.['status'];
    if (state === 'completed' || state === 'failed') return String(state);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 'timeout (is the worker running?)';
}

async function main(): Promise<void> {
  const token = await authenticate();
  console.log(`Signed in as ${EMAIL}`);

  const existing = await call('GET', '/documents', undefined, token);
  const titles = new Set(
    ((existing.data['documents'] as Json[] | undefined) ?? []).map((d) => String(d['title']))
  );

  for (const file of fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.txt')).sort()) {
    const title = file
      .replace(/\.txt$/, '')
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    if (titles.has(title)) {
      console.log(`  skip   ${title} (already uploaded)`);
      continue;
    }
    const content = fs.readFileSync(path.join(SAMPLES_DIR, file), 'utf8');
    const created = await call('POST', '/documents', { title, content }, token);
    const id = (created.data['document'] as Json | undefined)?.['id'];
    if (created.status !== 201 || typeof id !== 'string') {
      throw new Error(`upload of ${file} failed (${created.status}): ${JSON.stringify(created.data).slice(0, 200)}`);
    }
    const state = await waitForEmbeddings(id, token);
    console.log(`  upload ${title}: embeddings ${state}`);
  }

  console.log(`\nDone. Open the app and sign in with ${EMAIL} / ${PASSWORD}`);
  console.log('Try: "How many days of remote work are allowed?"  |  "What caused the checkout outage?"');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

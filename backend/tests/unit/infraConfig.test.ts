import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { buildPgSsl } from '../../src/config/database.js';

const prod = { NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40) };

describe('database TLS', () => {
  it('verifies the server certificate in production by default', () => {
    expect(buildPgSsl(loadConfig({ ...prod }))).toEqual({ rejectUnauthorized: true });
  });

  it('is off outside production by default, so local Postgres works without certificates', () => {
    expect(buildPgSsl(loadConfig({}))).toBe(false);
  });

  it('trusts the given CA bundle (the RDS bundle shipped in the image) when verifying', () => {
    const file = path.join(os.tmpdir(), `ca-${Date.now()}.pem`);
    fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    try {
      const ssl = buildPgSsl(loadConfig({ ...prod, DB_SSL_CA_FILE: file }));
      expect(ssl).toMatchObject({ rejectUnauthorized: true });
      expect((ssl as { ca: string }).ca).toContain('BEGIN CERTIFICATE');
    } finally {
      fs.rmSync(file);
    }
  });

  it('fails closed when the CA file is missing, instead of silently skipping verification', () => {
    expect(() => buildPgSsl(loadConfig({ ...prod, DB_SSL_CA_FILE: '/nonexistent/ca.pem' }))).toThrow();
  });

  it('supports an explicit mode: disable, verify, and no-verify (encrypted but unchecked)', () => {
    expect(buildPgSsl(loadConfig({ ...prod, DB_SSL: 'disable' }))).toBe(false);
    expect(buildPgSsl(loadConfig({ DB_SSL: 'verify' }))).toEqual({ rejectUnauthorized: true });
    expect(buildPgSsl(loadConfig({ DB_SSL: 'no-verify' }))).toEqual({ rejectUnauthorized: false });
  });

  it('rejects an unknown mode', () => {
    expect(() => loadConfig({ DB_SSL: 'sometimes' })).toThrow();
  });
});

describe('Redis connection settings', () => {
  it('has TLS off by default and on when asked', () => {
    expect(loadConfig({}).redisTls).toBe(false);
    expect(loadConfig({ REDIS_TLS: 'true' }).redisTls).toBe(true);
  });

  it('carries the password, which the shared client previously ignored', () => {
    expect(loadConfig({ REDIS_PASSWORD: 'hunter2' }).redisPassword).toBe('hunter2');
  });
});

describe('shutdown and proxy settings', () => {
  it('gives in-flight requests 25 seconds by default and accepts an override', () => {
    expect(loadConfig({}).shutdownGraceMs).toBe(25000);
    expect(loadConfig({ SHUTDOWN_GRACE_MS: '5000' }).shutdownGraceMs).toBe(5000);
  });

  it('trusts no proxy by default (a spoofed X-Forwarded-For must not choose the rate-limit key)', () => {
    expect(loadConfig({}).trustProxy).toBe(0);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });
});

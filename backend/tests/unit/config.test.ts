import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const prodSecrets = {
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

describe('config', () => {
  it('parses "false" as false (z.coerce.boolean would return true)', () => {
    expect(loadConfig({ INJECTION_DETECTION: 'false' }).injectionDetection).toBe(false);
    expect(loadConfig({ INJECTION_DETECTION: '0' }).injectionDetection).toBe(false);
    expect(loadConfig({ INJECTION_DETECTION: 'true' }).injectionDetection).toBe(true);
    expect(loadConfig({}).injectionDetection).toBe(true);
  });

  it('rejects an ambiguous boolean instead of guessing', () => {
    expect(() => loadConfig({ INJECTION_DETECTION: 'maybe' })).toThrow();
  });

  it('defaults to the mock provider so the app runs without API keys', () => {
    expect(loadConfig({}).aiProvider).toBe('mock');
  });

  it('refuses to start in production on the built-in dev secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/must be set explicitly/);
  });

  it('refuses identical access and refresh secrets in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: prodSecrets.JWT_SECRET, JWT_REFRESH_SECRET: prodSecrets.JWT_SECRET })
    ).toThrow(/different/);
  });

  it('accepts explicit distinct secrets in production', () => {
    expect(loadConfig({ NODE_ENV: 'production', ...prodSecrets }).nodeEnv).toBe('production');
  });
});

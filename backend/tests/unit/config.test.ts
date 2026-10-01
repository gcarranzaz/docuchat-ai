import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const prodSecrets = {
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

describe('config', () => {
  it('parses "false" as false (z.coerce.boolean would return true)', () => {
    expect(loadConfig({ USE_STRUCTURED_OUTPUT: 'false' }).useStructuredOutput).toBe(false);
    expect(loadConfig({ USE_STRUCTURED_OUTPUT: '0' }).useStructuredOutput).toBe(false);
    expect(loadConfig({ USE_STRUCTURED_OUTPUT: 'true' }).useStructuredOutput).toBe(true);
    expect(loadConfig({}).useStructuredOutput).toBe(true);
  });

  it('rejects an ambiguous boolean instead of guessing', () => {
    expect(() => loadConfig({ USE_STRUCTURED_OUTPUT: 'maybe' })).toThrow();
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

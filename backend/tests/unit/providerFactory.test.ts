import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { buildProviders } from '../../src/ai/providers/providerFactory.js';

const prod = { NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40) };

describe('config: provider settings', () => {
  it('defaults to mock, no fallback, auto embeddings', () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({ aiProvider: 'mock', aiFallbackProvider: 'none', embeddingProvider: 'auto' });
  });

  it('refuses mock as a fallback: it would return fake answers as real ones', () => {
    expect(() => loadConfig({ AI_FALLBACK_PROVIDER: 'mock' })).toThrow();
  });

  it('exposes retry and timeout settings with safe defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.aiMaxRetries).toBe(2);
    expect(cfg.aiTimeoutMs).toBe(30000);
  });
});

describe('buildProviders', () => {
  it('runs everything on the mock with no keys', () => {
    const { chat, embedding } = buildProviders(loadConfig({}));
    expect(chat.name).toBe('mock');
    expect(embedding.name).toBe('mock');
  });

  it('builds a real Anthropic provider for AI_PROVIDER=anthropic', () => {
    const { chat } = buildProviders(
      loadConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x' })
    );
    expect(chat.name).toBe('anthropic');
    expect(chat.isConfigured()).toBe(true);
  });

  it('keeps embeddings on OpenAI when completions use Anthropic and an OpenAI key exists', () => {
    const { embedding } = buildProviders(
      loadConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x' })
    );
    expect(embedding.name).toBe('openai');
  });

  it('can set the embedding provider explicitly', () => {
    const { embedding } = buildProviders(loadConfig({ AI_PROVIDER: 'mock', EMBEDDING_PROVIDER: 'mock' }));
    expect(embedding.name).toBe('mock');
  });

  it('outside production a missing key degrades to the mock instead of crashing', () => {
    const { chat } = buildProviders(loadConfig({ AI_PROVIDER: 'openai' }));
    expect(chat.name).toBe('mock');
  });

  it('in production a missing key for the requested provider fails fast', () => {
    expect(() => buildProviders(loadConfig({ ...prod, AI_PROVIDER: 'openai' }))).toThrow(/OPENAI_API_KEY/);
    expect(() => buildProviders(loadConfig({ ...prod, AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-x' }))).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('in production anthropic completions need a real embedding provider, not a silent mock', () => {
    expect(() => buildProviders(loadConfig({ ...prod, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' }))).toThrow(/embedding/i);
  });

  it('in production the fallback provider must be configured too', () => {
    expect(() =>
      buildProviders(
        loadConfig({ ...prod, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x', AI_FALLBACK_PROVIDER: 'anthropic' })
      )
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('refuses a fallback identical to the primary', () => {
    expect(() =>
      buildProviders(loadConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x', AI_FALLBACK_PROVIDER: 'openai' }))
    ).toThrow(/same/i);
  });
});

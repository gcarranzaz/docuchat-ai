import { describe, it, expect, vi } from 'vitest';
import { RedactingProvider } from '../../src/ai/providers/redacting.provider.js';
import { buildProviders } from '../../src/ai/providers/providerFactory.js';
import { loadConfig } from '../../src/config/index.js';
import type { LlmProvider } from '../../src/ai/providers/llmProvider.interface.js';

const done = { content: 'ok', inputTokens: 1, outputTokens: 1, model: 'm' };

function inner() {
  return {
    name: 'inner',
    isConfigured: () => true,
    embed: vi.fn().mockResolvedValue({ embedding: [0], tokenCount: 1 }),
    embedBatch: vi.fn().mockResolvedValue([{ embedding: [0], tokenCount: 1 }]),
    complete: vi.fn().mockResolvedValue(done),
    stream: vi.fn().mockResolvedValue(done),
  } satisfies LlmProvider;
}

const NONCE = '4111111111111111'; // looks like a card number on purpose
const PROMPT = `<<<BEGIN_CONTEXT_${NONCE}>>>\nWrite to ana@example.com or call 555-123-4567.\n<<<END_CONTEXT_${NONCE}>>>`;

describe('RedactingProvider', () => {
  it('masks personal data in the user prompt of complete() and stream()', async () => {
    const target = inner();
    const provider = new RedactingProvider(target);

    await provider.complete({ systemPrompt: 'sys', userPrompt: PROMPT });
    await provider.stream({ systemPrompt: 'sys', userPrompt: PROMPT }, { onToken: () => undefined });

    for (const call of [target.complete.mock.calls[0]![0], target.stream.mock.calls[0]![0]]) {
      expect(call.userPrompt).toContain('[EMAIL]');
      expect(call.userPrompt).toContain('[PHONE]');
      expect(call.userPrompt).not.toContain('ana@example.com');
      expect(call.userPrompt).not.toContain('555-123-4567');
    }
  });

  it('keeps the prompt delimiters intact so the model can still tell data from instructions', async () => {
    const target = inner();
    await new RedactingProvider(target).complete({ systemPrompt: 'sys', userPrompt: PROMPT });
    const sent = target.complete.mock.calls[0]![0].userPrompt;
    expect(sent).toContain(`<<<BEGIN_CONTEXT_${NONCE}>>>`);
    expect(sent).toContain(`<<<END_CONTEXT_${NONCE}>>>`);
  });

  it('leaves the system prompt and the other parameters alone', async () => {
    const target = inner();
    await new RedactingProvider(target).complete({ systemPrompt: 'mail a@b.com is an example in our rules', userPrompt: 'hi', maxTokens: 50, jsonMode: true });
    expect(target.complete.mock.calls[0]![0]).toMatchObject({
      systemPrompt: 'mail a@b.com is an example in our rules',
      maxTokens: 50,
      jsonMode: true,
    });
  });

  it('masks the text that is embedded (documents and questions), single and batch', async () => {
    const target = inner();
    const provider = new RedactingProvider(target);
    await provider.embed('contact ana@example.com');
    await provider.embedBatch(['call 555-123-4567', 'nothing personal here']);

    expect(target.embed.mock.calls[0]![0]).toBe('contact [EMAIL]');
    expect(target.embedBatch.mock.calls[0]![0]).toEqual(['call [PHONE]', 'nothing personal here']);
  });

  it('returns the provider results untouched and reports the inner name', async () => {
    const provider = new RedactingProvider(inner());
    expect(await provider.complete({ systemPrompt: 's', userPrompt: 'u' })).toEqual(done);
    expect(provider.name).toBe('inner');
    expect(provider.isConfigured()).toBe(true);
  });

  it('does not alter text that has no personal data', async () => {
    const target = inner();
    await new RedactingProvider(target).complete({ systemPrompt: 's', userPrompt: 'Q3 revenue grew 20 percent, due 2024-01-15.' });
    expect(target.complete.mock.calls[0]![0].userPrompt).toBe('Q3 revenue grew 20 percent, due 2024-01-15.');
  });
});

describe('REDACT_PII_BEFORE_LLM', () => {
  it('is off by default', () => {
    expect(loadConfig({}).redactPiiBeforeLlm).toBe(false);
  });

  it('wraps both the chat and the embedding provider when on, and neither when off', () => {
    const on = buildProviders(loadConfig({ REDACT_PII_BEFORE_LLM: 'true' }));
    expect(on.chat).toBeInstanceOf(RedactingProvider);
    expect(on.embedding).toBeInstanceOf(RedactingProvider);

    const off = buildProviders(loadConfig({}));
    expect(off.chat).not.toBeInstanceOf(RedactingProvider);
    expect(off.embedding).not.toBeInstanceOf(RedactingProvider);
  });
});

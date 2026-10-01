import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { getPrompt, activePrompt, assertPromptConfig, listPromptVersions } from '../../src/ai/prompts/registry.js';

describe('prompt registry', () => {
  it('returns a template by name and version', () => {
    const prompt = getPrompt('chat_rag', 'v3.0');
    expect(prompt).toMatchObject({ name: 'chat_rag', version: 'v3.0' });
    expect(prompt.system).toContain('{{nonce}}');
  });

  it('rejects an unknown version instead of silently using another', () => {
    expect(() => getPrompt('chat_rag', 'v99')).toThrow(/chat_rag.*v99/);
  });

  it('lists the versions of each prompt', () => {
    expect(listPromptVersions('chat_rag')).toContain('v3.0');
    expect(listPromptVersions('extract_json')).toContain('v2.0');
    expect(listPromptVersions('document_summary')).toContain('v1.0');
  });

  it('selects the active version from configuration', () => {
    const cfg = loadConfig({});
    expect(activePrompt('chat_rag', cfg).version).toBe(cfg.promptVersionChat);
    expect(activePrompt('extract_json', cfg).version).toBe(cfg.promptVersionExtract);
  });

  it('fails startup validation when a configured version does not exist', () => {
    expect(() => assertPromptConfig(loadConfig({ PROMPT_VERSION_CHAT: 'v0.1' }))).toThrow(/PROMPT_VERSION_CHAT/);
    expect(() => assertPromptConfig(loadConfig({ PROMPT_VERSION_EXTRACT: 'nope' }))).toThrow(/PROMPT_VERSION_EXTRACT/);
  });

  it('passes validation for the defaults', () => {
    expect(() => assertPromptConfig(loadConfig({}))).not.toThrow();
  });

  it('only retired templates are gone: every registered template is complete', () => {
    for (const name of ['chat_rag', 'extract_json', 'document_summary'] as const) {
      for (const version of listPromptVersions(name)) {
        const prompt = getPrompt(name, version);
        expect(prompt.system.length).toBeGreaterThan(20);
        expect(prompt.user.length).toBeGreaterThan(10);
      }
    }
  });
});

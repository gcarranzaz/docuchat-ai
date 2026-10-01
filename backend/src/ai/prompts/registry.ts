/**
 * Prompt registry
 * ===============
 * Single place that knows which prompt versions exist and which one is active.
 * Asking for a version that does not exist is an error, never a silent fallback:
 * answers are stored with their prompt version, so it has to be exact.
 */

import { CHAT_RAG_V3, EXTRACT_JSON_V2, DOCUMENT_SUMMARY_V1, type PromptTemplate } from './templates.js';
import type { Config } from '../../config/index.js';

export type PromptName = 'chat_rag' | 'extract_json' | 'document_summary';

const TEMPLATES: PromptTemplate[] = [CHAT_RAG_V3, EXTRACT_JSON_V2, DOCUMENT_SUMMARY_V1];

/** Version used for prompts that are not selectable through configuration */
const FIXED_VERSION: Partial<Record<PromptName, string>> = {
  document_summary: DOCUMENT_SUMMARY_V1.version,
};

type PromptConfig = Pick<Config, 'promptVersionChat' | 'promptVersionExtract'>;

export function listPromptVersions(name: PromptName): string[] {
  return TEMPLATES.filter((t) => t.name === name).map((t) => t.version);
}

export function getPrompt(name: PromptName, version: string): PromptTemplate {
  const template = TEMPLATES.find((t) => t.name === name && t.version === version);
  if (!template) {
    throw new Error(`Unknown prompt version: ${name}@${version}. Available: ${listPromptVersions(name).join(', ') || 'none'}`);
  }
  return template;
}

/** The version selected by configuration (or fixed) for a prompt */
export function activePrompt(name: PromptName, cfg: PromptConfig): PromptTemplate {
  const version =
    name === 'chat_rag' ? cfg.promptVersionChat : name === 'extract_json' ? cfg.promptVersionExtract : FIXED_VERSION[name];
  return getPrompt(name, version as string);
}

/** Fail at startup if configuration points at a prompt version that does not exist */
export function assertPromptConfig(cfg: PromptConfig): void {
  const checks: Array<[string, PromptName, string]> = [
    ['PROMPT_VERSION_CHAT', 'chat_rag', cfg.promptVersionChat],
    ['PROMPT_VERSION_EXTRACT', 'extract_json', cfg.promptVersionExtract],
  ];
  for (const [setting, name, version] of checks) {
    if (!listPromptVersions(name).includes(version)) {
      throw new Error(`${setting}=${version} does not exist. Available for ${name}: ${listPromptVersions(name).join(', ')}`);
    }
  }
}

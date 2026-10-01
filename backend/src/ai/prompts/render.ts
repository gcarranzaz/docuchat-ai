/**
 * Prompt rendering helpers
 * ========================
 * Small and strict on purpose: prompts are built from untrusted text, so the
 * way values are substituted matters.
 */

import { randomBytes } from 'node:crypto';

/**
 * Substitute `{{name}}` placeholders in a single pass.
 *
 * - Uses a replacer function, so `$&`, `$1`, `$$` etc. inside documents are kept
 *   verbatim (a plain string replacement would interpret them and corrupt the prompt).
 * - Single pass: placeholders that appear inside substituted values are NOT expanded.
 * - A placeholder with no value throws: shipping a literal "{{x}}" to the model is a bug.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new Error(`Missing prompt variable: ${key}`);
    }
    return value;
  });
}

/** Unpredictable per-request code that makes our delimiters impossible to forge */
export function newNonce(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Wrap untrusted text in delimiters that carry the request's nonce.
 * The system prompt names the exact delimiters, so text that merely looks like a
 * delimiter ("END_CONTEXT", or a tag with another code) stays inside the data.
 * If the content somehow contains the nonce itself, it is removed.
 */
export function wrapUntrusted(label: string, nonce: string, content: string): string {
  const safe = content.split(nonce).join('');
  return `<<<BEGIN_${label}_${nonce}>>>\n${safe}\n<<<END_${label}_${nonce}>>>`;
}

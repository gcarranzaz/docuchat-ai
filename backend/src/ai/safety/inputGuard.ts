/**
 * Input guard
 * ===========
 * Cleans and bounds user text before it reaches a prompt, and flags text that
 * looks like a prompt-injection attempt.
 *
 * What this is and is not:
 * - Normalisation and limits are deterministic and always applied.
 * - The detector is a heuristic: it FLAGS, it never rewrites or blocks. It feeds
 *   logs and usage metadata so attempts can be counted and reviewed. A
 *   determined attacker can phrase around any pattern list, which is why the real
 *   protection is structural (nonce delimiters, schema-validated output, a model
 *   with no side-effecting tools). See docs/SECURITY.md.
 */

export class InputRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputRejectedError';
  }
}

export interface InjectionResult {
  flagged: boolean;
  signals: string[];
}

export interface PreparedQuestion {
  text: string;
  injection: InjectionResult;
}

// Zero-width characters, bidi overrides/isolates and the BOM: used to hide or reorder text
// eslint-disable-next-line no-irregular-whitespace -- the chars being matched are the point
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// C0/C1 control characters except tab (\u0009) and newline (\u000A)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Unicode-normalise and strip characters that exist to hide or smuggle text */
export function normalizeInput(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ===========================================
// Injection heuristics
// ===========================================

const SIGNAL_PATTERNS: Array<[string, RegExp]> = [
  [
    'override_instructions',
    /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,40}\b(instructions?|rules?|prompts?|guidelines?|directions?)\b/,
  ],
  [
    'reveal_prompt',
    /\b(reveal|show|print|repeat|output|leak|display|tell me)\b[^.\n]{0,40}\b(system|hidden|initial|original|secret)\b[^.\n]{0,20}\b(prompt|instructions?|message|rules?)\b/,
  ],
  ['role_override', /\b(you are now|from now on,? you|pretend (to be|you are)|developer mode|jailbreak|dan mode)\b/],
  [
    'delimiter_forgery',
    /(<<<|>>>|\b(begin|end)_(context|document|question|history|title)\b|<\/?(system|assistant|context|instructions?)>|\[\/?inst\])/,
  ],
  ['chat_role_markup', /^\s*(system|assistant)\s*:/m],
];

export function detectInjection(text: string): InjectionResult {
  const haystack = normalizeInput(text).toLowerCase();
  const signals = SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(haystack)).map(([name]) => name);
  return { flagged: signals.length > 0, signals };
}

// ===========================================
// Question preparation
// ===========================================

export interface PrepareQuestionOptions {
  maxChars: number;
  detect: boolean;
}

/**
 * Normalise a question, enforce the length limit (measured after normalisation,
 * so invisible padding does not count) and run the detector.
 * Throws InputRejectedError for empty or oversized input.
 */
export function prepareQuestion(raw: string, options: PrepareQuestionOptions): PreparedQuestion {
  const text = normalizeInput(raw);

  if (text.length === 0) {
    throw new InputRejectedError('Question cannot be empty');
  }
  if (text.length > options.maxChars) {
    throw new InputRejectedError(`Question is too long (maximum ${options.maxChars} characters)`);
  }

  return {
    text,
    injection: options.detect ? detectInjection(text) : { flagged: false, signals: [] },
  };
}

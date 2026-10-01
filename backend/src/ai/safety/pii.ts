/**
 * PII redaction
 * =============
 * Masks personal data in text before it leaves the system (to an AI provider, see
 * RedactingProvider) or lands in logs/audit metadata.
 *
 * Pattern-based, so it is a best-effort filter and not a guarantee:
 * - It finds structured identifiers: emails, phone numbers, card numbers, national ids,
 *   IBANs, IP addresses. It does NOT find names, addresses or free-text facts.
 * - Candidates that have a checksum are validated (card numbers by Luhn, IBANs by
 *   mod-97), so an ordinary long number is not mistaken for one.
 * - Precision matters as much as recall: every false positive removes information the model
 *   needed. The patterns are deliberately conservative (see pii.test.ts for what must NOT match).
 *
 * Returns counts by kind, never the values.
 */

export type PiiKind = 'EMAIL' | 'PHONE' | 'ID' | 'IBAN' | 'CARD' | 'IP';

export interface RedactionResult {
  text: string;
  counts: Partial<Record<PiiKind, number>>;
}

/** Luhn checksum over a string of digits (card numbers) */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** IBAN checksum (ISO 13616, mod 97) */
function ibanValid(iban: string): boolean {
  const compact = iban.replace(/\s/g, '').toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

interface Rule {
  kind: PiiKind;
  pattern: RegExp;
  /** Decide from the match whether it really is personal data */
  accept?: (match: string) => boolean;
  /** Replace only a part of the match (keep a keyword that gives context) */
  replace?: (match: string, token: string) => string;
}

const digitsOf = (value: string) => value.replace(/\D/g, '');

// Order matters: the more specific patterns run first so a number is claimed once
const RULES: Rule[] = [
  { kind: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  {
    kind: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    accept: ibanValid,
  },
  {
    kind: 'CARD',
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (match) => luhnValid(digitsOf(match)),
  },
  // Argentine CUIT/CUIL: 20-30123456-7
  { kind: 'ID', pattern: /\b\d{2}-\d{8}-\d\b/g },
  // US social security number: 123-45-6789
  { kind: 'ID', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    // Argentine DNI. Written like a thousands-separated amount (30.123.456), so only
    // accepted next to its keyword; otherwise "12.345.678 pesos" would be redacted.
    kind: 'ID',
    pattern: /\b(?:DNI|D\.N\.I\.?|documento)\b[^\d\n]{0,12}\d{1,2}\.?\d{3}\.?\d{3}\b/gi,
    replace: (match, token) => match.replace(/\d{1,2}\.?\d{3}\.?\d{3}$/, token),
  },
  {
    kind: 'IP',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    // Last, because it is the loosest: separated groups of digits, 9 to 15 digits in total,
    // and not a date (2024-01-15 has 8 digits and is rejected by the length rule too).
    kind: 'PHONE',
    pattern: /(?<![\w@.])\+?\(?\d{1,4}\)?(?:[\s.-]\(?\d{1,4}\)?){2,5}(?![\w])/g,
    accept: (match) => {
      const digits = digitsOf(match).length;
      return digits >= 9 && digits <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(match.trim());
    },
  },
];

const TOKEN: Record<PiiKind, string> = {
  EMAIL: '[EMAIL]',
  PHONE: '[PHONE]',
  ID: '[ID]',
  IBAN: '[IBAN]',
  CARD: '[CARD]',
  IP: '[IP]',
};

export function redactPii(text: string): RedactionResult {
  const counts: RedactionResult['counts'] = {};
  let result = text;

  for (const rule of RULES) {
    result = result.replace(rule.pattern, (match) => {
      if (rule.accept && !rule.accept(match)) return match;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      return rule.replace ? rule.replace(match, TOKEN[rule.kind]) : TOKEN[rule.kind];
    });
  }

  return { text: result, counts };
}

// The prompt delimiters carry a random code (see ai/prompts/render.ts). If that code happened to
// look like a card number it would be rewritten and the delimiters would stop matching.
const DELIMITER = /(<<<(?:BEGIN|END)_[A-Z]+_[0-9a-f]+>>>)/;

/** Redact a prompt (everything except the delimiter tags themselves), with counts by kind */
export function redactPromptWithCounts(text: string): RedactionResult {
  const counts: RedactionResult['counts'] = {};
  const parts = text.split(DELIMITER).map((part, index) => {
    if (index % 2 === 1) return part;
    const result = redactPii(part);
    for (const [kind, n] of Object.entries(result.counts)) {
      counts[kind as PiiKind] = (counts[kind as PiiKind] ?? 0) + (n ?? 0);
    }
    return result.text;
  });
  return { text: parts.join(''), counts };
}

/** Same, returning only the text */
export function redactPreservingDelimiters(text: string): string {
  return redactPromptWithCounts(text).text;
}

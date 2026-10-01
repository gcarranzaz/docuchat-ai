import { describe, it, expect } from 'vitest';
import { redactPii, redactPreservingDelimiters, luhnValid } from '../../src/ai/safety/pii.js';

const redact = (text: string) => redactPii(text).text;

describe('redactPii: what it removes', () => {
  it.each([
    ['an email address', 'Write to ana.perez+work@example.co.uk about it', 'Write to [EMAIL] about it'],
    ['two emails', 'a@b.com and c@d.org', '[EMAIL] and [EMAIL]'],
    ['a US phone number', 'Call 555-123-4567 today', 'Call [PHONE] today'],
    ['an international phone number', 'Phone: +54 9 11 1234-5678.', 'Phone: [PHONE].'],
    ['a phone with parentheses', 'Reach me at (415) 555-0132', 'Reach me at [PHONE]'],
    ['a US social security number', 'SSN 123-45-6789 on file', 'SSN [ID] on file'],
    ['an Argentine DNI', 'DNI 30.123.456', 'DNI [ID]'],
    ['an Argentine CUIT', 'CUIT 20-30123456-7', 'CUIT [ID]'],
    ['an IBAN', 'IBAN GB82 WEST 1234 5698 7654 32', 'IBAN [IBAN]'],
    ['a valid card number', 'Card 4111 1111 1111 1111 expires soon', 'Card [CARD] expires soon'],
    ['a card number with dashes', 'Card 5500-0000-0000-0004.', 'Card [CARD].'],
    ['an IPv4 address', 'Login from 192.168.10.25 failed', 'Login from [IP] failed'],
  ])('redacts %s', (_label, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('counts what it found, by kind, without returning the values', () => {
    const result = redactPii('a@b.com, c@d.com, 555-123-4567');
    expect(result.counts).toEqual({ EMAIL: 2, PHONE: 1 });
    expect(JSON.stringify(result)).not.toContain('a@b.com');
  });

  it('is applied to every occurrence and keeps the surrounding text', () => {
    expect(redact('First a@b.com then a@b.com again')).toBe('First [EMAIL] then [EMAIL] again');
  });
});

describe('redactPii: what it leaves alone (false positives hurt answers)', () => {
  it.each([
    'Q3 revenue grew 20 percent compared with Q2.',
    'Headcount stayed flat at 120 people.',
    'The invoice total is 1,234.56 USD, due 2024-01-15.',
    'Version 3.2.1 was released on 2026-10-01.',
    'Order 1234567 shipped in 3 days.',
    'Contract number 2024-0099 renewed for 24 months.',
    'The ratio was 0.75 and the margin 18.5%.',
    'See pages 12-14 and section 4.2.1.',
    'A card-like number that fails the Luhn check: 4111 1111 1111 1112.',
    'Meet at 10:30 on 12/05/2025.',
    'Revenue of 1 234 567 EUR.',
  ])('does not touch: %s', (text) => {
    expect(redact(text)).toBe(text);
  });

  it('leaves ordinary words that merely look technical', () => {
    expect(redact('Use user@localhost? No: that is not an email')).toContain('user@localhost');
  });
});

describe('luhnValid', () => {
  it('accepts real test card numbers and rejects others', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('5500000000000004')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234567890123456')).toBe(false);
  });
});

describe('redactPreservingDelimiters', () => {
  const NONCE = '4111111111111111'; // a nonce that happens to look like a card number

  it('never alters the prompt delimiters, even if their random code looks like personal data', () => {
    const text = `<<<BEGIN_CONTEXT_${NONCE}>>>\nmail a@b.com\n<<<END_CONTEXT_${NONCE}>>>`;
    const result = redactPreservingDelimiters(text);
    expect(result).toContain(`<<<BEGIN_CONTEXT_${NONCE}>>>`);
    expect(result).toContain(`<<<END_CONTEXT_${NONCE}>>>`);
    expect(result).toContain('mail [EMAIL]');
  });

  it('redacts text outside and inside the delimited blocks', () => {
    const result = redactPreservingDelimiters('outside 555-123-4567 <<<BEGIN_X_abcd1234abcd1234>>>inside b@c.com<<<END_X_abcd1234abcd1234>>>');
    expect(result).toBe('outside [PHONE] <<<BEGIN_X_abcd1234abcd1234>>>inside [EMAIL]<<<END_X_abcd1234abcd1234>>>');
  });
});

import { describe, it, expect } from 'vitest';
import { sanitizeMetadata, pseudonymize } from '../../src/services/audit.service.js';

describe('sanitizeMetadata', () => {
  it('keeps numbers, booleans, codes and ids as they are', () => {
    const meta = { model: 'claude-test', promptVersion: 'chat_rag:v3.0', inputTokens: 120, cached: false, signals: ['reveal_prompt'] };
    expect(sanitizeMetadata(meta)).toEqual(meta);
  });

  it('redacts personal data that slipped into a string value', () => {
    expect(sanitizeMetadata({ note: 'user ana@example.com called 555-123-4567' })).toEqual({ note: 'user [EMAIL] called [PHONE]' });
  });

  it('caps long strings, so message text cannot be stored by accident', () => {
    const out = sanitizeMetadata({ text: 'x'.repeat(5000) }) as { text: string };
    expect(out.text.length).toBeLessThanOrEqual(201);
    expect(out.text.endsWith('…')).toBe(true);
  });

  it('handles nested values and long arrays', () => {
    const out = sanitizeMetadata({ a: { b: { c: 'mail a@b.com' } }, list: Array.from({ length: 50 }, (_, i) => i) }) as any;
    expect(out.a.b.c).toBe('mail [EMAIL]');
    expect(out.list).toHaveLength(20);
  });

  it('stops descending into very deep structures', () => {
    const deep = { a: { b: { c: { d: { e: 'x' } } } } };
    expect(JSON.stringify(sanitizeMetadata(deep))).toContain('[truncated]');
  });
});

describe('pseudonymize', () => {
  it('gives the same short reference for the same address, whatever its case or spacing', () => {
    expect(pseudonymize('Ana@Example.com')).toBe(pseudonymize('  ana@example.com '));
  });

  it('differs between addresses and does not contain the address', () => {
    const a = pseudonymize('ana@example.com');
    expect(a).not.toBe(pseudonymize('bob@example.com'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('ana');
  });
});

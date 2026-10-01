import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateCost, priceFor, parsePricingOverride, resetPricingWarnings, DEFAULT_PRICES } from '../../src/ai/pricing.js';

const noOverride = { overrides: {}, fallback: { input: 10, output: 30 } };

beforeEach(resetPricingWarnings);

describe('pricing', () => {
  it('computes cost from per-million-token prices', () => {
    // gpt-3.5-turbo: $0.5 in / $1.5 out per 1M tokens
    expect(calculateCost('gpt-3.5-turbo', 1_000_000, 1_000_000, noOverride)).toBeCloseTo(2.0, 6);
    expect(calculateCost('gpt-3.5-turbo', 2000, 500, noOverride)).toBeCloseTo(0.00175, 6);
  });

  it('charges nothing for the mock provider', () => {
    expect(calculateCost('mock', 10_000, 10_000, noOverride)).toBe(0);
  });

  it('never prices an unknown model at zero: it uses the conservative fallback', () => {
    const warn = vi.fn();
    const cost = calculateCost('brand-new-model', 1_000_000, 1_000_000, { ...noOverride, warn });
    expect(cost).toBeCloseTo(40, 6); // 10 in + 30 out
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per unknown model, not on every call', () => {
    const warn = vi.fn();
    for (let i = 0; i < 5; i++) calculateCost('another-new-model', 100, 100, { ...noOverride, warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('lets configuration override or add prices', () => {
    const overrides = { 'my-model': { input: 1, output: 2 }, 'gpt-4': { input: 1, output: 1 } };
    expect(calculateCost('my-model', 1_000_000, 1_000_000, { ...noOverride, overrides })).toBeCloseTo(3, 6);
    expect(priceFor('gpt-4', { ...noOverride, overrides }).price).toEqual({ input: 1, output: 1 });
  });

  it('knows the built-in prices are a snapshot, not a promise', () => {
    expect(Object.keys(DEFAULT_PRICES)).toContain('text-embedding-3-small');
  });
});

describe('parsePricingOverride', () => {
  it('parses a JSON object of prices', () => {
    expect(parsePricingOverride('{"m":{"input":1.5,"output":4}}')).toEqual({ m: { input: 1.5, output: 4 } });
  });

  it('returns an empty table when unset or blank', () => {
    expect(parsePricingOverride(undefined)).toEqual({});
    expect(parsePricingOverride('  ')).toEqual({});
  });

  it.each([
    ['not json', '{oops'],
    ['wrong shape', '{"m":{"input":"1"}}'],
    ['negative price', '{"m":{"input":-1,"output":1}}'],
    ['array', '[1,2]'],
  ])('rejects %s so a typo cannot silently zero the costs', (_label, json) => {
    expect(() => parsePricingOverride(json)).toThrow(/MODEL_PRICING_JSON/);
  });
});

/**
 * Model pricing
 * =============
 * Cost estimates feed the per-user budget and the usage log, so a wrong price
 * means a wrong cap. Two rules:
 *
 * - Prices are configuration: MODEL_PRICING_JSON overrides or extends the built-in
 *   table (USD per 1M tokens). The built-in table is a dated snapshot, not a promise;
 *   always set real prices from the provider's price page for the models you run.
 * - An unknown model is NEVER priced at zero. It uses a conservative fallback and
 *   logs one warning, so a new model cannot slip past the budget for free.
 */

import { z } from 'zod';
import { getConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

/** Snapshot of public list prices at the time of writing; override with MODEL_PRICING_JSON */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo-preview': { input: 10.0, output: 30.0 }, // retired by OpenAI; kept for cost-history reference
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  // Anthropic (older models; set claude-sonnet-5-5 and others through MODEL_PRICING_JSON)
  'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
  'claude-3-sonnet-20240229': { input: 3.0, output: 15.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  // Local development
  mock: { input: 0, output: 0 },
};

const priceSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() });
const overrideSchema = z.record(priceSchema);

export function parsePricingOverride(json: string | undefined): Record<string, ModelPrice> {
  if (!json || json.trim() === '') return {};
  try {
    return overrideSchema.parse(JSON.parse(json));
  } catch (error) {
    throw new Error(
      `MODEL_PRICING_JSON must be a JSON object like {"model":{"input":3,"output":15}} with non-negative USD-per-1M-token prices (${(error as Error).message.slice(0, 120)})`
    );
  }
}

export interface PricingContext {
  overrides: Record<string, ModelPrice>;
  fallback: ModelPrice;
  warn?: (model: string) => void;
}

const warned = new Set<string>();

export function resetPricingWarnings(): void {
  warned.clear();
}

function defaultContext(): PricingContext {
  const cfg = getConfig();
  return {
    overrides: parsePricingOverride(cfg.modelPricingJson),
    fallback: { input: cfg.unknownModelPriceInput, output: cfg.unknownModelPriceOutput },
  };
}

export function priceFor(model: string, ctx: PricingContext = defaultContext()): { price: ModelPrice; known: boolean } {
  const price = ctx.overrides[model] ?? DEFAULT_PRICES[model];
  if (price) return { price, known: true };

  if (!warned.has(model)) {
    warned.add(model);
    (ctx.warn ?? ((m: string) => logger.warn({ model: m }, 'No price configured for model; using the conservative fallback. Set MODEL_PRICING_JSON.')))(model);
  }
  return { price: ctx.fallback, known: false };
}

/** Estimated cost in USD */
export function calculateCost(model: string, inputTokens: number, outputTokens: number, ctx?: PricingContext): number {
  const { price } = priceFor(model, ctx);
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

/**
 * LLM Provider Interface
 * ======================
 * Abstraction layer for different LLM providers.
 *
 * Why abstraction:
 * - Swap providers without changing business logic
 * - Easy testing with mock provider
 * - Cost optimization (use cheaper models for some tasks)
 * - Fallback support (if one provider fails)
 *
 * Implementations:
 * - OpenAIProvider: Production use with OpenAI API
 * - MockProvider: Testing without API calls
 * - (Future) AnthropicProvider: Alternative provider
 */

import type { EmbeddingResult, CompletionResult, LlmProviderConfig } from '../../types/index.js';

// ===========================================
// Provider Interface
// ===========================================

export interface LlmProvider {
  /** Provider name for logging */
  readonly name: string;

  /**
   * Generate embeddings for text
   * Used for: Document chunking, query embedding
   */
  embed(text: string): Promise<EmbeddingResult>;

  /**
   * Generate embeddings for multiple texts (batch)
   * More efficient than calling embed() multiple times
   */
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;

  /**
   * Generate completion from prompt
   * Used for: Chat, extraction
   */
  complete(params: CompletionParams): Promise<CompletionResult>;

  /**
   * Check if provider is configured and ready
   */
  isConfigured(): boolean;
}

// ===========================================
// Completion Parameters
// ===========================================

export interface CompletionParams {
  /** System prompt (instructions) */
  systemPrompt: string;

  /** User message/question */
  userPrompt: string;

  /** Maximum tokens in response */
  maxTokens?: number;

  /** Temperature (0-1, lower = more deterministic) */
  temperature?: number;

  /** Optional: Force JSON output */
  jsonMode?: boolean;

  /** Optional: Stop sequences */
  stopSequences?: string[];
}

// ===========================================
// Provider Factory Config
// ===========================================

export interface ProviderConfig {
  provider: 'openai' | 'anthropic' | 'mock';
  openai?: {
    apiKey: string;
    model: string;
    embeddingModel: string;
  };
  anthropic?: {
    apiKey: string;
    model: string;
  };
}

// ===========================================
// Cost Tracking
// ===========================================

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  model: string;
  operation: 'embed' | 'complete';
  estimatedCostUsd: number;
}

// ===========================================
// Model Pricing (as of 2024)
// ===========================================

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI (per 1M tokens)
  'gpt-4-turbo-preview': { input: 10.0, output: 30.0 },
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },

  // Anthropic (per 1M tokens)
  'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
  'claude-3-sonnet-20240229': { input: 3.0, output: 15.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },

  // Mock (free)
  'mock': { input: 0, output: 0 },
};

/**
 * Calculate estimated cost for an operation
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

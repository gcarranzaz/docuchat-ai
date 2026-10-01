/**
 * Provider Factory
 * ================
 * Builds the LLM providers from configuration. Two independent choices:
 *
 * - Chat provider (AI_PROVIDER): who writes answers and extractions.
 * - Embedding provider (EMBEDDING_PROVIDER): who turns text into vectors.
 *   Separate because Anthropic has no embeddings API, and because switching the
 *   embedding model means re-embedding every document.
 *
 * Both are wrapped in ResilientProvider (retry with backoff; optional fallback
 * for completions only).
 *
 * Misconfiguration policy:
 * - Production: a requested provider without its key fails at startup. Silently
 *   serving mock answers in production would be worse than not starting.
 * - Elsewhere: warn and degrade to the mock so the app runs with no keys.
 */

import type { LlmProvider } from './llmProvider.interface.js';
import { OpenAIProvider } from './openai.provider.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { MockProvider } from './mock.provider.js';
import { ResilientProvider } from './resilient.provider.js';
import { RedactingProvider } from './redacting.provider.js';
import type { RetryOptions } from './retry.js';
import { getConfig, type Config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

type RealProviderName = 'openai' | 'anthropic';
type ProviderName = RealProviderName | 'mock';

export interface Providers {
  chat: LlmProvider;
  embedding: LlmProvider;
}

// ===========================================
// Pure construction (testable with any Config)
// ===========================================

export function buildProviders(cfg: Config): Providers {
  const production = cfg.nodeEnv === 'production';
  const retry: RetryOptions = { maxRetries: cfg.aiMaxRetries, baseDelayMs: cfg.aiRetryBaseDelayMs };

  if (cfg.aiFallbackProvider !== 'none' && cfg.aiFallbackProvider === cfg.aiProvider) {
    throw new Error(`AI_FALLBACK_PROVIDER cannot be the same as AI_PROVIDER (${cfg.aiProvider})`);
  }

  // Chat provider -------------------------------------------------------------
  const chatName = resolveName(cfg.aiProvider, cfg, production, 'AI_PROVIDER');
  const fallbackName: ProviderName | null =
    cfg.aiFallbackProvider === 'none' ? null : resolveName(cfg.aiFallbackProvider, cfg, production, 'AI_FALLBACK_PROVIDER');

  const chat = new ResilientProvider(instantiate(chatName, cfg), {
    retry,
    ...(fallbackName && fallbackName !== 'mock' && { fallback: instantiate(fallbackName, cfg) }),
  });

  // Embedding provider --------------------------------------------------------
  const embeddingName = resolveEmbeddingName(cfg, production);
  const embedding = new ResilientProvider(instantiate(embeddingName, cfg), { retry });

  logger.info(
    { chat: chat.name, fallback: fallbackName ?? 'none', embedding: embedding.name },
    'LLM providers initialised'
  );

  // Outermost layer: personal data is masked before anything, retries and fallback included, sees it
  if (cfg.redactPiiBeforeLlm) {
    return { chat: new RedactingProvider(chat), embedding: new RedactingProvider(embedding) };
  }

  return { chat, embedding };
}

function hasKey(name: RealProviderName, cfg: Config): boolean {
  return Boolean(name === 'openai' ? cfg.openaiApiKey : cfg.anthropicApiKey);
}

function keyVar(name: RealProviderName): string {
  return name === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
}

/** Returns the provider to use, or 'mock' when a key is missing outside production */
function resolveName(requested: ProviderName, cfg: Config, production: boolean, setting: string): ProviderName {
  if (requested === 'mock') return 'mock';

  if (!hasKey(requested, cfg)) {
    if (production) {
      throw new Error(`${keyVar(requested)} is required when ${setting}=${requested}`);
    }
    logger.warn({ requested, setting }, `${keyVar(requested)} is not set; using the mock provider`);
    return 'mock';
  }
  return requested;
}

function resolveEmbeddingName(cfg: Config, production: boolean): ProviderName {
  let requested: ProviderName;

  if (cfg.embeddingProvider !== 'auto') {
    requested = cfg.embeddingProvider;
  } else if (cfg.aiProvider === 'openai') {
    requested = 'openai';
  } else if (cfg.aiProvider === 'anthropic') {
    // Anthropic cannot embed: use OpenAI when available, otherwise the mock (never in production)
    if (hasKey('openai', cfg)) {
      requested = 'openai';
    } else if (production) {
      throw new Error('An embedding provider is required when AI_PROVIDER=anthropic: set OPENAI_API_KEY (or EMBEDDING_PROVIDER)');
    } else {
      requested = 'mock';
    }
  } else {
    requested = 'mock';
  }

  return resolveName(requested, cfg, production, 'EMBEDDING_PROVIDER');
}

function instantiate(name: ProviderName, cfg: Config): LlmProvider {
  switch (name) {
    case 'openai':
      return new OpenAIProvider();
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: cfg.anthropicApiKey,
        model: cfg.anthropicModel,
        timeoutMs: cfg.aiTimeoutMs,
        ...(cfg.anthropicTemperature !== undefined && { temperature: cfg.anthropicTemperature }),
      });
    case 'mock':
      return new MockProvider();
  }
}

/** Name of the model the configured chat provider will call (for cost estimates and cache keys) */
export function chatModelName(cfg: Config): string {
  switch (cfg.aiProvider) {
    case 'openai':
      return cfg.openaiModel;
    case 'anthropic':
      return cfg.anthropicModel;
    case 'mock':
      return 'mock';
  }
}

// ===========================================
// Singletons used by the application
// ===========================================

let providers: Providers | null = null;

function getProviders(): Providers {
  if (!providers) {
    providers = buildProviders(getConfig());
  }
  return providers;
}

/** Provider for completions (chat, extraction, summaries) */
export function getLlmProvider(): LlmProvider {
  return getProviders().chat;
}

/** Provider for embeddings (document chunks, query vectors) */
export function getEmbeddingProvider(): LlmProvider {
  return getProviders().embedding;
}

/** Build the providers now so a bad configuration fails at startup, not on the first request */
export function initProviders(): void {
  getProviders();
}

/** Reset providers (useful for testing) */
export function resetProvider(): void {
  providers = null;
}

/** Check if a real (non-mock) chat provider is available */
export function hasRealProvider(): boolean {
  return getLlmProvider().name !== 'mock';
}

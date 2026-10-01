/**
 * Provider Factory
 * ================
 * Creates the appropriate LLM provider based on configuration.
 *
 * Selection logic:
 * 1. Check AI_PROVIDER env var
 * 2. Create corresponding provider
 * 3. Validate provider is configured (has API keys)
 * 4. Fall back to mock if requested provider not configured
 */

import type { LlmProvider } from './llmProvider.interface.js';
import { OpenAIProvider } from './openai.provider.js';
import { MockProvider } from './mock.provider.js';
import { getConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

// ===========================================
// Singleton Provider Instance
// ===========================================

let providerInstance: LlmProvider | null = null;

// ===========================================
// Factory Function
// ===========================================

/**
 * Get the configured LLM provider
 * Uses singleton pattern to reuse client connections
 */
export function getLlmProvider(): LlmProvider {
  if (providerInstance) {
    return providerInstance;
  }

  const config = getConfig();
  const requestedProvider = config.aiProvider;

  logger.info({ requestedProvider }, 'Initializing LLM provider');

  switch (requestedProvider) {
    case 'openai': {
      const provider = new OpenAIProvider();
      if (!provider.isConfigured()) {
        logger.warn('OpenAI requested but not configured. Falling back to mock.');
        providerInstance = new MockProvider();
      } else {
        providerInstance = provider;
      }
      break;
    }

    case 'anthropic': {
      // TODO: Implement AnthropicProvider
      logger.warn('Anthropic provider not yet implemented. Using mock.');
      providerInstance = new MockProvider();
      break;
    }

    case 'mock':
    default: {
      providerInstance = new MockProvider();
      break;
    }
  }

  logger.info({ provider: providerInstance.name }, 'LLM provider initialized');
  return providerInstance;
}

/**
 * Reset provider (useful for testing)
 */
export function resetProvider(): void {
  providerInstance = null;
}

/**
 * Check if a real (non-mock) provider is available
 */
export function hasRealProvider(): boolean {
  const provider = getLlmProvider();
  return provider.name !== 'mock';
}

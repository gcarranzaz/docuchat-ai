/**
 * OpenAI Provider
 * ===============
 * Implementation of LlmProvider using OpenAI API.
 *
 * Models used:
 * - Embeddings: text-embedding-3-small (1536 dimensions, cheap, good quality)
 * - Completions: gpt-4-turbo-preview (best for RAG/extraction)
 *
 * Error handling:
 * - Retries on rate limits (exponential backoff)
 * - Graceful degradation on API errors
 */

import OpenAI from 'openai';
import type { LlmProvider, CompletionParams } from './llmProvider.interface.js';
import type { EmbeddingResult, CompletionResult } from '../../types/index.js';
import { getConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

// ===========================================
// OpenAI Provider Implementation
// ===========================================

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private model: string;
  private embeddingModel: string;

  constructor() {
    const config = getConfig();
    this.model = config.openaiModel;
    this.embeddingModel = config.openaiEmbeddingModel;

    if (config.openaiApiKey) {
      this.client = new OpenAI({
        apiKey: config.openaiApiKey,
      });
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  // ===========================================
  // Embeddings
  // ===========================================

  async embed(text: string): Promise<EmbeddingResult> {
    if (!this.client) {
      throw new Error('OpenAI client not configured. Set OPENAI_API_KEY.');
    }

    const startTime = Date.now();

    try {
      const response = await this.client.embeddings.create({
        model: this.embeddingModel,
        input: text,
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new Error('No embedding returned from OpenAI');
      }

      const tokenCount = response.usage?.total_tokens ?? 0;

      logger.debug({
        model: this.embeddingModel,
        inputLength: text.length,
        tokenCount,
        latencyMs: Date.now() - startTime,
      }, 'OpenAI embedding generated');

      return {
        embedding,
        tokenCount,
      };
    } catch (error) {
      logger.error({ err: error }, 'OpenAI embedding failed');
      throw this.handleError(error);
    }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.client) {
      throw new Error('OpenAI client not configured. Set OPENAI_API_KEY.');
    }

    if (texts.length === 0) {
      return [];
    }

    const startTime = Date.now();

    try {
      // OpenAI supports batch embedding
      const response = await this.client.embeddings.create({
        model: this.embeddingModel,
        input: texts,
      });

      const results: EmbeddingResult[] = response.data.map((item, index) => ({
        embedding: item.embedding,
        // Estimate token count per text (total divided by count)
        tokenCount: Math.ceil((response.usage?.total_tokens ?? 0) / texts.length),
      }));

      logger.debug({
        model: this.embeddingModel,
        batchSize: texts.length,
        totalTokens: response.usage?.total_tokens,
        latencyMs: Date.now() - startTime,
      }, 'OpenAI batch embedding generated');

      return results;
    } catch (error) {
      logger.error({ err: error, batchSize: texts.length }, 'OpenAI batch embedding failed');
      throw this.handleError(error);
    }
  }

  // ===========================================
  // Completions
  // ===========================================

  async complete(params: CompletionParams): Promise<CompletionResult> {
    if (!this.client) {
      throw new Error('OpenAI client not configured. Set OPENAI_API_KEY.');
    }

    const startTime = Date.now();
    const config = getConfig();

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
        max_tokens: params.maxTokens ?? config.maxTokensPerRequest,
        temperature: params.temperature ?? 0.3,
        ...(params.jsonMode && { response_format: { type: 'json_object' } }),
        ...(params.stopSequences && { stop: params.stopSequences }),
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content returned from OpenAI');
      }

      const result: CompletionResult = {
        content,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        model: this.model,
      };

      logger.debug({
        model: this.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startTime,
      }, 'OpenAI completion generated');

      return result;
    } catch (error) {
      logger.error({ err: error }, 'OpenAI completion failed');
      throw this.handleError(error);
    }
  }

  // ===========================================
  // Error Handling
  // ===========================================

  private handleError(error: unknown): Error {
    if (error instanceof OpenAI.APIError) {
      switch (error.status) {
        case 401:
          return new Error('Invalid OpenAI API key');
        case 429:
          return new Error('OpenAI rate limit exceeded. Please try again later.');
        case 500:
        case 502:
        case 503:
          return new Error('OpenAI service temporarily unavailable');
        default:
          return new Error(`OpenAI API error: ${error.message}`);
      }
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error('Unknown OpenAI error');
  }
}

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
import type {
  LlmProvider,
  CompletionParams,
  StreamHandlers,
  ToolCall,
  ToolCompletionParams,
  ToolCompletionResult,
} from './llmProvider.interface.js';
import type { EmbeddingResult, CompletionResult } from '../../types/index.js';
import { LlmProviderError, StreamAbortedError, isRetryableStatus, parseRetryAfter } from './errors.js';
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
        // One retry policy for every provider lives in ResilientProvider; the
        // SDK's own retries would multiply with ours.
        maxRetries: 0,
        timeout: config.aiTimeoutMs,
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
  // Tool calling
  // ===========================================

  /** One step of a tool conversation (Chat Completions `tools`); see ai/tools/toolLoop.ts */
  async completeWithTools(params: ToolCompletionParams): Promise<ToolCompletionResult> {
    if (!this.client) {
      throw new Error('OpenAI client not configured. Set OPENAI_API_KEY.');
    }
    const config = getConfig();

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ];
    for (const turn of params.turns) {
      if (turn.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: turn.text || null,
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          })),
        });
      } else {
        for (const result of turn.results) {
          messages.push({ role: 'tool', tool_call_id: result.callId, content: result.content });
        }
      }
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: params.maxTokens ?? config.maxTokensPerRequest,
        temperature: params.temperature ?? 0.3,
        tools: params.tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })),
        tool_choice: params.toolChoice,
      });

      const message = response.choices[0]?.message;
      const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((call) => {
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = undefined; // reported to the model as invalid arguments by the executor
        }
        return { id: call.id, name: call.function.name, arguments: args };
      });
      const content = message?.content ?? '';
      if (!content && toolCalls.length === 0) {
        throw new Error('No content returned from OpenAI');
      }

      return {
        content,
        toolCalls,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        model: this.model,
      };
    } catch (error) {
      logger.error({ err: error }, 'OpenAI tool completion failed');
      throw this.handleError(error);
    }
  }

  // ===========================================
  // Streaming
  // ===========================================

  async stream(params: CompletionParams, handlers: StreamHandlers): Promise<CompletionResult> {
    if (!this.client) {
      throw new Error('OpenAI client not configured. Set OPENAI_API_KEY.');
    }
    if (handlers.signal?.aborted) throw new StreamAbortedError();

    const config = getConfig();
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userPrompt },
          ],
          max_tokens: params.maxTokens ?? config.maxTokensPerRequest,
          temperature: params.temperature ?? 0.3,
          stream: true,
          // The final chunk carries the token usage; without this we would not know what was billed
          stream_options: { include_usage: true },
          ...(params.jsonMode && { response_format: { type: 'json_object' as const } }),
          ...(params.stopSequences && { stop: params.stopSequences }),
        },
        { signal: handlers.signal }
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          content += delta;
          handlers.onToken(delta);
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }
    } catch (error) {
      if (handlers.signal?.aborted) throw new StreamAbortedError();
      logger.error({ err: error }, 'OpenAI stream failed');
      throw this.handleError(error);
    }

    if (!content) {
      throw new LlmProviderError('No content returned from OpenAI', this.name, undefined, false);
    }
    return { content, inputTokens, outputTokens, model: this.model };
  }

  // ===========================================
  // Error Handling
  // ===========================================

  private handleError(error: unknown): Error {
    if (error instanceof LlmProviderError) {
      return error;
    }

    // Network failures and timeouts: the request may succeed if repeated
    if (error instanceof OpenAI.APIConnectionError) {
      return new LlmProviderError('Could not reach OpenAI (network error or timeout)', this.name, undefined, true, { cause: error });
    }

    if (error instanceof OpenAI.APIError) {
      const status = error.status;
      const message =
        status === 401 || status === 403
          ? 'OpenAI rejected the API key'
          : status === 429
            ? 'OpenAI rate limit exceeded'
            : status !== undefined && status >= 500
              ? 'OpenAI service temporarily unavailable'
              : `OpenAI API error: ${error.message}`;
      const retryAfterMs = parseRetryAfter(error.headers?.['retry-after']);
      return new LlmProviderError(message, this.name, status, isRetryableStatus(status), {
        cause: error,
        ...(retryAfterMs !== undefined && { retryAfterMs }),
      });
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error('Unknown OpenAI error');
  }
}

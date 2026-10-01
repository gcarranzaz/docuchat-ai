/**
 * Anthropic Provider
 * ==================
 * LlmProvider backed by the Anthropic Messages API, called with plain `fetch`
 * (no SDK): one fewer dependency, and the HTTP layer is trivial to fake in tests.
 *
 * - Completions only. Anthropic does not offer an embeddings API, so embedding
 *   calls fail with a clear, non-retryable error; embeddings are configured
 *   separately (see EMBEDDING_PROVIDER).
 * - `jsonMode` has no API switch here: the prompt asks for JSON and the
 *   post-processing validates it (spec 003), same as for the other providers.
 * - Errors are normalised to LlmProviderError and never include the API key.
 */

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

const PROVIDER_NAME = 'anthropic';
const API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export interface AnthropicProviderOptions {
  apiKey: string | undefined;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Sampling temperature. Unset by default: newer Claude models reject the
   * parameter (the live API answers 400 "temperature is deprecated for this
   * model"). Set it only for models that still accept it.
   */
  temperature?: number;
  /** Injectable for tests */
  fetchImpl?: typeof fetch;
}

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = PROVIDER_NAME;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly temperature: number | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.temperature = options.temperature;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromConfig(): AnthropicProvider {
    const config = getConfig();
    return new AnthropicProvider({
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      timeoutMs: config.aiTimeoutMs,
      ...(config.anthropicTemperature !== undefined && { temperature: config.anthropicTemperature }),
    });
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  // Embeddings are not offered by Anthropic ----------------------------------

  async embed(_text: string): Promise<EmbeddingResult> {
    throw this.unsupportedEmbeddings();
  }

  async embedBatch(_texts: string[]): Promise<EmbeddingResult[]> {
    throw this.unsupportedEmbeddings();
  }

  // Completions --------------------------------------------------------------

  async complete(params: CompletionParams): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new LlmProviderError('Anthropic client not configured. Set ANTHROPIC_API_KEY.', PROVIDER_NAME, undefined, false);
    }

    const startTime = Date.now();
    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? getConfig().maxTokensPerRequest,
      ...(this.temperature !== undefined && { temperature: this.temperature }),
      system: params.systemPrompt,
      messages: [{ role: 'user', content: params.userPrompt }],
      ...(params.stopSequences && params.stopSequences.length > 0 && { stop_sequences: params.stopSequences }),
    };

    const response = await this.post('/v1/messages', body);
    const data = (await response.json()) as AnthropicMessageResponse;

    const content = (data.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');

    if (!content) {
      throw new LlmProviderError('No text content returned from Anthropic', PROVIDER_NAME, response.status, false);
    }

    const result: CompletionResult = {
      content,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      model: data.model ?? this.model,
    };

    logger.debug(
      { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: Date.now() - startTime },
      'Anthropic completion generated'
    );

    return result;
  }

  // Tool calling -------------------------------------------------------------

  /**
   * One step of a tool conversation (Messages API `tools`). Anthropic requires the tool list
   * whenever earlier turns contain tool_use/tool_result blocks, so the last round is expressed
   * with tool_choice "none" instead of an empty list.
   */
  async completeWithTools(params: ToolCompletionParams): Promise<ToolCompletionResult> {
    if (!this.apiKey) {
      throw new LlmProviderError('Anthropic client not configured. Set ANTHROPIC_API_KEY.', PROVIDER_NAME, undefined, false);
    }

    const messages: unknown[] = [{ role: 'user', content: params.userPrompt }];
    for (const turn of params.turns) {
      if (turn.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: [
            ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
            ...turn.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} })),
          ],
        });
      } else {
        messages.push({
          role: 'user',
          content: turn.results.map((result) => ({
            type: 'tool_result',
            tool_use_id: result.callId,
            content: result.content,
            ...(result.isError && { is_error: true }),
          })),
        });
      }
    }

    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? getConfig().maxTokensPerRequest,
      ...(this.temperature !== undefined && { temperature: this.temperature }),
      system: params.systemPrompt,
      messages,
      tools: params.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      tool_choice: { type: params.toolChoice === 'none' ? 'none' : 'auto' },
    };

    const response = await this.post('/v1/messages', body);
    const data = (await response.json()) as AnthropicMessageResponse;
    const blocks = data.content ?? [];

    const content = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    const toolCalls: ToolCall[] = blocks
      .filter((block) => block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string')
      .map((block) => ({ id: block.id as string, name: block.name as string, arguments: block.input }));

    if (!content && toolCalls.length === 0) {
      throw new LlmProviderError('No content returned from Anthropic', PROVIDER_NAME, response.status, false);
    }

    return {
      content,
      toolCalls,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      model: data.model ?? this.model,
    };
  }

  // Streaming ----------------------------------------------------------------

  /**
   * Same request as complete() with `stream: true`; the reply is Server-Sent Events.
   * The timeout is an idle timeout: it restarts on every chunk, so a long answer is
   * fine as long as it keeps flowing.
   */
  async stream(params: CompletionParams, handlers: StreamHandlers): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw new LlmProviderError('Anthropic client not configured. Set ANTHROPIC_API_KEY.', PROVIDER_NAME, undefined, false);
    }
    if (handlers.signal?.aborted) throw new StreamAbortedError();

    const body = {
      model: this.model,
      max_tokens: params.maxTokens ?? getConfig().maxTokensPerRequest,
      ...(this.temperature !== undefined && { temperature: this.temperature }),
      system: params.systemPrompt,
      messages: [{ role: 'user', content: params.userPrompt }],
      ...(params.stopSequences && params.stopSequences.length > 0 && { stop_sequences: params.stopSequences }),
      stream: true,
    };

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    const onCallerAbort = () => controller.abort();
    handlers.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      handlers.signal?.removeEventListener('abort', onCallerAbort);
    };

    arm();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      cleanup();
      if (handlers.signal?.aborted) throw new StreamAbortedError();
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new LlmProviderError(
        timedOut ? `Anthropic request timed out after ${this.timeoutMs}ms` : 'Could not reach Anthropic',
        PROVIDER_NAME,
        undefined,
        true,
        { cause: error }
      );
    }

    if (!response.ok) {
      cleanup();
      throw await this.toError(response);
    }
    if (!response.body) {
      cleanup();
      throw new LlmProviderError('Anthropic returned no stream body', PROVIDER_NAME, response.status, false);
    }

    const state = { content: '', inputTokens: 0, outputTokens: 0, model: this.model };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          this.handleStreamEvent(buffer.slice(0, boundary), state, handlers);
          buffer = buffer.slice(boundary + 2);
        }
      }
      if (buffer.trim() !== '') this.handleStreamEvent(buffer, state, handlers);
    } catch (error) {
      if (handlers.signal?.aborted) throw new StreamAbortedError();
      if (error instanceof LlmProviderError) throw error;
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new LlmProviderError(
        timedOut ? `Anthropic stream stalled for ${this.timeoutMs}ms` : 'Anthropic stream interrupted',
        PROVIDER_NAME,
        undefined,
        true,
        { cause: error }
      );
    } finally {
      cleanup();
      reader.cancel().catch(() => undefined);
    }

    if (!state.content) {
      throw new LlmProviderError('No text content returned from Anthropic', PROVIDER_NAME, response.status, false);
    }
    return state;
  }

  private handleStreamEvent(
    raw: string,
    state: { content: string; inputTokens: number; outputTokens: number; model: string },
    handlers: StreamHandlers
  ): void {
    const data = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!data) return; // comment or keep-alive

    let event: {
      type?: string;
      message?: { model?: string; usage?: { input_tokens?: number } };
      delta?: { type?: string; text?: string };
      usage?: { output_tokens?: number };
      error?: { type?: string; message?: string };
    };
    try {
      event = JSON.parse(data);
    } catch {
      return; // a malformed event is skipped; the final text check still protects the caller
    }

    switch (event.type) {
      case 'message_start':
        state.inputTokens = event.message?.usage?.input_tokens ?? state.inputTokens;
        state.model = event.message?.model ?? state.model;
        break;
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string' && event.delta.text !== '') {
          state.content += event.delta.text;
          handlers.onToken(event.delta.text);
        }
        break;
      case 'message_delta':
        state.outputTokens = event.usage?.output_tokens ?? state.outputTokens;
        break;
      case 'error': {
        const kind = event.error?.type ?? '';
        const retryable = ['overloaded_error', 'rate_limit_error', 'api_error', 'timeout_error'].includes(kind);
        throw new LlmProviderError(`Anthropic stream error: ${event.error?.message ?? kind}`, PROVIDER_NAME, undefined, retryable);
      }
      default:
        break; // ping, content_block_start/stop, message_stop
    }
  }

  // HTTP ---------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey as string,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new LlmProviderError(
        timedOut ? `Anthropic request timed out after ${this.timeoutMs}ms` : 'Could not reach Anthropic',
        PROVIDER_NAME,
        undefined,
        true,
        { cause: error }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await this.toError(response);
    }
    return response;
  }

  private async toError(response: Response): Promise<LlmProviderError> {
    let detail = '';
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      detail = payload.error?.message ?? '';
    } catch {
      // body was not JSON; the status is enough
    }

    const message =
      response.status === 401 || response.status === 403
        ? 'Anthropic rejected the API key'
        : `Anthropic API error (${response.status})${detail ? `: ${detail}` : ''}`;

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return new LlmProviderError(message, PROVIDER_NAME, response.status, isRetryableStatus(response.status), {
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    });
  }

  private unsupportedEmbeddings(): LlmProviderError {
    return new LlmProviderError(
      'Anthropic does not provide embeddings. Set EMBEDDING_PROVIDER=openai (or mock for local development).',
      PROVIDER_NAME,
      undefined,
      false
    );
  }
}

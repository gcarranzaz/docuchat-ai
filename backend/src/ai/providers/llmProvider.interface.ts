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
   * Same as complete(), but reports the text as it is generated.
   * Resolves with the full result (usage included) when the stream ends.
   * Rejects with StreamAbortedError if handlers.signal aborts.
   */
  stream(params: CompletionParams, handlers: StreamHandlers): Promise<CompletionResult>;

  /**
   * One step of a tool-calling conversation (spec 011). Optional: a provider without it
   * simply cannot be offered tools, and the caller falls back to complete().
   * The model either answers (toolCalls is empty) or asks for tools to be run; running
   * them and calling again is the job of ai/tools/toolLoop.ts, never of the provider.
   */
  completeWithTools?(params: ToolCompletionParams): Promise<ToolCompletionResult>;

  /**
   * Check if provider is configured and ready
   */
  isConfigured(): boolean;
}

export interface StreamHandlers {
  /** Called with each piece of generated text, in order */
  onToken: (text: string) => void;
  /** Abort the call, for example because the client disconnected */
  signal?: AbortSignal;
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
// Tool calling (read-only tools, spec 011)
// ===========================================

/** What the model is told it can call. `inputSchema` is JSON Schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A request from the model. `arguments` is undefined when the model sent something that is not JSON. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  /** JSON text. Treated as untrusted data by the model. */
  content: string;
  isError: boolean;
}

/** Provider-neutral transcript of the tool rounds so far; each provider maps it to its own format */
export type ToolTurn =
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export interface ToolCompletionParams extends CompletionParams {
  /** Always the full list: some APIs require it whenever earlier turns contain tool calls */
  tools: ToolDefinition[];
  /** "none" on the last round: the model must answer instead of calling a tool */
  toolChoice: 'auto' | 'none';
  turns: ToolTurn[];
}

export interface ToolCompletionResult extends CompletionResult {
  toolCalls: ToolCall[];
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

// Pricing lives in ../pricing.ts (configurable; unknown models are never free).

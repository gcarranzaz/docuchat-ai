/**
 * Redacting Provider
 * ==================
 * Decorator that masks personal data (emails, phones, card and national ids, IBANs, IPs)
 * in everything sent to an AI provider, so a third party never receives it.
 * Enabled with REDACT_PII_BEFORE_LLM=true.
 *
 * - Applied at the provider boundary, so it covers every path at once: chat, extraction,
 *   summaries, and the embeddings of both documents and questions.
 * - Only what is SENT is masked. Stored documents, citations and answers shown to the user
 *   keep the original text.
 * - Trade-off: the model cannot reason about a masked value ("what is the customer's email?"
 *   gets "[EMAIL]"), and pattern matching misses names and addresses. For stronger guarantees
 *   use a provider under a zero-retention agreement or an in-region/self-hosted model.
 * - The system prompt is ours (no user data) and is left as is; prompt delimiters are preserved.
 */

import type {
  LlmProvider,
  CompletionParams,
  StreamHandlers,
  ToolCompletionParams,
  ToolCompletionResult,
} from './llmProvider.interface.js';
import type { EmbeddingResult, CompletionResult } from '../../types/index.js';
import { redactPromptWithCounts } from '../safety/pii.js';
import { logger } from '../../utils/logger.js';

export class RedactingProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider) {}

  get name(): string {
    return this.inner.name;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  embed(text: string): Promise<EmbeddingResult> {
    return this.inner.embed(this.mask(text, 'embed'));
  }

  embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return this.inner.embedBatch(texts.map((text) => this.mask(text, 'embed')));
  }

  complete(params: CompletionParams): Promise<CompletionResult> {
    return this.inner.complete(this.maskParams(params));
  }

  stream(params: CompletionParams, handlers: StreamHandlers): Promise<CompletionResult> {
    return this.inner.stream(this.maskParams(params), handlers);
  }

  /** Tool results carry document metadata and summaries, so they are masked like any other outgoing text */
  get completeWithTools(): LlmProvider['completeWithTools'] {
    const inner = this.inner.completeWithTools?.bind(this.inner);
    if (!inner) return undefined;
    return (params: ToolCompletionParams): Promise<ToolCompletionResult> =>
      inner({
        ...params,
        userPrompt: this.mask(params.userPrompt, 'complete'),
        turns: params.turns.map((turn) =>
          turn.role === 'tool'
            ? { ...turn, results: turn.results.map((result) => ({ ...result, content: this.mask(result.content, 'complete') })) }
            : turn
        ),
      });
  }

  private maskParams(params: CompletionParams): CompletionParams {
    return { ...params, userPrompt: this.mask(params.userPrompt, 'complete') };
  }

  private mask(text: string, operation: string): string {
    const { text: masked, counts } = redactPromptWithCounts(text);
    if (Object.keys(counts).length > 0) {
      // Counts only: the values themselves must not reach the logs
      logger.debug({ operation, counts }, 'Personal data masked before sending to the AI provider');
    }
    return masked;
  }
}

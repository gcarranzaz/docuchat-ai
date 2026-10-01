/**
 * Mock Provider
 * =============
 * Fake LLM provider for testing without API calls.
 *
 * Features:
 * - Generates deterministic "embeddings" (for testing similarity)
 * - Returns canned responses for completions
 * - Simulates realistic token counts
 * - No external dependencies
 *
 * Use cases:
 * - Development without API keys
 * - Unit testing
 * - CI/CD pipelines
 */

import type {
  LlmProvider,
  CompletionParams,
  StreamHandlers,
  ToolCall,
  ToolCompletionParams,
  ToolCompletionResult,
} from './llmProvider.interface.js';
import { StreamAbortedError } from './errors.js';
import type { EmbeddingResult, CompletionResult } from '../../types/index.js';
import { getConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

// ===========================================
// Mock Provider Implementation
// ===========================================

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  private embeddingDimensions: number;
  /** Pause between streamed pieces: short by default so tests stay fast, MOCK_STREAM_DELAY_MS to slow it down */
  private streamDelayMs: number;

  constructor() {
    const config = getConfig();
    this.embeddingDimensions = config.embeddingDimensions;
    this.streamDelayMs = config.mockStreamDelayMs;
  }

  isConfigured(): boolean {
    return true; // Always configured
  }

  // ===========================================
  // Embeddings
  // ===========================================

  async embed(text: string): Promise<EmbeddingResult> {
    // Generate a deterministic "embedding" based on text hash
    // This allows testing similarity search with consistent results
    const embedding = this.generateMockEmbedding(text);
    const tokenCount = Math.ceil(text.length / 4);

    logger.debug({
      provider: 'mock',
      inputLength: text.length,
      tokenCount,
    }, 'Mock embedding generated');

    return {
      embedding,
      tokenCount,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  // ===========================================
  // Completions
  // ===========================================

  async complete(params: CompletionParams): Promise<CompletionResult> {
    // Generate a mock response based on the prompt
    const content = this.generateMockResponse(params);
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userPrompt.length) / 4);
    const outputTokens = Math.ceil(content.length / 4);

    logger.debug({
      provider: 'mock',
      inputTokens,
      outputTokens,
    }, 'Mock completion generated');

    // Simulate some latency
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      content,
      inputTokens,
      outputTokens,
      model: 'mock',
    };
  }

  /**
   * Deterministic tool use, so the whole path runs with no key (spec 011).
   * The mock asks for get_document_info when the question names a lookup ("lookup <uuid>"),
   * or asks about the document itself (size, chunks, upload date, metadata) and the context
   * shows a document id. After the tool result it answers from it. Text inside documents never
   * triggers anything: only the QUESTION block is read.
   */
  async completeWithTools(params: ToolCompletionParams): Promise<ToolCompletionResult> {
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userPrompt.length) / 4);
    const question = this.readBlock(params.userPrompt, 'QUESTION') ?? '';
    const context = this.readBlock(params.userPrompt, 'CONTEXT') ?? '';
    const lastTool = [...params.turns].reverse().find((turn) => turn.role === 'tool');

    if (!lastTool && params.toolChoice === 'auto') {
      const explicit = question.match(/lookup ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
      const asksAboutDocument = /\b(how (big|large|long)|how many (chunks|characters)|when was|uploaded|document info|metadata)\b/i.test(question);
      const fromContext = asksAboutDocument ? context.match(/document: ([0-9a-f-]{36})/i)?.[1] : undefined;
      const documentId = explicit ?? fromContext;
      if (documentId) {
        const call: ToolCall = { id: 'mock-call-1', name: 'get_document_info', arguments: { documentId } };
        return { content: '', toolCalls: [call], inputTokens, outputTokens: 20, model: 'mock' };
      }
    }

    if (lastTool && lastTool.role === 'tool') {
      const result = lastTool.results[0];
      const payload = result ? this.readToolPayload(result.content) : undefined;
      const answer = JSON.stringify(
        result && !result.isError && payload
          ? {
              answer: `The document "${String(payload['title'])}" has ${String(payload['chunkCount'])} chunks and ${String(payload['characters'])} characters. [chunk-0]`,
              citations: /\[chunk-0\]/.test(context) ? [0] : [],
              confidence: 'MEDIUM',
              reasoning: 'Mock provider: answered from the get_document_info tool result.',
            }
          : {
              answer: 'I could not look up that document.',
              citations: [],
              confidence: 'LOW',
              reasoning: 'The tool returned an error.',
            }
      );
      return { content: answer, toolCalls: [], inputTokens, outputTokens: Math.ceil(answer.length / 4), model: 'mock' };
    }

    const content = this.generateMockResponse(params);
    return { content, toolCalls: [], inputTokens, outputTokens: Math.ceil(content.length / 4), model: 'mock' };
  }

  /** The JSON inside a TOOL_RESULT block, or undefined */
  private readToolPayload(wrapped: string): Record<string, unknown> | undefined {
    const inner = this.readBlock(wrapped, 'TOOL_RESULT') ?? wrapped;
    try {
      const parsed: unknown = JSON.parse(inner);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Streams the same content complete() would return, a word at a time, so the
   * whole streaming path can be exercised with no API key.
   */
  async stream(params: CompletionParams, handlers: StreamHandlers): Promise<CompletionResult> {
    const content = this.generateMockResponse(params);
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userPrompt.length) / 4);
    const outputTokens = Math.ceil(content.length / 4);

    // Words and the whitespace after them: concatenated, the pieces equal the content exactly
    for (const piece of content.match(/\S+\s*|\s+/g) ?? []) {
      if (handlers.signal?.aborted) throw new StreamAbortedError();
      handlers.onToken(piece);
      await new Promise((resolve) => setTimeout(resolve, this.streamDelayMs));
    }
    if (handlers.signal?.aborted) throw new StreamAbortedError();

    return { content, inputTokens, outputTokens, model: 'mock' };
  }

  // ===========================================
  // Mock Generation Logic
  // ===========================================

  /**
   * Generate a deterministic embedding from text
   * Uses simple hash to create reproducible vectors
   */
  private generateMockEmbedding(text: string): number[] {
    const embedding = new Array(this.embeddingDimensions).fill(0);

    // Create a simple hash-based embedding
    // Similar texts will have somewhat similar embeddings
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const index = (charCode * (i + 1)) % this.embeddingDimensions;
      embedding[index] = (embedding[index] ?? 0) + (charCode / 255 - 0.5);
    }

    // Normalize the vector
    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0)
    );

    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] = (embedding[i] ?? 0) / magnitude;
      }
    }

    return embedding;
  }

  /**
   * Generate a mock response based on prompt content
   */
  private generateMockResponse(params: CompletionParams): string {
    const userPrompt = params.userPrompt.toLowerCase();

    // Check if JSON mode is requested
    if (params.jsonMode) {
      return this.generateMockJsonResponse(userPrompt);
    }

    // Chat prompt (chat_rag v3): untrusted blocks are delimited with a per-request nonce
    if (/<<<begin_context_[0-9a-f]+>>>/.test(userPrompt)) {
      return this.generateMockRagResponse(params.userPrompt);
    }

    // Document summary prompt (document_summary v1)
    if (/<<<begin_title_[0-9a-f]+>>>/.test(userPrompt)) {
      return this.generateMockSummaryResponse(params.userPrompt);
    }

    // Default response
    return `This is a mock response from the test LLM provider.

Based on the provided context, I can offer the following information:

1. The document contains relevant information about the query.
2. Key points have been identified and summarized.
3. Citations are available for verification.

[chunk-0] This citation references the source material.

Confidence: MEDIUM

Note: This is a mock response for testing purposes. In production, this would be generated by a real LLM.`;
  }

  /**
   * Generate mock RAG response with citations
   */
  private generateMockRagResponse(prompt: string): string {
    const question = this.readBlock(prompt, 'QUESTION') ?? 'the query';
    const context = this.readBlock(prompt, 'CONTEXT') ?? '';

    // Cite the first two chunk labels that really appear in the context
    const cited: number[] = [];
    for (const match of context.matchAll(/\[chunk-(\d+)\]/g)) {
      const index = Number(match[1]);
      if (!cited.includes(index)) cited.push(index);
      if (cited.length === 2) break;
    }

    // Always the same JSON shape, whatever the document says: the mock never obeys text in the context
    if (cited.length === 0) {
      return JSON.stringify({
        answer: "I couldn't find information about this in your documents.",
        citations: [],
        confidence: 'LOW',
        reasoning: 'No relevant context was provided.',
      });
    }

    return JSON.stringify({
      answer: `Based on your documents, here is a (mock) answer to "${question.slice(0, 200)}": the content addresses your question. ${cited
        .map((index) => `[chunk-${index}]`)
        .join(' ')}`,
      citations: cited,
      confidence: 'MEDIUM',
      reasoning: 'Mock provider: deterministic answer for local development and tests.',
    });
  }

  /**
   * Mock document summary (document_summary v1 prompt)
   */
  private generateMockSummaryResponse(prompt: string): string {
    const title = (this.readBlock(prompt, 'TITLE') ?? 'Untitled').slice(0, 100);
    const body = (this.readBlock(prompt, 'DOCUMENT') ?? '').replace(/\s+/g, ' ').trim();
    return JSON.stringify({
      summary: body ? `${body.slice(0, 200)}${body.length > 200 ? '...' : ''}` : 'Empty document.',
      keyTopics: [title],
      documentType: 'other',
    });
  }

  /** Text between <<<BEGIN_LABEL_nonce>>> and <<<END_LABEL_nonce>>> (first match), or null */
  private readBlock(prompt: string, label: string): string | null {
    const match = prompt.match(new RegExp(`<<<BEGIN_${label}_([0-9a-f]+)>>>\\n([\\s\\S]*?)\\n<<<END_${label}_\\1>>>`));
    return match ? (match[2] as string) : null;
  }

  /**
   * Generate mock JSON response for extraction
   */
  private generateMockJsonResponse(prompt: string): string {
    // Try to detect what kind of extraction is requested
    if (prompt.includes('invoice')) {
      return JSON.stringify({
        invoiceNumber: 'INV-MOCK-001',
        date: '2024-01-15',
        vendor: 'Mock Vendor Inc.',
        total: 1234.56,
        items: [
          { description: 'Mock Service', quantity: 1, price: 1000.00 },
          { description: 'Mock Product', quantity: 2, price: 117.28 },
        ],
        confidence: 0.85,
      }, null, 2);
    }

    if (prompt.includes('resume') || prompt.includes('cv')) {
      return JSON.stringify({
        name: 'John Mock',
        email: 'john.mock@example.com',
        phone: '+1-555-MOCK',
        experience: [
          {
            title: 'Senior Developer',
            company: 'Mock Corp',
            duration: '2020-2024',
          },
        ],
        skills: ['TypeScript', 'React', 'Node.js'],
        confidence: 0.90,
      }, null, 2);
    }

    // Generic extraction response
    return JSON.stringify({
      extracted: true,
      fields: {
        field1: 'Mock value 1',
        field2: 'Mock value 2',
        field3: 123,
      },
      confidence: 0.75,
      note: 'This is a mock extraction for testing purposes',
    }, null, 2);
  }
}

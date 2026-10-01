/**
 * Chat pipeline
 * =============
 * The three stages of an AI answer, kept separate so each can be tested and
 * changed on its own (requirement 1.2):
 *
 *   1. Prompt construction   ai/prompts/promptBuilder.ts   pure
 *   2. Model invocation      ai/providers/*                retries and fallback live here
 *   3. Post-processing       ai/postprocessing/chatOutput  pure, schema-validated
 *
 * This file only wires them together, plus one repair attempt when the model
 * breaks the output format. It knows nothing about HTTP, sessions or the database.
 */

import { buildChatPrompt, buildRepairPrompt, type BuiltPrompt, type HistoryTurn } from '../prompts/promptBuilder.js';
import { postProcessChat } from '../postprocessing/chatOutput.js';
import { AnswerStreamExtractor } from '../streaming/answerStream.js';
import { buildContextFromChunks, createChunkMapping } from '../../rag/context.js';
import type { LlmProvider, ToolCall } from '../providers/llmProvider.interface.js';
import { executeTool, toolDefinitions, type ToolExecution } from '../tools/registry.js';
import { runToolLoop } from '../tools/toolLoop.js';
import type { ChunkWithScore, Citation, CompletionResult } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

/**
 * The model did not return a usable answer, even after one repair attempt.
 * The message is generic on purpose: the raw output may contain injected text.
 */
export class AiOutputInvalidError extends Error {
  readonly code = 'AI_OUTPUT_INVALID';
  readonly statusCode = 502;

  constructor() {
    super('The AI service returned an answer in an unexpected format. Please try again.');
    this.name = 'AiOutputInvalidError';
  }
}

export interface ChatPipelineInput {
  question: string;
  chunks: ChunkWithScore[];
  history?: HistoryTurn[];
  provider: LlmProvider;
  /** Override the configured prompt version (evals, tests) */
  promptVersion?: string;
  /**
   * Stream the answer text as it is generated. What is streamed is a DRAFT: the
   * reply is still validated when it ends, and the returned result is the source of
   * truth. Only the first attempt streams; a repair attempt is not streamed.
   */
  stream?: {
    onToken: (answerText: string) => void;
    signal?: AbortSignal;
  };
  /**
   * Offer the read-only tools (spec 011) on the first attempt. Never combined with `stream`: a tool
   * round needs complete turns. `onToolCall` lets the caller audit each call.
   */
  tools?: {
    userId: string;
    maxRounds: number;
    onToolCall?: (call: ToolCall, execution: ToolExecution, round: number) => Promise<void> | void;
  };
}

export interface ChatPipelineResult {
  answer: string;
  citations: Citation[];
  rawConfidence: string;
  reasoning: string | undefined;
  droppedCitations: number;
  /** True when the first reply was invalid and the second attempt produced the answer */
  repaired: boolean;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  promptVersion: string;
  /** Tool calls executed while answering (0 unless tools were offered) */
  toolCalls: number;
}

// Stage 2: invocation ---------------------------------------------------------

async function invokeModel(provider: LlmProvider, prompt: BuiltPrompt): Promise<CompletionResult> {
  return provider.complete({ systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt });
}

/** Streaming invocation: the reply is JSON, so only the text of its "answer" field goes to the caller */
async function invokeModelStreaming(
  provider: LlmProvider,
  prompt: BuiltPrompt,
  stream: NonNullable<ChatPipelineInput['stream']>
): Promise<CompletionResult> {
  const extractor = new AnswerStreamExtractor();
  return provider.stream(
    { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt },
    {
      ...(stream.signal && { signal: stream.signal }),
      onToken: (piece) => {
        const text = extractor.push(piece);
        if (text !== '') stream.onToken(text);
      },
    }
  );
}

// Orchestration ---------------------------------------------------------------

export async function runChatPipeline(input: ChatPipelineInput): Promise<ChatPipelineResult> {
  const { question, chunks, history, provider } = input;

  // Stage 1
  const useTools = Boolean(input.tools && !input.stream && provider.completeWithTools);
  const prompt = buildChatPrompt(
    { context: buildContextFromChunks(chunks, { includeDocumentIds: useTools }), question, ...(history && { history }) },
    input.promptVersion ? { version: input.promptVersion } : {}
  );
  const chunkMapping = createChunkMapping(chunks);

  // Stage 2 + 3, with at most one repair attempt. Every call is billed, so usage
  // is the sum over all attempts.
  const attempts: CompletionResult[] = [];

  let toolCalls = 0;
  let first: CompletionResult;
  if (useTools && input.tools) {
    const { userId, maxRounds, onToolCall } = input.tools;
    const loop = await runToolLoop({
      provider,
      params: { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt },
      tools: toolDefinitions(),
      maxRounds,
      nonce: prompt.nonce,
      execute: (call) => executeTool(call, { userId }),
      ...(onToolCall && { onToolCall }),
    });
    toolCalls = loop.executedCalls;
    // Billing is the sum over every round, so the loop's totals replace the last reply's own
    first = { content: loop.final.content, model: loop.final.model, ...loop.usage };
  } else {
    first = input.stream ? await invokeModelStreaming(provider, prompt, input.stream) : await invokeModel(provider, prompt);
  }
  attempts.push(first);
  const firstResult = postProcessChat(first.content, chunkMapping);
  if (firstResult.ok) {
    return toResult(firstResult, prompt, attempts, false, toolCalls);
  }

  logger.warn({ reason: firstResult.error, model: first.model, promptVersion: prompt.promptVersion }, 'Model output invalid; retrying once');

  const second = await invokeModel(provider, buildRepairPrompt(prompt, firstResult.error));
  attempts.push(second);
  const secondResult = postProcessChat(second.content, chunkMapping);
  if (secondResult.ok) {
    return toResult(secondResult, prompt, attempts, true, toolCalls);
  }

  logger.error({ reason: secondResult.error, model: second.model, promptVersion: prompt.promptVersion }, 'Model output invalid after repair attempt');
  throw new AiOutputInvalidError();
}

function toResult(
  processed: Extract<ReturnType<typeof postProcessChat>, { ok: true }>,
  prompt: BuiltPrompt,
  attempts: CompletionResult[],
  repaired: boolean,
  toolCalls: number
): ChatPipelineResult {
  return {
    answer: processed.answer,
    citations: processed.citations,
    rawConfidence: processed.rawConfidence,
    reasoning: processed.reasoning,
    droppedCitations: processed.droppedCitations,
    repaired,
    usage: {
      inputTokens: attempts.reduce((sum, a) => sum + a.inputTokens, 0),
      outputTokens: attempts.reduce((sum, a) => sum + a.outputTokens, 0),
    },
    model: (attempts[attempts.length - 1] as CompletionResult).model,
    promptVersion: prompt.promptVersion,
    toolCalls,
  };
}

/**
 * Tool loop (spec 011)
 * ====================
 * Alternates model calls and tool executions until the model answers, with hard bounds:
 *
 * - At most `maxRounds` rounds of tool use. The call after the last round is made with tool_choice
 *   "none", so the model has to answer; if a misbehaving provider still returns tool calls then,
 *   they are ignored, never executed.
 * - At most MAX_CALLS_PER_ROUND calls are executed in one round; the rest get an error result.
 * - Tool results are wrapped in the request's nonce delimiters like every other untrusted text.
 * - Usage is summed over every model call: each round is billed.
 *
 * The loop knows nothing about HTTP or the database. Tools run through `execute`, and each call is
 * reported through `onToolCall` so the caller can audit it.
 */

import type {
  LlmProvider,
  CompletionParams,
  ToolCall,
  ToolCompletionResult,
  ToolDefinition,
  ToolResult,
  ToolTurn,
} from '../providers/llmProvider.interface.js';
import { wrapUntrusted } from '../prompts/render.js';
import { logger } from '../../utils/logger.js';
import type { ToolExecution } from './registry.js';

const MAX_CALLS_PER_ROUND = 3;

export interface ToolLoopOptions {
  provider: LlmProvider;
  params: CompletionParams;
  tools: ToolDefinition[];
  maxRounds: number;
  nonce: string;
  execute: (call: ToolCall) => Promise<ToolExecution>;
  onToolCall?: (call: ToolCall, execution: ToolExecution, round: number) => Promise<void> | void;
}

export interface ToolLoopResult {
  /** The model's final reply (the one without tool calls) */
  final: ToolCompletionResult;
  usage: { inputTokens: number; outputTokens: number };
  /** Rounds in which at least one tool was requested */
  rounds: number;
  /** Tool calls actually executed */
  executedCalls: number;
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const { provider, params, tools, maxRounds, nonce, execute, onToolCall } = options;
  if (!provider.completeWithTools) {
    throw new Error(`Provider "${provider.name}" does not support tool calling`);
  }

  const turns: ToolTurn[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let executedCalls = 0;

  for (let round = 0; ; round++) {
    const toolsAllowed = round < maxRounds;
    const reply = await provider.completeWithTools({ ...params, tools, toolChoice: toolsAllowed ? 'auto' : 'none', turns });
    usage.inputTokens += reply.inputTokens;
    usage.outputTokens += reply.outputTokens;

    if (reply.toolCalls.length === 0 || !toolsAllowed) {
      if (reply.toolCalls.length > 0) {
        logger.warn({ round, provider: provider.name }, 'Model asked for tools after the last allowed round; ignored');
      }
      return { final: reply, usage, rounds: round, executedCalls };
    }

    const results: ToolResult[] = [];
    for (const [index, call] of reply.toolCalls.entries()) {
      const execution: ToolExecution =
        index < MAX_CALLS_PER_ROUND
          ? await execute(call)
          : {
              outcome: 'error',
              result: {
                callId: call.id,
                name: call.name,
                content: JSON.stringify({ error: 'too_many_calls', message: `At most ${MAX_CALLS_PER_ROUND} tool calls per round.` }),
                isError: true,
              },
            };
      if (index < MAX_CALLS_PER_ROUND) executedCalls++;
      await onToolCall?.(call, execution, round);
      results.push({ ...execution.result, content: wrapUntrusted('TOOL_RESULT', nonce, execution.result.content) });
    }

    turns.push({ role: 'assistant', text: reply.content, toolCalls: reply.toolCalls }, { role: 'tool', results });
  }
}

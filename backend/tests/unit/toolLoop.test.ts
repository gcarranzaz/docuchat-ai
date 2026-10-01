import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '../../src/ai/tools/toolLoop.js';
import { executeTool, toolDefinitions, type ToolExecution } from '../../src/ai/tools/registry.js';
import type {
  LlmProvider,
  ToolCall,
  ToolCompletionParams,
  ToolCompletionResult,
} from '../../src/ai/providers/llmProvider.interface.js';

const NONCE = 'abc123';
const DOC_ID = '11111111-1111-4111-8111-111111111111';

/** A provider whose replies are scripted; records every call it receives */
function scripted(replies: Array<Partial<ToolCompletionResult>>) {
  const calls: ToolCompletionParams[] = [];
  let index = 0;
  const provider = {
    name: 'scripted',
    isConfigured: () => true,
    embed: vi.fn(),
    embedBatch: vi.fn(),
    complete: vi.fn(),
    stream: vi.fn(),
    completeWithTools: async (params: ToolCompletionParams): Promise<ToolCompletionResult> => {
      calls.push(params);
      const reply = replies[Math.min(index++, replies.length - 1)] as Partial<ToolCompletionResult>;
      return { content: '', toolCalls: [], inputTokens: 10, outputTokens: 5, model: 'm', ...reply };
    },
  } as unknown as LlmProvider;
  return { provider, calls };
}

const call = (id: string, args: unknown = { documentId: DOC_ID }): ToolCall => ({ id, name: 'get_document_info', arguments: args });
const okExecution = (c: ToolCall): ToolExecution => ({
  outcome: 'success',
  result: { callId: c.id, name: c.name, content: '{"title":"T"}', isError: false },
});

const base = (provider: LlmProvider, execute: (c: ToolCall) => Promise<ToolExecution>, maxRounds = 2) => ({
  provider,
  params: { systemPrompt: 's', userPrompt: 'u' },
  tools: toolDefinitions(),
  maxRounds,
  nonce: NONCE,
  execute,
});

describe('runToolLoop', () => {
  it('runs the requested tool, feeds the wrapped result back, and returns the final answer with summed usage', async () => {
    const { provider, calls } = scripted([{ toolCalls: [call('c1')] }, { content: 'final answer' }]);
    const execute = vi.fn(async (c: ToolCall) => okExecution(c));

    const result = await runToolLoop(base(provider, execute));

    expect(result.final.content).toBe('final answer');
    expect(result.rounds).toBe(1);
    expect(result.executedCalls).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 }); // both calls are billed
    expect(execute).toHaveBeenCalledTimes(1);

    const second = calls[1] as ToolCompletionParams;
    expect(second.turns).toHaveLength(2); // assistant tool request, tool results
    const toolTurn = second.turns[1] as Extract<(typeof second.turns)[number], { role: 'tool' }>;
    expect(toolTurn.results[0]?.content).toContain(`<<<BEGIN_TOOL_RESULT_${NONCE}>>>`); // untrusted data is delimited
    expect(toolTurn.results[0]?.content).toContain('{"title":"T"}');
  });

  it('stops after the maximum number of rounds: the last call forbids tools and any request in it is ignored', async () => {
    const { provider, calls } = scripted([{ toolCalls: [call('loop')] }]); // asks for a tool every time
    const execute = vi.fn(async (c: ToolCall) => okExecution(c));

    const result = await runToolLoop(base(provider, execute, 2));

    expect(calls.map((c) => c.toolChoice)).toEqual(['auto', 'auto', 'none']);
    expect(calls).toHaveLength(3); // never a fourth
    expect(execute).toHaveBeenCalledTimes(2); // the request made when tools were forbidden is not executed
    expect(result.executedCalls).toBe(2);
    expect(result.rounds).toBe(2);
  });

  it('with zero rounds allowed never offers tools', async () => {
    const { provider, calls } = scripted([{ content: 'direct' }]);
    const execute = vi.fn();
    const result = await runToolLoop(base(provider, execute, 0));
    expect(calls[0]?.toolChoice).toBe('none');
    expect(result.final.content).toBe('direct');
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes at most three calls in a round and answers the rest with an error', async () => {
    const calls5 = [call('1'), call('2'), call('3'), call('4'), call('5')];
    const { provider, calls } = scripted([{ toolCalls: calls5 }, { content: 'done' }]);
    const execute = vi.fn(async (c: ToolCall) => okExecution(c));

    const result = await runToolLoop(base(provider, execute));

    expect(execute).toHaveBeenCalledTimes(3);
    const toolTurn = (calls[1] as ToolCompletionParams).turns[1] as { role: 'tool'; results: Array<{ isError: boolean; content: string }> };
    expect(toolTurn.results).toHaveLength(5); // every call gets an answer, as the APIs require
    expect(toolTurn.results[3]?.isError).toBe(true);
    expect(toolTurn.results[3]?.content).toContain('too_many_calls');
    expect(result.executedCalls).toBe(3);
  });

  it('reports every call to onToolCall, including the refused ones', async () => {
    const { provider } = scripted([{ toolCalls: [call('1'), call('2')] }, { content: 'ok' }]);
    const seen: Array<[string, string, number]> = [];
    await runToolLoop({
      ...base(provider, async (c) => okExecution(c)),
      onToolCall: (c, execution, round) => {
        seen.push([c.id, execution.outcome, round]);
      },
    });
    expect(seen).toEqual([
      ['1', 'success', 0],
      ['2', 'success', 0],
    ]);
  });

  it('refuses a provider that cannot do tool calling', async () => {
    const provider = { name: 'plain' } as unknown as LlmProvider;
    await expect(runToolLoop(base(provider, vi.fn()))).rejects.toThrow(/does not support tool calling/);
  });
});

describe('executeTool (validation happens before anything touches data)', () => {
  const ctx = { userId: 'user-1' };
  const content = (r: { result: { content: string } }) => JSON.parse(r.result.content) as { error: string; message: string };

  it('returns a structured error for an unknown tool instead of throwing', async () => {
    const r = await executeTool({ id: 'x', name: 'delete_everything', arguments: {} }, ctx);
    expect(r.result.isError).toBe(true);
    expect(r.outcome).toBe('error');
    expect(content(r).error).toBe('unknown_tool');
  });

  it.each([
    ['missing id', {}],
    ['not a uuid', { documentId: "'; DROP TABLE documents; --" }],
    ['wrong type', { documentId: 42 }],
    ['extra argument (for example a user id written by the model)', { documentId: DOC_ID, userId: 'someone-else' }],
    ['not JSON at all', undefined],
  ])('rejects invalid arguments (%s) as an error result', async (_label, args) => {
    const r = await executeTool({ id: 'x', name: 'get_document_info', arguments: args }, ctx);
    expect(r.result.isError).toBe(true);
    expect(content(r).error).toBe('invalid_arguments');
    expect(r.resourceId).toBeUndefined();
  });

  it('advertises only read-only tools whose schema forbids extra properties', () => {
    const tools = toolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(['get_document_info']);
    expect(tools[0]?.inputSchema['additionalProperties']).toBe(false);
  });
});

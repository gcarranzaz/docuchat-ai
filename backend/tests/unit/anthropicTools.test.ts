import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../../src/ai/providers/anthropic.provider.js';
import { toolDefinitions } from '../../src/ai/tools/registry.js';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function provider(fetchImpl: unknown) {
  return new AnthropicProvider({ apiKey: 'sk-ant-test', model: 'test-model', fetchImpl: fetchImpl as typeof fetch });
}

const base = { systemPrompt: 'sys', userPrompt: 'question', tools: toolDefinitions() };

describe('AnthropicProvider tool calling', () => {
  it('sends tool definitions and parses tool_use blocks into neutral tool calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_document_info', input: { documentId: 'abc' } },
        ],
        usage: { input_tokens: 30, output_tokens: 12 },
        model: 'test-model',
      })
    );

    const result = await provider(fetchImpl).completeWithTools({ ...base, toolChoice: 'auto', turns: [] });

    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'get_document_info', arguments: { documentId: 'abc' } }]);
    expect(result.content).toBe('Let me check.');
    expect(result.inputTokens).toBe(30);

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body.tools[0]).toMatchObject({ name: 'get_document_info', input_schema: { type: 'object' } });
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.messages).toEqual([{ role: 'user', content: 'question' }]);
  });

  it('maps earlier turns to tool_use and tool_result blocks and can forbid further calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: '{"answer":"x"}' }], usage: { input_tokens: 50, output_tokens: 8 } })
    );

    const result = await provider(fetchImpl).completeWithTools({
      ...base,
      toolChoice: 'none',
      turns: [
        { role: 'assistant', text: '', toolCalls: [{ id: 'toolu_1', name: 'get_document_info', arguments: { documentId: 'abc' } }] },
        { role: 'tool', results: [{ callId: 'toolu_1', name: 'get_document_info', content: '{"error":"not_found"}', isError: true }] },
      ],
    });

    expect(result.toolCalls).toEqual([]);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect(body.tools).toHaveLength(1); // the list stays: the API requires it once tool blocks are in the transcript
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_document_info', input: { documentId: 'abc' } }],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"error":"not_found"}', is_error: true }],
    });
  });
});

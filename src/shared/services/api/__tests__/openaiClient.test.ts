import { describe, expect, it, vi } from 'vitest';
import type { MockedClass } from 'vitest';
import OpenAI from 'openai';
import { OpenAIClient } from '../openaiClient';
import type { CompletionMessage } from '../completionStreamMapper';
import type { StreamChunk, StreamResult } from '../baseClient';
import type { APIDefinition, Message } from '../../../protocol/types';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import { stubApiDeps } from './testStubs';

// Mock OpenAI SDK
vi.mock('openai');

describe('OpenAIClient.extractToolUseBlocks', () => {
  const client = new OpenAIClient(stubApiDeps);

  describe('CompletionMessage format (new)', () => {
    it('should extract tool_use blocks from CompletionMessage with tool_calls', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: 'Let me ping',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        type: 'tool_use',
        id: 'tc_1',
        name: 'ping',
        input: {},
      });
    });

    it('should extract multiple tool_use blocks', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '{}' } },
          {
            id: 'tc_2',
            type: 'function',
            function: { name: 'javascript', arguments: '{"code":"return 42;"}' },
          },
        ],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].name).toBe('ping');
      expect(blocks[1].name).toBe('javascript');
      expect(blocks[1].input).toEqual({ code: 'return 42;' });
    });

    it('should return empty array when no tool_calls', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: 'Hello',
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toEqual([]);
    });

    it('should handle empty tool_calls array', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: 'Hello',
        tool_calls: [],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toEqual([]);
    });
  });

  describe('legacy array format', () => {
    it('should extract tool_use blocks from legacy array format', () => {
      const fullContent = [
        { type: 'text', text: 'Let me ping' },
        {
          type: 'tool_calls',
          tool_calls: [
            { id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '{}' } },
          ],
        },
      ];

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        type: 'tool_use',
        id: 'tc_1',
        name: 'ping',
        input: {},
      });
    });

    it('should return empty array for legacy format without tool_calls block', () => {
      const fullContent = [{ type: 'text', text: 'Hello' }];

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('should return empty array for null fullContent', () => {
      const blocks = client.extractToolUseBlocks(null);
      expect(blocks).toEqual([]);
    });

    it('should return empty array for undefined fullContent', () => {
      const blocks = client.extractToolUseBlocks(undefined);
      expect(blocks).toEqual([]);
    });

    it('should handle empty string arguments', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '' } }],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].input).toEqual({});
    });

    it('drops a call whose arguments were cut off', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '{}' } },
          { id: 'tc_2', type: 'function', function: { name: 'ping', arguments: '{"ho' } },
        ],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks.map(b => b.id)).toEqual(['tc_1']);
    });
  });
});

describe('OpenAIClient stream termination', () => {
  const client = new OpenAIClient({
    ...stubApiDeps,
    storage: { getModel: vi.fn().mockResolvedValue(undefined) } as unknown as UnifiedStorage,
  });

  const apiDefinition: APIDefinition = {
    id: 'test-api-def',
    apiType: 'chatgpt',
    name: 'Test OpenAI',
    baseUrl: '',
    apiKey: 'test-key',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const textChunk = (content: string, finish_reason: string | null = null) => ({
    choices: [{ index: 0, delta: { content }, finish_reason }],
  });

  const runStream = async (chunks: object[]) => {
    const create = vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield* chunks;
      },
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: unknown) {
      return { chat: { completions: { create } } } as unknown as OpenAI;
    });

    const messages: Message<unknown>[] = [
      { id: 'msg1', role: 'user', content: { type: 'text', content: 'Hi' }, timestamp: new Date() },
    ];
    const generator = client.sendMessageStream(messages, 'gpt-5', apiDefinition, {
      temperature: 1,
      maxTokens: 2048,
      enableReasoning: false,
      reasoningBudgetTokens: 0,
      signal: new AbortController().signal,
    });
    let next = await generator.next();
    while (!next.done) next = await generator.next();
    return next.value as StreamResult<CompletionMessage>;
  };

  it('errors on a stream that rendered text but never sent a finish_reason', async () => {
    const result = await runStream([textChunk('Half an ans')]);

    expect(result.error?.message).toBe('Stream ended before a finish_reason arrived');
    expect(result.textContent).toBe('Half an ans');
  });

  it('drops partial tool calls from a cut-off stream', async () => {
    const result = await runStream([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'tc_1',
                  type: 'function',
                  function: { name: 'ping', arguments: '{"ho' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    ]);

    expect(result.error).toBeDefined();
    expect(result.fullContent.tool_calls).toBeUndefined();
  });

  it('maps a length finish to max_tokens', async () => {
    const result = await runStream([textChunk('Half'), textChunk('', 'length')]);

    expect(result.error).toBeUndefined();
    expect(result.stopReason).toBe('max_tokens');
  });
});

describe('OpenAIClient verbosity', () => {
  const mockGetModel = vi.fn();
  const client = new OpenAIClient({
    ...stubApiDeps,
    storage: { getModel: mockGetModel } as unknown as UnifiedStorage,
  });

  const apiDefinition: APIDefinition = {
    id: 'test-api-def',
    apiType: 'chatgpt',
    name: 'Test OpenAI',
    baseUrl: '',
    apiKey: 'test-key',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Drains a non-streaming call and hands back the request params the SDK saw.
  const captureRequest = async (
    model: Record<string, unknown> | undefined,
    verbosity?: 'low' | 'medium' | 'high'
  ) => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValueOnce(model);

    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
      return { chat: { completions: { create } } } as any;
    });

    const messages: Message<any>[] = [
      {
        id: 'msg1',
        role: 'user',
        content: { type: 'text', content: 'Hi' },
        timestamp: new Date(),
      },
    ];

    const generator = client.sendMessageStream(messages, 'gpt-5', apiDefinition, {
      temperature: 1,
      maxTokens: 2048,
      enableReasoning: true,
      reasoningBudgetTokens: 2048,
      signal: new AbortController().signal,
      disableStream: true,
      verbosity,
    });
    for await (const _chunk of generator) {
      // drain
    }

    return create.mock.calls[0][0];
  };

  it('sends verbosity top-level for models that support it', async () => {
    const request = await captureRequest(
      { id: 'gpt-5', apiType: 'chatgpt', supportsVerbosity: true },
      'high'
    );

    expect(request.verbosity).toBe('high');
  });

  it('omits verbosity for models without supportsVerbosity', async () => {
    const request = await captureRequest({ id: 'gpt-4o', apiType: 'chatgpt' }, 'high');

    expect(request.verbosity).toBeUndefined();
  });

  it('omits verbosity when the option is unset', async () => {
    const request = await captureRequest({
      id: 'gpt-5',
      apiType: 'chatgpt',
      supportsVerbosity: true,
    });

    expect(request.verbosity).toBeUndefined();
  });
});

describe('OpenAIClient injected-file content parts', () => {
  const mockGetModel = vi.fn();
  const client = new OpenAIClient({
    ...stubApiDeps,
    storage: { getModel: mockGetModel } as unknown as UnifiedStorage,
  });

  const apiDefinition: APIDefinition = {
    id: 'test-api-def',
    apiType: 'chatgpt',
    name: 'Test OpenAI',
    baseUrl: '',
    apiKey: 'test-key',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const captureUserContent = async (text: string) => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValueOnce({ id: 'gpt-5', apiType: 'chatgpt' });
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
      return { chat: { completions: { create } } } as any;
    });

    const messages: Message<any>[] = [
      {
        id: 'msg1',
        role: 'user',
        content: {
          type: 'text',
          content: text,
          injectedFiles: [{ path: '/f.ts', content: 'const x = 1;' }],
          injectionMode: 'separate-block',
        },
        timestamp: new Date(),
      },
    ];
    const generator = client.sendMessageStream(messages, 'gpt-5', apiDefinition, {
      temperature: 1,
      maxTokens: 2048,
      enableReasoning: true,
      reasoningBudgetTokens: 2048,
      signal: new AbortController().signal,
      disableStream: true,
    });
    for await (const _chunk of generator) {
      // drain
    }
    return create.mock.calls[0][0].messages[0].content as Array<{ type: string; text?: string }>;
  };

  it('emits the file part and the text part for a message with text', async () => {
    const parts = await captureUserContent('analyze');
    expect(parts.map(p => p.text)).toEqual(['=== /f.ts ===\nconst x = 1;', 'analyze']);
  });

  it('skips the empty text part for an inject-only message', async () => {
    const parts = await captureUserContent('');
    expect(parts.map(p => p.text)).toEqual(['=== /f.ts ===\nconst x = 1;']);
  });
});

describe('OpenAIClient non-streaming token usage', () => {
  const mockGetModel = vi.fn();
  const client = new OpenAIClient({
    ...stubApiDeps,
    storage: { getModel: mockGetModel } as unknown as UnifiedStorage,
  });

  const apiDefinition: APIDefinition = {
    id: 'test-api-def',
    apiType: 'chatgpt',
    name: 'Test OpenAI',
    baseUrl: '',
    apiKey: 'test-key',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('subtracts reasoning_tokens out of completion_tokens (disjoint split, no double count)', async () => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValue({ id: 'o3', apiType: 'chatgpt' });

    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 80,
        completion_tokens_details: { reasoning_tokens: 30 },
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: unknown) {
      return { chat: { completions: { create } } } as unknown as OpenAI;
    });

    const messages: Message<unknown>[] = [
      {
        id: 'msg1',
        role: 'user',
        content: { type: 'text', content: 'Hi' },
        timestamp: new Date(),
      },
    ];

    const generator = client.sendMessageStream(messages, 'o3', apiDefinition, {
      temperature: 1,
      maxTokens: 2048,
      enableReasoning: true,
      reasoningBudgetTokens: 2048,
      signal: new AbortController().signal,
      disableStream: true,
    });
    let result: unknown;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }

    expect(result).toMatchObject({
      inputTokens: 60,
      outputTokens: 50,
      reasoningTokens: 30,
      cacheReadTokens: 40,
    });
  });
});

describe('OpenAIClient reasoning round-trip', () => {
  const mockGetModel = vi.fn();
  const client = new OpenAIClient({
    ...stubApiDeps,
    storage: { getModel: mockGetModel } as unknown as UnifiedStorage,
  });

  const apiDefinition: APIDefinition = {
    id: 'test-api-def',
    apiType: 'chatgpt',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /** Drains one non-streaming call, returning both the request and the result. */
  const run = async (
    messages: Message<unknown>[],
    responseMessage: Record<string, unknown>,
    usage?: Record<string, unknown>,
    definitionOverride?: Partial<APIDefinition>,
    {
      modelId = 'deepseek-chat',
      ...optionOverrides
    }: { modelId?: string } & Record<string, unknown> = {}
  ) => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValue({ id: modelId, apiType: 'chatgpt' });

    const create = vi.fn().mockResolvedValue({
      choices: [{ message: responseMessage, finish_reason: 'stop' }],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 5 },
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: unknown) {
      return { chat: { completions: { create } } } as unknown as OpenAI;
    });

    const generator = client.sendMessageStream(
      messages,
      modelId,
      {
        ...apiDefinition,
        ...definitionOverride,
      },
      {
        temperature: 1,
        maxTokens: 2048,
        enableReasoning: true,
        reasoningBudgetTokens: 2048,
        signal: new AbortController().signal,
        disableStream: true,
        ...optionOverrides,
      }
    );

    const chunks: StreamChunk[] = [];
    let result: StreamResult<unknown>;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        result = next.value;
        break;
      }
      chunks.push(next.value);
    }

    return { request: create.mock.calls[0][0], chunks, result };
  };

  const userMsg = (id: string): Message<unknown> => ({
    id,
    role: 'user',
    content: { type: 'text', content: 'Hi' },
    timestamp: new Date(),
  });

  const assistantMsg = (id: string, fullContent: Record<string, unknown>): Message<unknown> => ({
    id,
    role: 'assistant',
    content: { type: 'text', content: 'prev', modelFamily: 'chatgpt', fullContent },
    timestamp: new Date(),
  });

  it('echoes stored reasoning_content back on the next request', async () => {
    const { request } = await run(
      [
        userMsg('u1'),
        assistantMsg('a1', {
          role: 'assistant',
          content: 'prev',
          reasoning_content: 'earlier thinking',
        }),
        userMsg('u2'),
      ],
      { role: 'assistant', content: 'ok' }
    );

    expect(request.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'prev',
      reasoning_content: 'earlier thinking',
    });
  });

  it('echoes reasoning_content alongside tool_calls', async () => {
    const { request } = await run(
      [
        userMsg('u1'),
        assistantMsg('a1', {
          role: 'assistant',
          content: null,
          reasoning_content: 'pick a tool',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } },
          ],
        }),
        userMsg('u2'),
      ],
      { role: 'assistant', content: 'ok' }
    );

    expect(request.messages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'pick a tool',
      tool_calls: [{ id: 'call_1' }],
    });
  });

  it('sends a stored `reasoning` key back as reasoning_content', async () => {
    const { request } = await run(
      [
        userMsg('u1'),
        assistantMsg('a1', { role: 'assistant', content: 'prev', reasoning: 'kimi style' }),
        userMsg('u2'),
      ],
      { role: 'assistant', content: 'ok' }
    );

    expect(request.messages[1]).not.toHaveProperty('reasoning');
    expect(request.messages[1].reasoning_content).toBe('kimi style');
  });

  it('echoes reasoning with the toggle off — earlier turns still reasoned', async () => {
    const { request } = await run(
      [
        userMsg('u1'),
        assistantMsg('a1', { role: 'assistant', content: 'prev', reasoning_content: 'thought' }),
        userMsg('u2'),
      ],
      { role: 'assistant', content: 'ok' },
      undefined,
      undefined,
      { enableReasoning: false }
    );

    expect(request.messages[1].reasoning_content).toBe('thought');
  });

  describe('mandated replay (DeepSeek)', () => {
    const toolTurn = (id: string, extra: Record<string, unknown> = {}) =>
      assistantMsg(id, {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: `call_${id}`, type: 'function', function: { name: 'ping', arguments: '{}' } },
        ],
        ...extra,
      });
    const toolResult = (id: string, callId: string): Message<unknown> => ({
      id,
      role: 'user',
      content: {
        type: 'text',
        content: '',
        modelFamily: 'chatgpt',
        fullContent: [{ type: 'tool_result', tool_call_id: callId, content: 'pong' }],
      },
      timestamp: new Date(),
    });
    const textTurn = (id: string) =>
      assistantMsg(id, { role: 'assistant', content: 'prev', reasoning_content: 'chat thought' });

    // Keep 1 is the in-progress turn only, so every stored turn is prunable
    const history = () => [
      userMsg('u1'),
      toolTurn('a1', { reasoning_content: 'tool thought' }),
      toolResult('r1', 'call_a1'),
      textTurn('a2'),
      userMsg('u2'),
    ];

    it('keeps reasoning on pruned tool-call turns and strips it elsewhere', async () => {
      const { request } = await run(
        history(),
        { role: 'assistant', content: 'ok' },
        undefined,
        undefined,
        { pruneThinkingKeepTurns: 1 }
      );

      const assistants = request.messages.filter((m: { role: string }) => m.role === 'assistant');
      expect(assistants[0]).toMatchObject({ reasoning_content: 'tool thought' });
      expect(assistants[1]).not.toHaveProperty('reasoning_content');
    });

    it('strips everything before the boundary for a model without the mandate', async () => {
      const { request } = await run(
        history(),
        { role: 'assistant', content: 'ok' },
        undefined,
        undefined,
        { modelId: 'glm-5.2', pruneThinkingKeepTurns: 1 }
      );

      const assistants = request.messages.filter((m: { role: string }) => m.role === 'assistant');
      expect(assistants[0]).not.toHaveProperty('reasoning_content');
      expect(assistants[1]).not.toHaveProperty('reasoning_content');
    });

    it('gives a tool-call turn without reasoning an empty placeholder', async () => {
      const { request } = await run([userMsg('u1'), toolTurn('a1'), toolResult('r1', 'call_a1')], {
        role: 'assistant',
        content: 'ok',
      });

      expect(request.messages[1]).toMatchObject({
        reasoning_content: '',
        tool_calls: [{ id: 'call_a1' }],
      });
    });

    it("gives another provider's tool-call turn the placeholder", async () => {
      const { request } = await run(
        [
          userMsg('u1'),
          {
            id: 'a1',
            role: 'assistant',
            content: {
              type: 'text',
              content: '',
              modelFamily: 'anthropic',
              toolCalls: [{ type: 'tool_use', id: 'toolu_1', name: 'ping', input: {} }],
            },
            timestamp: new Date(),
          },
        ],
        { role: 'assistant', content: 'ok' }
      );

      expect(request.messages[1]).toMatchObject({
        reasoning_content: '',
        tool_calls: [{ id: 'toolu_1' }],
      });
    });

    it('adds no placeholder to a turn without tool calls, or for other models', async () => {
      const plain = await run(
        [userMsg('u1'), assistantMsg('a1', { role: 'assistant', content: 'prev' }), userMsg('u2')],
        { role: 'assistant', content: 'ok' }
      );
      expect(plain.request.messages[1]).not.toHaveProperty('reasoning_content');

      const glm = await run(
        [userMsg('u1'), toolTurn('a1'), toolResult('r1', 'call_a1')],
        { role: 'assistant', content: 'ok' },
        undefined,
        undefined,
        { modelId: 'glm-5.2' }
      );
      expect(glm.request.messages[1]).not.toHaveProperty('reasoning_content');
    });
  });

  describe('reasoning_details (OpenRouter dialect)', () => {
    const openRouter: Partial<APIDefinition> = {
      advancedSettings: { reasoningDialect: 'openrouter' },
    };

    const details = [
      {
        type: 'reasoning.text',
        index: 0,
        id: 'r-1',
        format: 'anthropic-claude-v1',
        text: 'earlier thinking',
        signature: 'sig-abc',
        future_field: { nested: 1 },
      },
    ];

    it('echoes the stored array back verbatim, unknown fields included', async () => {
      const { request } = await run(
        [
          userMsg('u1'),
          assistantMsg('a1', {
            role: 'assistant',
            content: 'prev',
            reasoning_details: details,
          }),
          userMsg('u2'),
        ],
        { role: 'assistant', content: 'ok' },
        undefined,
        openRouter
      );

      expect(request.messages[1].reasoning_details).toEqual(details);
    });

    it('echoes alongside tool_calls', async () => {
      const { request } = await run(
        [
          userMsg('u1'),
          assistantMsg('a1', {
            role: 'assistant',
            content: null,
            reasoning_details: details,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } },
            ],
          }),
          userMsg('u2'),
        ],
        { role: 'assistant', content: 'ok' },
        undefined,
        openRouter
      );

      expect(request.messages[1]).toMatchObject({
        reasoning_details: details,
        tool_calls: [{ id: 'call_1' }],
      });
    });

    it('displaces reasoning_content rather than sending both', async () => {
      const { request } = await run(
        [
          userMsg('u1'),
          assistantMsg('a1', {
            role: 'assistant',
            content: 'prev',
            reasoning_content: 'unsigned mirror',
            reasoning_details: details,
          }),
          userMsg('u2'),
        ],
        { role: 'assistant', content: 'ok' },
        undefined,
        openRouter
      );

      expect(request.messages[1].reasoning_details).toEqual(details);
      expect(request.messages[1]).not.toHaveProperty('reasoning_content');
    });

    it('falls back to reasoning_content when the turn carried no details', async () => {
      const { request } = await run(
        [
          userMsg('u1'),
          assistantMsg('a1', {
            role: 'assistant',
            content: 'prev',
            reasoning_content: 'deepseek style',
          }),
          userMsg('u2'),
        ],
        { role: 'assistant', content: 'ok' },
        undefined,
        openRouter
      );

      expect(request.messages[1].reasoning_content).toBe('deepseek style');
    });

    it('does not echo details under any other dialect', async () => {
      const { request } = await run(
        [
          userMsg('u1'),
          assistantMsg('a1', {
            role: 'assistant',
            content: 'prev',
            reasoning_details: details,
          }),
          userMsg('u2'),
        ],
        { role: 'assistant', content: 'ok' }
      );

      expect(request.messages[1]).not.toHaveProperty('reasoning_details');
    });

    it('reports CoT for an encrypted-only turn that renders nothing', async () => {
      const { result } = await run(
        [userMsg('u1')],
        {
          role: 'assistant',
          content: 'ok',
          reasoning_details: [{ type: 'reasoning.encrypted', index: 0, data: 'AAAA' }],
        },
        undefined,
        openRouter
      );

      expect(result.hasCoT).toBe(true);
    });
  });

  it('renders reasoning_content from a non-streaming response and reports CoT', async () => {
    const { chunks, result } = await run([userMsg('u1')], {
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'because X',
    });

    expect(chunks.slice(0, 3)).toEqual([
      { type: 'thinking.start' },
      { type: 'thinking', content: 'because X' },
      { type: 'thinking.end' },
    ]);
    expect(result.hasCoT).toBe(true);
    expect((result.fullContent as { reasoning_content?: string }).reasoning_content).toBe(
      'because X'
    );
  });

  it('reports no CoT when the response carries neither reasoning text nor tokens', async () => {
    const { result } = await run([userMsg('u1')], { role: 'assistant', content: 'answer' });

    expect(result.hasCoT).toBeFalsy();
  });
});

describe('OpenAIClient served model', () => {
  const mockGetModel = vi.fn();
  const client = new OpenAIClient({
    ...stubApiDeps,
    storage: { getModel: mockGetModel } as unknown as UnifiedStorage,
  });

  const apiDefinition: APIDefinition = {
    id: 'test-api-def',
    apiType: 'chatgpt',
    name: 'Test OpenAI',
    baseUrl: '',
    apiKey: 'test-key',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const messages: Message<unknown>[] = [
    {
      id: 'msg1',
      role: 'user',
      content: { type: 'text', content: 'Hi' },
      timestamp: new Date(),
    },
  ];

  const drain = async (disableStream: boolean) => {
    const generator = client.sendMessageStream(messages, 'gpt-5', apiDefinition, {
      temperature: 1,
      maxTokens: 2048,
      enableReasoning: false,
      reasoningBudgetTokens: 0,
      signal: new AbortController().signal,
      disableStream,
    });
    while (true) {
      const next = await generator.next();
      if (next.done) return next.value as StreamResult<unknown>;
    }
  };

  it('reports the response model, not the requested alias, on the non-streaming path', async () => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValue({ id: 'gpt-5', apiType: 'chatgpt' });
    const create = vi.fn().mockResolvedValue({
      model: 'gpt-5-2026-08-01',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: unknown) {
      return { chat: { completions: { create } } } as unknown as OpenAI;
    });

    const result = await drain(true);

    expect(result.servedModel).toBe('gpt-5-2026-08-01');
  });

  it('reports the response model from streamed chunks', async () => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValue({ id: 'gpt-5', apiType: 'chatgpt' });
    const streamChunks = [
      { model: 'gpt-5-2026-08-01', choices: [{ index: 0, delta: { content: 'ok' } }] },
      {
        model: 'gpt-5-2026-08-01',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ];
    const create = vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of streamChunks) yield chunk;
      },
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: unknown) {
      return { chat: { completions: { create } } } as unknown as OpenAI;
    });

    const result = await drain(false);

    expect(result.servedModel).toBe('gpt-5-2026-08-01');
  });
});

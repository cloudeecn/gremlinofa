import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runAgenticLoop,
  collectAgenticLoop,
  createTokenTotals,
  addTokens,
  createToolResultRenderBlock,
  extractHookHistory,
  type AgenticLoopOptions,
  type AgenticLoopEvent,
  type AgenticLoopResult,
  type TokenTotals,
} from '../agenticLoopGenerator';
import type { APIDefinition, Message, Model, ToolUseBlock } from '../../../types';

// Mock dependencies
vi.mock('../../api/apiService', () => ({
  apiService: {
    sendMessageStream: vi.fn(),
    extractToolUseBlocks: vi.fn(),
    mapStopReason: vi.fn((_, reason) => reason || 'end_turn'),
    shouldPrependPrefill: vi.fn(() => false),
  },
}));

vi.mock('../../api/modelMetadata', () => ({
  calculateCost: vi.fn(() => 0.001),
  isCostUnreliable: vi.fn(() => false),
}));

vi.mock('../../storage', () => ({
  storage: {
    getAttachments: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('../../streaming/StreamingContentAssembler', () => {
  return {
    StreamingContentAssembler: class MockStreamingContentAssembler {
      pushChunk() {}
      getGroups() {
        return [{ category: 'text', blocks: [{ type: 'text', text: 'test' }] }];
      }
      finalize() {
        return [{ category: 'text', blocks: [{ type: 'text', text: 'test' }] }];
      }
      finalizeWithError(err: { message: string }) {
        return [{ category: 'error', blocks: [{ type: 'error', message: err.message }] }];
      }
    },
  };
});

/** Helper to create a mock async generator that returns a ToolResult */
async function* mockToolGenerator(
  result: unknown
): AsyncGenerator<import('../../../types').ToolStreamEvent, import('../../../types').ToolResult> {
  return result as import('../../../types').ToolResult;
}

vi.mock('../../tools/clientSideTools', () => ({
  executeClientSideTool: vi.fn(),
  toolRegistry: {
    get: vi.fn((name: string) => ({
      iconInput: '🔧',
      iconOutput: '✅',
      renderInput: undefined,
      renderOutput: undefined,
      complex: name === 'minion',
    })),
  },
}));

vi.mock('../../tools/jsTool', () => ({
  configureJsTool: vi.fn(),
}));

vi.mock('../../../utils/idGenerator', () => ({
  generateUniqueId: vi.fn(prefix => `${prefix}_test123`),
}));

const mockHookRuntime = {
  run: vi.fn(),
  dispose: vi.fn(),
};
vi.mock('../dummyHookRuntime', () => ({
  DummyHookRuntime: {
    load: vi.fn(() => Promise.resolve(mockHookRuntime)),
  },
}));

import { apiService } from '../../api/apiService';
import { executeClientSideTool } from '../../tools/clientSideTools';

// Module-level state for multi-iteration mock (avoids closure issues)
const mockState = {
  streams: [] as AsyncGenerator[],
  extracts: [] as unknown[][],
  streamIdx: 0,
  extractIdx: 0,
};

function resetMockState() {
  mockState.streams = [];
  mockState.extracts = [];
  mockState.streamIdx = 0;
  mockState.extractIdx = 0;
}

function setupMultiIterationMock(streams: AsyncGenerator[], extracts: unknown[][]) {
  mockState.streams = streams;
  mockState.extracts = extracts;
  mockState.streamIdx = 0;
  mockState.extractIdx = 0;

  vi.mocked(apiService.sendMessageStream).mockImplementation(() => {
    const idx = mockState.streamIdx;
    if (mockState.streamIdx < mockState.streams.length - 1) {
      mockState.streamIdx++;
    }
    return mockState.streams[idx] as never;
  });

  // extractToolUseBlocks is called multiple times per iteration with the same fullContent
  // (buildAssistantMessage, mergeToolUseInputFromFullContent, and the main loop check).
  // The extracts array maps 1:1 with streams — one entry per iteration.
  // Advance the index only when a new (different) fullContent is seen.
  let lastFullContent: unknown;
  vi.mocked(apiService.extractToolUseBlocks).mockImplementation((_apiType, fullContent) => {
    if (fullContent !== lastFullContent) {
      if (lastFullContent !== undefined) {
        if (mockState.extractIdx < mockState.extracts.length - 1) {
          mockState.extractIdx++;
        }
      }
      lastFullContent = fullContent;
    }
    return (mockState.extracts[mockState.extractIdx] ?? []) as ToolUseBlock[];
  });
}

// Test fixtures
const createMockApiDef = (): APIDefinition => ({
  id: 'api_test',
  apiType: 'anthropic',
  name: 'Test API',
  baseUrl: '',
  apiKey: 'test-key',
  createdAt: new Date(),
  updatedAt: new Date(),
});

const createMockModel = (): Model => ({
  id: 'claude-3-opus',
  name: 'Claude 3 Opus',
  apiType: 'anthropic',
  contextWindow: 200000,
  inputPrice: 15,
  outputPrice: 75,
});

const createMockOptions = (overrides?: Partial<AgenticLoopOptions>): AgenticLoopOptions => ({
  apiDef: createMockApiDef(),
  model: createMockModel(),
  projectId: 'proj_test',
  chatId: 'chat_test',
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt: 'You are a helpful assistant.',
  webSearchEnabled: false,
  enabledTools: [],
  toolOptions: {},
  disableStream: false,
  extendedContext: false,
  enableReasoning: false,
  reasoningBudgetTokens: 0,
  ...overrides,
});

const createMockUserMessage = (content: string): Message<unknown> => ({
  id: 'msg_user_test',
  role: 'user',
  content: {
    type: 'text',
    content,
  },
  timestamp: new Date(),
});

// Helper to create async generator from chunks
async function* createMockStream(
  chunks: Array<{ type: string; content?: string }>,
  finalResult: unknown
): AsyncGenerator<unknown, unknown, unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
  return finalResult;
}

describe('agenticLoopGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Only clear mocks, don't reset implementations (which can interfere with async tests)
    vi.clearAllMocks();
  });

  describe('createTokenTotals', () => {
    it('creates zero-initialized token totals', () => {
      const totals = createTokenTotals();

      expect(totals).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        webSearchCount: 0,
        cost: 0,
        costUnreliable: false,
      });
    });
  });

  describe('addTokens', () => {
    it('adds source tokens to target', () => {
      const target: TokenTotals = {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cacheCreationTokens: 5,
        cacheReadTokens: 20,
        webSearchCount: 1,
        cost: 0.01,
        costUnreliable: false,
      };

      const source: TokenTotals = {
        inputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 20,
        cacheCreationTokens: 10,
        cacheReadTokens: 40,
        webSearchCount: 2,
        cost: 0.02,
        costUnreliable: false,
      };

      addTokens(target, source);

      expect(target).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        reasoningTokens: 30,
        cacheCreationTokens: 15,
        cacheReadTokens: 60,
        webSearchCount: 3,
        cost: 0.03,
        costUnreliable: false,
      });
    });

    it('propagates costUnreliable flag', () => {
      const target = createTokenTotals();
      const source: TokenTotals = { ...createTokenTotals(), costUnreliable: true };

      addTokens(target, source);

      expect(target.costUnreliable).toBe(true);
    });

    it('preserves existing costUnreliable flag', () => {
      const target: TokenTotals = { ...createTokenTotals(), costUnreliable: true };
      const source = createTokenTotals();

      addTokens(target, source);

      expect(target.costUnreliable).toBe(true);
    });
  });

  describe('runAgenticLoop', () => {
    it('yields streaming events and returns complete result for simple response', async () => {
      const mockResult = {
        textContent: 'Hello!',
        fullContent: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([{ type: 'content', content: 'Hello!' }], mockResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions();
      const context = [createMockUserMessage('Hi')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);

      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) {
          events.push(result.value);
        }
      } while (!result.done);

      // Verify event sequence
      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain('streaming_start');
      expect(eventTypes).toContain('first_chunk');
      expect(eventTypes).toContain('streaming_chunk');
      expect(eventTypes).toContain('streaming_end');
      expect(eventTypes).toContain('message_created');
      expect(eventTypes).toContain('tokens_consumed');

      // Verify final result
      expect(result.value.status).toBe('complete');
      expect(result.value.messages).toHaveLength(2); // user + assistant
      expect(result.value.tokens.inputTokens).toBe(100);
      expect(result.value.tokens.outputTokens).toBe(50);
    });

    it('executes tools when stopReason is tool_use', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      // Use mockReturnValue instead of mockImplementation with counter
      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([{ type: 'content', content: '' }], toolUseResult) as never
      );

      // Return tool blocks on all calls - the loop will get suspended anyway
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue(toolUseBlocks);

      // Use breakLoop to exit after tool execution - mockImplementation for fresh generator each call
      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Files listed successfully',
          isError: false,
          breakLoop: { returnValue: 'tool executed' },
        })
      );

      const options = createMockOptions({ enabledTools: ['memory'] });
      const context = [createMockUserMessage('List files')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      expect(executeClientSideTool).toHaveBeenCalledWith(
        'memory',
        { command: 'view', path: '/' },
        ['memory'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('tool executed');
      }
    });

    it('handles tool completion via breakLoop with return value', async () => {
      const toolUseResult = {
        textContent: '',
        fullContent: [
          { type: 'tool_use', id: 'toolu_1', name: 'return', input: { value: 'final answer' } },
        ],
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([{ type: 'content', content: '' }], toolUseResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([
        { type: 'tool_use', id: 'toolu_1', name: 'return', input: { value: 'final answer' } },
      ]);

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Returning value',
          breakLoop: { returnValue: 'final answer' },
        })
      );

      const options = createMockOptions({ enabledTools: ['return'] });
      const context = [createMockUserMessage('Calculate')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('final answer');
      }
    });

    it('handles stream errors gracefully', async () => {
      const errorResult = {
        textContent: '',
        fullContent: [],
        stopReason: 'error',
        inputTokens: 0,
        outputTokens: 0,
        error: { message: 'API rate limit exceeded', status: 429 },
      };

      const mockStream = createMockStream([], errorResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions();
      const context = [createMockUserMessage('Hi')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error.message).toBe('API rate limit exceeded');
      }
      // Error message should be created with error rendering content
      const assistantMsg = result.messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.content.stopReason).toBe('error');
    });

    it('returns error status when exception is thrown', async () => {
      vi.mocked(apiService.sendMessageStream).mockImplementation(() => {
        throw new Error('Network failure');
      });

      const options = createMockOptions();
      const context = [createMockUserMessage('Hi')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error.message).toBe('Network failure');
      }
    });

    it('does not mutate the input context array', async () => {
      const mockResult = {
        textContent: 'Hello!',
        fullContent: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([{ type: 'content', content: 'Hello!' }], mockResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions();
      const context = [createMockUserMessage('Hi')];
      const originalLength = context.length;

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      // Original array should not be mutated
      expect(context).toHaveLength(originalLength);
      // Result should have more messages
      expect(result.messages.length).toBeGreaterThan(originalLength);
    });

    it('tracks tokens from single iteration', async () => {
      const mockResult = {
        textContent: 'Response',
        fullContent: [{ type: 'text', text: 'Response' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([], mockResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions();
      const context = [createMockUserMessage('Test')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      expect(result.tokens.inputTokens).toBe(100);
      expect(result.tokens.outputTokens).toBe(50);
      expect(result.tokens.cost).toBeGreaterThan(0); // calculateCost mock returns 0.001
    });
  });

  describe('collectAgenticLoop', () => {
    it('consumes generator and returns final result', async () => {
      const mockResult = {
        textContent: 'Hello!',
        fullContent: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([{ type: 'content', content: 'Hello!' }], mockResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions();
      const context = [createMockUserMessage('Hi')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      expect(result.messages).toBeDefined();
      expect(result.tokens).toBeDefined();
    });
  });

  describe('multi-iteration scenarios (stateful mock)', () => {
    beforeEach(() => {
      resetMockState();
    });

    it('handles tool_use → tool_result → final response (2 iterations)', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Done!',
        fullContent: [{ type: 'text', text: 'Done!' }],
        stopReason: 'end_turn',
        inputTokens: 150,
        outputTokens: 75,
      };

      // extractToolUseBlocks is called multiple times per iteration with the same fullContent.
      // The mock deduplicates repeated calls with identical fullContent.
      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []] // iter1: tool blocks, iter2: empty
      );

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Files listed successfully',
          isError: false,
        })
      );

      const options = createMockOptions({ enabledTools: ['memory'] });
      const context = [createMockUserMessage('List files')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      expect(executeClientSideTool).toHaveBeenCalledWith(
        'memory',
        { command: 'view', path: '/' },
        ['memory'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );
      // user + assistant (tool_use) + tool_result + assistant (final) = 4 messages
      expect(result.messages).toHaveLength(4);
    });

    it('accumulates tokens across multiple iterations', async () => {
      const toolUseBlocks = [{ type: 'tool_use' as const, id: 'toolu_1', name: 'test', input: {} }];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Done!',
        fullContent: [{ type: 'text', text: 'Done!' }],
        stopReason: 'end_turn',
        inputTokens: 150,
        outputTokens: 75,
      };

      // extractToolUseBlocks called multiple times per iteration — deduped by fullContent
      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []] // iter1: tool blocks, iter2: empty
      );

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Done',
          isError: false,
        })
      );

      const options = createMockOptions({ enabledTools: ['test'] });
      const context = [createMockUserMessage('Test')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      // 100 + 150 = 250 input tokens
      expect(result.tokens.inputTokens).toBe(250);
      // 50 + 75 = 125 output tokens
      expect(result.tokens.outputTokens).toBe(125);
      // Cost calculated twice (once per iteration)
      expect(result.tokens.cost).toBe(0.002);
    });

    it('handles multiple tool calls in sequence (3 iterations)', async () => {
      const tool1Blocks = [
        { type: 'tool_use' as const, id: 'toolu_1', name: 'read', input: { path: '/a' } },
      ];
      const tool2Blocks = [
        { type: 'tool_use' as const, id: 'toolu_2', name: 'write', input: { path: '/b' } },
      ];

      const tool1Result = {
        textContent: '',
        fullContent: tool1Blocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 30,
      };

      const tool2Result = {
        textContent: '',
        fullContent: tool2Blocks,
        stopReason: 'tool_use',
        inputTokens: 120,
        outputTokens: 40,
      };

      const finalResult = {
        textContent: 'All done!',
        fullContent: [{ type: 'text', text: 'All done!' }],
        stopReason: 'end_turn',
        inputTokens: 140,
        outputTokens: 50,
      };

      // extractToolUseBlocks called multiple times per iteration — deduped by fullContent
      setupMultiIterationMock(
        [
          createMockStream([], tool1Result),
          createMockStream([], tool2Result),
          createMockStream([], finalResult),
        ],
        [tool1Blocks, tool2Blocks, []] // one entry per distinct fullContent
      );

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Tool executed',
          isError: false,
        })
      );

      const options = createMockOptions({ enabledTools: ['read', 'write'] });
      const context = [createMockUserMessage('Do multiple tasks')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      expect(executeClientSideTool).toHaveBeenCalledTimes(2);
      expect(executeClientSideTool).toHaveBeenNthCalledWith(
        1,
        'read',
        { path: '/a' },
        ['read', 'write'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );
      expect(executeClientSideTool).toHaveBeenNthCalledWith(
        2,
        'write',
        { path: '/b' },
        ['read', 'write'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );
      // 100 + 120 + 140 = 360 input tokens
      expect(result.tokens.inputTokens).toBe(360);
      // 30 + 40 + 50 = 120 output tokens
      expect(result.tokens.outputTokens).toBe(120);
      // user + (assistant + tool_result) × 2 + assistant = 6 messages
      expect(result.messages).toHaveLength(6);
    });

    it('executes multiple tools in parallel and collects results in order', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/a' },
        },
        {
          type: 'tool_use' as const,
          id: 'toolu_2',
          name: 'javascript',
          input: { code: '1+1' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Done!',
        fullContent: [{ type: 'text', text: 'Done!' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []]
      );

      // Track call order to verify both tools are called
      const callOrder: string[] = [];
      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        callOrder.push(name);
        return mockToolGenerator({
          content: `Result from ${name}`,
          isError: false,
        });
      });

      const options = createMockOptions({ enabledTools: ['memory', 'javascript'] });
      const context = [createMockUserMessage('Do both')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      // Both tools should have been called
      expect(executeClientSideTool).toHaveBeenCalledTimes(2);
      expect(callOrder).toContain('memory');
      expect(callOrder).toContain('javascript');

      // All tools should get 'running' status before any completion
      const blockUpdates = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'tool_block_update' }> =>
          e.type === 'tool_block_update'
      );
      const runningUpdates = blockUpdates.filter(e => e.block.status === 'running');
      expect(runningUpdates.length).toBeGreaterThanOrEqual(2);

      // Both tool IDs should have running status
      const runningIds = runningUpdates.map(e => e.toolUseId);
      expect(runningIds).toContain('toolu_1');
      expect(runningIds).toContain('toolu_2');

      expect(result.value.status).toBe('complete');
    });

    it('sends error result for return tool when called in parallel — other tools still execute', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
        { type: 'tool_use' as const, id: 'toolu_2', name: 'return', input: { result: 'done' } },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Retrying return',
        fullContent: [{ type: 'text', text: 'Retrying return' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []]
      );

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        return mockToolGenerator({ content: `Result from ${name}`, isError: false });
      });

      const options = createMockOptions({ enabledTools: ['return', 'memory'] });
      const context = [createMockUserMessage('Do both')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      // Only memory tool executed (return tool gets error, not executed)
      expect(executeClientSideTool).toHaveBeenCalledTimes(1);
      expect(executeClientSideTool).toHaveBeenCalledWith(
        'memory',
        { command: 'view', path: '/' },
        ['return', 'memory'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );

      // Loop continues (no breakLoop) — LLM gets error for return and can retry
      expect(result.value.status).toBe('complete');

      // Return tool gets an error block update
      const blockUpdates = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'tool_block_update' }> =>
          e.type === 'tool_block_update'
      );
      const returnErrorBlock = blockUpdates.find(
        e => e.toolUseId === 'toolu_2' && e.block.status === 'error'
      );
      expect(returnErrorBlock).toBeDefined();

      // tool_result message IS saved (both return error + memory result)
      const messageCreated = events.filter(e => e.type === 'message_created');
      // assistant + tool_result + final assistant = 3
      expect(messageCreated.length).toBe(3);
    });

    it('deferred return works in parallel — both tools execute, value stored', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
        { type: 'tool_use' as const, id: 'toolu_2', name: 'return', input: { result: 'done' } },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Finished',
        fullContent: [{ type: 'text', text: 'Finished' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []]
      );

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'done',
            breakLoop: { returnValue: 'done' },
          });
        }
        return mockToolGenerator({ content: `Result from ${name}`, isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('Do both')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      // Both tools should execute (return + memory)
      expect(executeClientSideTool).toHaveBeenCalledTimes(2);
      expect(executeClientSideTool).toHaveBeenCalledWith(
        'return',
        { result: 'done' },
        ['return', 'memory'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );
      expect(executeClientSideTool).toHaveBeenCalledWith(
        'memory',
        { command: 'view', path: '/' },
        ['return', 'memory'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );

      // Loop continues (deferred, no breakLoop) — LLM sees "Recorded" for return + memory result
      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('done');
      }

      // Two API calls — loop continued after deferred return
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(2);

      // Return tool gets a 'complete' block update (not error)
      const blockUpdates = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'tool_block_update' }> =>
          e.type === 'tool_block_update'
      );
      const returnBlock = blockUpdates.find(
        e => e.toolUseId === 'toolu_2' && e.block.status === 'complete'
      );
      expect(returnBlock).toBeDefined();
    });

    it('recovers tool_use blocks missing from renderingContent using fullContent', async () => {
      // The mock assembler returns only text blocks (no tool_use).
      // mergeToolUseInputFromFullContent should recover the missing tool_use blocks
      // from fullContent into renderingContent.
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
        { type: 'tool_use' as const, id: 'toolu_2', name: 'return', input: { result: 'val' } },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []]
      );

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({ content: 'val', breakLoop: { returnValue: 'val' } });
        }
        return mockToolGenerator({ content: 'ok', isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('Go')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      // Find the first assistant message (from the tool_use iteration)
      const assistantMsgs = events
        .filter(
          (e): e is Extract<AgenticLoopEvent, { type: 'message_created' }> =>
            e.type === 'message_created' && e.message.role === 'assistant'
        )
        .map(e => e.message);
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

      const firstAssistant = assistantMsgs[0];
      const rendering = firstAssistant.content
        .renderingContent as import('../../../types/content').RenderingBlockGroup[];

      // The mock assembler produces only a text group — the fix should have added
      // a backstage group with the two recovered tool_use blocks
      const backstageBlocks = rendering
        .filter(g => g.category === 'backstage')
        .flatMap(g => g.blocks)
        .filter(b => b.type === 'tool_use');

      expect(backstageBlocks).toHaveLength(2);
      expect(
        backstageBlocks.map(b => (b as import('../../../types/content').ToolUseRenderBlock).id)
      ).toEqual(expect.arrayContaining(['toolu_1', 'toolu_2']));
    });

    it('handles one tool error alongside a successful tool', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/a' },
        },
        {
          type: 'tool_use' as const,
          id: 'toolu_2',
          name: 'javascript',
          input: { code: 'throw new Error("boom")' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Handled',
        fullContent: [{ type: 'text', text: 'Handled' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []]
      );

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'javascript') {
          return mockToolGenerator({ content: 'Error: boom', isError: true });
        }
        return mockToolGenerator({ content: 'Files listed', isError: false });
      });

      const options = createMockOptions({ enabledTools: ['memory', 'javascript'] });
      const context = [createMockUserMessage('Do both')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      // Both tools executed
      expect(executeClientSideTool).toHaveBeenCalledTimes(2);

      // Both tools should have completion block updates
      const blockUpdates = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'tool_block_update' }> =>
          e.type === 'tool_block_update'
      );

      // Find completion blocks (not 'running' status)
      const completionBlocks = blockUpdates.filter(
        e => e.block.status === 'complete' || e.block.status === 'error'
      );
      expect(completionBlocks).toHaveLength(2);

      const errorBlock = completionBlocks.find(e => e.block.status === 'error');
      const successBlock = completionBlocks.find(e => e.block.status === 'complete');
      expect(errorBlock?.toolUseId).toBe('toolu_2');
      expect(successBlock?.toolUseId).toBe('toolu_1');

      // Loop continues after tool error
      expect(result.value.status).toBe('complete');
    });

    it('interleaves streaming events from parallel tools', async () => {
      const toolUseBlocks = [
        { type: 'tool_use' as const, id: 'toolu_1', name: 'minion_a', input: { message: 'a' } },
        { type: 'tool_use' as const, id: 'toolu_2', name: 'minion_b', input: { message: 'b' } },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], toolUseResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue(toolUseBlocks);

      // Create generators that yield streaming events before completing
      const streamingGroups = [
        { category: 'text' as const, blocks: [{ type: 'text' as const, text: 'progress' }] },
      ];

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        async function* gen(): AsyncGenerator<
          import('../../../types').ToolStreamEvent,
          import('../../../types').ToolResult
        > {
          yield { type: 'groups_update', groups: streamingGroups };
          return { content: `Done ${name}`, isError: false, breakLoop: { returnValue: 'stop' } };
        }
        return gen();
      });

      const options = createMockOptions({ enabledTools: ['minion_a', 'minion_b'] });
      const context = [createMockUserMessage('Do both')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      const blockUpdates = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'tool_block_update' }> =>
          e.type === 'tool_block_update'
      );

      // Should have: 2 running + 2 streaming (groups_update) + 2 completion = 6 block updates
      expect(blockUpdates.length).toBe(6);

      // Streaming events should carry renderingGroups
      const streamingUpdates = blockUpdates.filter(
        e => e.block.renderingGroups && e.block.status === 'running'
      );
      expect(streamingUpdates).toHaveLength(2);
      expect(streamingUpdates.map(e => e.toolUseId).sort()).toEqual(['toolu_1', 'toolu_2']);
    });

    it('executes simple tools before complex tools (phased execution)', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
        {
          type: 'tool_use' as const,
          id: 'toolu_2',
          name: 'minion',
          input: { message: 'do something' },
        },
        {
          type: 'tool_use' as const,
          id: 'toolu_3',
          name: 'javascript',
          input: { code: '1+1' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Done!',
        fullContent: [{ type: 'text', text: 'Done!' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []]
      );

      // Track execution order across phases
      const executionOrder: string[] = [];
      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        executionOrder.push(name);
        return mockToolGenerator({
          content: `Result from ${name}`,
          isError: false,
        });
      });

      const options = createMockOptions({ enabledTools: ['memory', 'minion', 'javascript'] });
      const context = [createMockUserMessage('Do all three')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      // All three tools should execute
      expect(executeClientSideTool).toHaveBeenCalledTimes(3);

      // Simple tools (memory, javascript) run before complex (minion)
      const minionIndex = executionOrder.indexOf('minion');
      const memoryIndex = executionOrder.indexOf('memory');
      const jsIndex = executionOrder.indexOf('javascript');
      expect(memoryIndex).toBeLessThan(minionIndex);
      expect(jsIndex).toBeLessThan(minionIndex);

      // All tools get running/completion block updates
      const blockUpdates = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'tool_block_update' }> =>
          e.type === 'tool_block_update'
      );
      const completionBlocks = blockUpdates.filter(
        e => e.block.status === 'complete' || e.block.status === 'error'
      );
      expect(completionBlocks).toHaveLength(3);

      expect(result.value.status).toBe('complete');
    });

    it('skips tool_result message when single return tool triggers breakLoop', async () => {
      const toolUseBlocks = [
        { type: 'tool_use' as const, id: 'toolu_1', name: 'return', input: { result: 'answer' } },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], toolUseResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue(toolUseBlocks);

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'answer',
          breakLoop: { returnValue: 'answer' },
        })
      );

      const options = createMockOptions({ enabledTools: ['return'] });
      const context = [createMockUserMessage('Finish up')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('answer');
      }

      // No tool_result message saved — breakLoop skips it
      const msgCreatedEvents = events.filter(e => e.type === 'message_created');
      // Only assistant message
      expect(msgCreatedEvents.length).toBe(1);

      // messages: user + assistant = 2 (no tool_result)
      expect(result.value.messages).toHaveLength(2);
    });

    it('deferred return: solo return stores value and loop continues', async () => {
      // Iteration 1: return tool called → deferred, continues
      // Iteration 2: normal end_turn response
      const returnToolBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_ret',
          name: 'return',
          input: { result: 'answer42' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: returnToolBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Cleanup done',
        fullContent: [{ type: 'text', text: 'Cleanup done' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [returnToolBlocks, []]
      );

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'answer42',
          breakLoop: { returnValue: 'answer42' },
        })
      );

      const options = createMockOptions({
        enabledTools: ['return'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('Do task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('answer42');
      }

      // Should have TWO API calls (loop didn't break after return tool)
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(2);

      // The deferred return should produce a tool_result message with "Result stored" content
      const msgCreatedEvents = events
        .filter(
          (e): e is Extract<AgenticLoopEvent, { type: 'message_created' }> =>
            e.type === 'message_created'
        )
        .map(e => e.message);

      // user + assistant(tool_use) + tool_result(stored) + assistant(final) = 4
      expect(result.value.messages).toHaveLength(4);

      // The tool_result message should exist (not skipped like non-deferred)
      expect(msgCreatedEvents.length).toBe(3); // assistant + tool_result + assistant
    });

    it('auto-ack return: solo return creates tool result + assistant ack message and breaks loop', async () => {
      const returnToolBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_ret_ack',
          name: 'return',
          input: { result: 'ack_result' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: returnToolBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      setupMultiIterationMock([createMockStream([], toolUseResult)], [returnToolBlocks]);

      vi.mocked(executeClientSideTool).mockReturnValue(
        mockToolGenerator({
          content: 'ack_result',
          breakLoop: { returnValue: 'ack_result' },
        })
      );

      const options = createMockOptions({
        enabledTools: ['return'],
        deferReturn: 'auto-ack',
        autoAckMessage: 'Understood.',
      });
      const context = [createMockUserMessage('Do task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('ack_result');
      }

      // Only ONE API call — loop breaks after auto-ack return
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(1);

      const msgCreatedEvents = events
        .filter(
          (e): e is Extract<AgenticLoopEvent, { type: 'message_created' }> =>
            e.type === 'message_created'
        )
        .map(e => e.message);

      // assistant(tool_use) + tool_result + assistant(ack) = 3 messages created
      expect(msgCreatedEvents.length).toBe(3);

      // Last created message should be the synthetic assistant ack
      const ackMsg = msgCreatedEvents[msgCreatedEvents.length - 1];
      expect(ackMsg.role).toBe('assistant');
      expect(ackMsg.content.content).toBe('Understood.');
    });

    it('auto-ack return in parallel: resolves alongside other tools then breaks', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_ret_p',
          name: 'return',
          input: { result: 'parallel_ack' },
        },
        {
          type: 'tool_use' as const,
          id: 'toolu_mem_p',
          name: 'memory',
          input: { action: 'read', key: 'x' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      setupMultiIterationMock([createMockStream([], toolUseResult)], [toolUseBlocks]);

      vi.mocked(executeClientSideTool).mockImplementation(name => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'parallel_ack',
            breakLoop: { returnValue: 'parallel_ack' },
          });
        }
        return mockToolGenerator({ content: 'memory_result' });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'auto-ack',
        autoAckMessage: 'Got it.',
      });
      const context = [createMockUserMessage('Do both')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('parallel_ack');
      }

      // Only ONE API call — loop breaks after auto-ack parallel return
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(1);

      const msgCreatedEvents = events
        .filter(
          (e): e is Extract<AgenticLoopEvent, { type: 'message_created' }> =>
            e.type === 'message_created'
        )
        .map(e => e.message);

      // Last created message should be the synthetic assistant ack
      const ackMsg = msgCreatedEvents[msgCreatedEvents.length - 1];
      expect(ackMsg.role).toBe('assistant');
      expect(ackMsg.content.content).toBe('Got it.');
    });

    it('deferred return: second call returns error and keeps first value', async () => {
      // Two iterations with return tool calls, then final response.
      // The second call should be rejected — first stored value is kept.
      const returnBlock1 = [
        { type: 'tool_use' as const, id: 'toolu_r1', name: 'return', input: { result: 'first' } },
      ];
      const returnBlock2 = [
        { type: 'tool_use' as const, id: 'toolu_r2', name: 'return', input: { result: 'second' } },
      ];

      const toolUseResult1 = {
        textContent: '',
        fullContent: returnBlock1,
        stopReason: 'tool_use',
        inputTokens: 80,
        outputTokens: 40,
      };
      const toolUseResult2 = {
        textContent: '',
        fullContent: returnBlock2,
        stopReason: 'tool_use',
        inputTokens: 90,
        outputTokens: 45,
      };
      const finalResult = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      setupMultiIterationMock(
        [
          createMockStream([], toolUseResult1),
          createMockStream([], toolUseResult2),
          createMockStream([], finalResult),
        ],
        [returnBlock1, returnBlock2, []]
      );

      let callCount = 0;
      vi.mocked(executeClientSideTool).mockImplementation(() => {
        callCount++;
        const val = callCount === 1 ? 'first' : 'second';
        return mockToolGenerator({
          content: val,
          breakLoop: { returnValue: val },
        });
      });

      const options = createMockOptions({
        enabledTools: ['return'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        // First value is preserved — second call was rejected
        expect(result.returnValue).toBe('first');
      }

      // Three API calls (loop continued through both return calls)
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(3);
      // executeClientSideTool only called once — second call is rejected before execution
      expect(callCount).toBe(1);

      // The duplicate rejection builds the tool_result directly (not via executeClientSideTool).
      // The third sendMessageStream call receives context with the duplicate-error tool_result.
      const streamCalls = vi.mocked(apiService.sendMessageStream).mock.calls;
      const thirdCallMessages = streamCalls[2][0] as Array<{
        role: string;
        content: { toolResults?: Array<{ content: string; is_error?: boolean }> };
      }>;
      const dupMsg = thirdCallMessages.find(m => m.content.toolResults?.some(tr => tr.is_error));
      expect(dupMsg).toBeDefined();
      expect(dupMsg!.content.toolResults![0].is_error).toBe(true);
      expect(dupMsg!.content.toolResults![0].content).toBe(
        'The previous return has been recorded already. Please stop and user will call back.'
      );
    });

    it('deferred return: parallel return+memory then solo duplicate next message', async () => {
      // Iteration 1: return + memory in parallel (deferred) → stores value, loop continues
      // Iteration 2: solo return again → duplicate error, NOT executed
      // Iteration 3: end_turn → final result has first stored value
      const parallelBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_m1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
        {
          type: 'tool_use' as const,
          id: 'toolu_r1',
          name: 'return',
          input: { result: 'first' },
        },
      ];
      const soloReturnBlock = [
        {
          type: 'tool_use' as const,
          id: 'toolu_r2',
          name: 'return',
          input: { result: 'second' },
        },
      ];

      const iter1Result = {
        textContent: '',
        fullContent: parallelBlocks,
        stopReason: 'tool_use',
        inputTokens: 80,
        outputTokens: 40,
      };
      const iter2Result = {
        textContent: '',
        fullContent: soloReturnBlock,
        stopReason: 'tool_use',
        inputTokens: 90,
        outputTokens: 45,
      };
      const iter3Result = {
        textContent: 'Final',
        fullContent: [{ type: 'text', text: 'Final' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      setupMultiIterationMock(
        [
          createMockStream([], iter1Result),
          createMockStream([], iter2Result),
          createMockStream([], iter3Result),
        ],
        [parallelBlocks, soloReturnBlock, []]
      );

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'first',
            breakLoop: { returnValue: 'first' },
          });
        }
        return mockToolGenerator({ content: 'memory ok', isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('Do task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('first');
      }

      // return + memory executed in iteration 1; duplicate rejected in iteration 2
      expect(executeClientSideTool).toHaveBeenCalledTimes(2);
      expect(executeClientSideTool).toHaveBeenCalledWith(
        'return',
        { result: 'first' },
        ['return', 'memory'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );
      expect(executeClientSideTool).toHaveBeenCalledWith(
        'memory',
        { command: 'view', path: '/' },
        ['return', 'memory'],
        {},
        expect.objectContaining({ projectId: 'proj_test', chatId: 'chat_test' })
      );

      // 3 API calls
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(3);

      // Solo duplicate path builds tool_result message directly (no tool_block_update).
      // The third sendMessageStream call receives context containing the duplicate-error tool_result.
      const streamCalls = vi.mocked(apiService.sendMessageStream).mock.calls;
      const thirdCallMessages = streamCalls[2][0] as Array<{
        role: string;
        content: { toolResults?: Array<{ content: string; is_error?: boolean }> };
      }>;
      const dupMsg = thirdCallMessages.find(m => m.content.toolResults?.some(tr => tr.is_error));
      expect(dupMsg).toBeDefined();
      expect(dupMsg!.content.toolResults![0].is_error).toBe(true);
      expect(dupMsg!.content.toolResults![0].content).toBe(
        'The previous return has been recorded already. Please stop and user will call back.'
      );
    });

    it('deferred return: empty string stores correctly and blocks duplicate', async () => {
      // Iteration 1: solo return with "" (empty string) → deferred, stores ""
      // Iteration 2: solo return again → duplicate error, not executed
      // Iteration 3: end_turn → final result has ""
      const returnBlock1 = [
        {
          type: 'tool_use' as const,
          id: 'toolu_e1',
          name: 'return',
          input: { result: '' },
        },
      ];
      const returnBlock2 = [
        {
          type: 'tool_use' as const,
          id: 'toolu_e2',
          name: 'return',
          input: { result: 'overwrite' },
        },
      ];

      const iter1Result = {
        textContent: '',
        fullContent: returnBlock1,
        stopReason: 'tool_use',
        inputTokens: 80,
        outputTokens: 40,
      };
      const iter2Result = {
        textContent: '',
        fullContent: returnBlock2,
        stopReason: 'tool_use',
        inputTokens: 90,
        outputTokens: 45,
      };
      const iter3Result = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      setupMultiIterationMock(
        [
          createMockStream([], iter1Result),
          createMockStream([], iter2Result),
          createMockStream([], iter3Result),
        ],
        [returnBlock1, returnBlock2, []]
      );

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: '',
          breakLoop: { returnValue: '' },
        })
      );

      const options = createMockOptions({
        enabledTools: ['return'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        // Empty string is preserved, not overwritten
        expect(result.returnValue).toBe('');
      }

      // Only first call executed — second rejected before execution
      expect(executeClientSideTool).toHaveBeenCalledTimes(1);
      // 3 API calls
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(3);

      // Verify duplicate error content via the third sendMessageStream call's context
      const streamCalls = vi.mocked(apiService.sendMessageStream).mock.calls;
      const thirdCallMessages = streamCalls[2][0] as Array<{
        role: string;
        content: { toolResults?: Array<{ content: string; is_error?: boolean }> };
      }>;
      const dupMsg = thirdCallMessages.find(m => m.content.toolResults?.some(tr => tr.is_error));
      expect(dupMsg).toBeDefined();
      expect(dupMsg!.content.toolResults![0].is_error).toBe(true);
      expect(dupMsg!.content.toolResults![0].content).toBe(
        'The previous return has been recorded already. Please stop and user will call back.'
      );
    });

    it('deferred return: pre-loop pending blocks store value and continue', async () => {
      const pendingReturnBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_p',
          name: 'return',
          input: { result: 'pending-val' },
        },
      ];

      const finalResult = {
        textContent: 'After pending',
        fullContent: [{ type: 'text', text: 'After pending' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], finalResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'pending-val',
          breakLoop: { returnValue: 'pending-val' },
        })
      );

      const options = createMockOptions({
        enabledTools: ['return'],
        deferReturn: 'free-run',
        pendingToolUseBlocks: pendingReturnBlocks,
      });
      const context = [createMockUserMessage('Continue')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('pending-val');
      }

      // API should still be called (loop continued after deferred return)
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(1);
    });

    it('deferred return: custom returnAckMessage and returnDuplicateMessage are used', async () => {
      const returnBlock1 = [
        { type: 'tool_use' as const, id: 'toolu_r1', name: 'return', input: { result: 'first' } },
      ];
      const returnBlock2 = [
        { type: 'tool_use' as const, id: 'toolu_r2', name: 'return', input: { result: 'second' } },
      ];

      const toolUseResult1 = {
        textContent: '',
        fullContent: returnBlock1,
        stopReason: 'tool_use',
        inputTokens: 80,
        outputTokens: 40,
      };
      const toolUseResult2 = {
        textContent: '',
        fullContent: returnBlock2,
        stopReason: 'tool_use',
        inputTokens: 90,
        outputTokens: 45,
      };
      const finalResult = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      setupMultiIterationMock(
        [
          createMockStream([], toolUseResult1),
          createMockStream([], toolUseResult2),
          createMockStream([], finalResult),
        ],
        [returnBlock1, returnBlock2, []]
      );

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'first',
          breakLoop: { returnValue: 'first' },
        })
      );

      const customAck = 'Got it, proceed with cleanup.';
      const customDuplicate = 'Already captured — no more returns.';

      const options = createMockOptions({
        enabledTools: ['return'],
        deferReturn: 'free-run',
        returnAckMessage: customAck,
        returnDuplicateMessage: customDuplicate,
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));
      expect(result.status).toBe('complete');

      type MsgShape = {
        role: string;
        content: { toolResults?: Array<{ content: string; is_error?: boolean }> };
      };
      const streamCalls = vi.mocked(apiService.sendMessageStream).mock.calls;

      // Second sendMessageStream call receives context with ack tool_result
      const secondCallMessages = streamCalls[1][0] as MsgShape[];
      const ackMsg = secondCallMessages.find(m => m.content.toolResults?.length);
      expect(ackMsg).toBeDefined();
      expect(ackMsg!.content.toolResults![0].content).toBe(customAck);
      expect(ackMsg!.content.toolResults![0].is_error).toBeUndefined();

      // Third sendMessageStream call receives context with duplicate-error tool_result
      const thirdCallMessages = streamCalls[2][0] as MsgShape[];
      const dupMsg = thirdCallMessages.find(m => m.content.toolResults?.some(tr => tr.is_error));
      expect(dupMsg).toBeDefined();
      expect(dupMsg!.content.toolResults![0].content).toBe(customDuplicate);
      expect(dupMsg!.content.toolResults![0].is_error).toBe(true);
    });

    it('propagates checkpoint boundary to sendMessageStream on auto-continued iteration', async () => {
      // Iteration 1: tool_use with checkpoint tool → checkpointSet = true
      // Iteration 1 continued: end_turn → auto-continue triggers
      // Iteration 2 (auto-continued): sendMessageStream should receive computed checkpoint boundary

      // Use counter-based IDs so we can distinguish the tool_use assistant from end_turn assistant
      let idCounter = 0;
      const { generateUniqueId } = await import('../../../utils/idGenerator');
      vi.mocked(generateUniqueId).mockImplementation(prefix => `${prefix}_${++idCounter}`);

      const checkpointToolBlocks = [
        { type: 'tool_use' as const, id: 'toolu_ckpt', name: 'checkpoint', input: {} },
      ];

      // Iter 1 stream: tool_use response
      const toolUseResult = {
        textContent: '',
        fullContent: checkpointToolBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      // Iter 1 continued stream: end_turn → triggers checkpoint auto-continue
      const endTurnResult = {
        textContent: 'checkpoint set',
        fullContent: [{ type: 'text', text: 'checkpoint set' }],
        stopReason: 'end_turn',
        inputTokens: 110,
        outputTokens: 55,
      };

      // Iter 2 stream (auto-continued): final response
      const finalResult = {
        textContent: 'Continuing after checkpoint',
        fullContent: [{ type: 'text', text: 'Continuing after checkpoint' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [
          createMockStream([], toolUseResult),
          createMockStream([], endTurnResult),
          createMockStream([], finalResult),
        ],
        [checkpointToolBlocks, [], []]
      );

      // Checkpoint tool returns with checkpoint flag
      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Checkpoint created',
          isError: false,
          checkpoint: true,
        })
      );

      const options = createMockOptions({
        enabledTools: ['checkpoint'],
        toolOptions: { checkpoint: {} },
        // No initial checkpointMessageIds — simulates first checkpoint
      });
      const context = [createMockUserMessage('Do a long task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');

      // checkpoint_set event should have been yielded
      const checkpointEvents = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'checkpoint_set' }> =>
          e.type === 'checkpoint_set'
      );
      expect(checkpointEvents).toHaveLength(1);
      const checkpointMsgId = checkpointEvents[0].messageId;

      // The checkpoint ID should point to the FIRST assistant message (tool_use),
      // not the second (end_turn). The first assistant msg gets ID 'msg_assistant_1'.
      expect(checkpointMsgId).toBe('msg_assistant_1');

      // sendMessageStream called 3 times: iter1 (tool_use), iter1b (end_turn), iter2 (final)
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(3);

      // The third call (auto-continued iteration) should have checkpointMessageId set
      const thirdCallOptions = vi.mocked(apiService.sendMessageStream).mock.calls[2][3];
      expect(thirdCallOptions.checkpointMessageId).toBe(checkpointMsgId);

      // The first call should NOT have checkpointMessageId (it was undefined)
      const firstCallOptions = vi.mocked(apiService.sendMessageStream).mock.calls[0][3];
      expect(firstCallOptions.checkpointMessageId).toBeUndefined();
    });

    it('accumulates tool-incurred costs and yields tokens_consumed for them', async () => {
      const toolUseBlocks = [
        { type: 'tool_use' as const, id: 'toolu_1', name: 'minion', input: { message: 'task' } },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const finalResult = {
        textContent: 'Done!',
        fullContent: [{ type: 'text', text: 'Done!' }],
        stopReason: 'end_turn',
        inputTokens: 120,
        outputTokens: 60,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, []]
      );

      // Tool returns with tokenTotals (simulating a minion sub-agent)
      const minionTotals = {
        inputTokens: 500,
        outputTokens: 200,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        webSearchCount: 0,
        cost: 0.042,
        costUnreliable: false,
      };

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Task done',
          isError: false,
          tokenTotals: minionTotals,
        })
      );

      const options = createMockOptions({ enabledTools: ['minion'] });
      const context = [createMockUserMessage('Delegate task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      // tokens_consumed should be yielded twice: once for the API call, once for tool costs
      const tokenEvents = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'tokens_consumed' }> =>
          e.type === 'tokens_consumed'
      );
      expect(tokenEvents.length).toBeGreaterThanOrEqual(2);

      // The tool cost event should contain the minion's totals and isToolCost flag
      const toolCostEvent = tokenEvents.find(e => e.tokens.cost === 0.042);
      expect(toolCostEvent).toBeDefined();
      expect(toolCostEvent!.isToolCost).toBe(true);
      expect(toolCostEvent!.tokens.inputTokens).toBe(500);
      expect(toolCostEvent!.tokens.outputTokens).toBe(200);

      // Direct API cost events should not have isToolCost
      const apiCostEvents = tokenEvents.filter(e => e.tokens.cost !== 0.042);
      for (const apiEvent of apiCostEvents) {
        expect(apiEvent.isToolCost).toBeUndefined();
      }

      // Overall totals should include both API and tool costs
      const finalValue = result.value;
      expect(finalValue.tokens.inputTokens).toBe(100 + 500 + 120); // api1 + tool + api2
      expect(finalValue.tokens.outputTokens).toBe(50 + 200 + 60);
      expect(finalValue.tokens.cost).toBeCloseTo(0.001 + 0.042 + 0.001, 6); // mock calculateCost returns 0.001

      // Tool result message should have metadata with tool costs
      const toolResultMsg = finalValue.messages.find(
        m => m.role === 'user' && m.metadata?.messageCost
      );
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg!.metadata!.messageCost).toBe(0.042);
      expect(toolResultMsg!.metadata!.inputTokens).toBe(500);
    });

    it('passes keepSegments boundary when multiple checkpoints exist', async () => {
      // Pre-seed 3 checkpoint IDs. With keepSegments=1, boundary should be checkpointMessageIds[1]
      // (index = max(0, 3-1-1) = 1)
      let idCounter = 0;
      const { generateUniqueId } = await import('../../../utils/idGenerator');
      vi.mocked(generateUniqueId).mockImplementation(prefix => `${prefix}_${++idCounter}`);

      const finalResult = {
        textContent: 'ok',
        fullContent: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], finalResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions({
        checkpointMessageIds: ['cp_1', 'cp_2', 'cp_3'],
        toolOptions: { checkpoint: { keepSegments: 1 } },
      });
      const context = [createMockUserMessage('test')];

      await collectAgenticLoop(runAgenticLoop(options, context));

      const callOptions = vi.mocked(apiService.sendMessageStream).mock.calls[0][3];
      // boundary = checkpointMessageIds[max(0, 3-1-1)] = checkpointMessageIds[1] = 'cp_2'
      expect(callOptions.checkpointMessageId).toBe('cp_2');
    });

    it('passes latest checkpoint when keepSegments is 0', async () => {
      const finalResult = {
        textContent: 'ok',
        fullContent: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], finalResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions({
        checkpointMessageIds: ['cp_1', 'cp_2', 'cp_3'],
        toolOptions: { checkpoint: { keepSegments: 0 } },
      });
      const context = [createMockUserMessage('test')];

      await collectAgenticLoop(runAgenticLoop(options, context));

      const callOptions = vi.mocked(apiService.sendMessageStream).mock.calls[0][3];
      // boundary = checkpointMessageIds[max(0, 3-1-0)] = checkpointMessageIds[2] = 'cp_3'
      expect(callOptions.checkpointMessageId).toBe('cp_3');
    });

    it('handles keepSegments larger than checkpoint count gracefully', async () => {
      const finalResult = {
        textContent: 'ok',
        fullContent: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], finalResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions({
        checkpointMessageIds: ['cp_1'],
        toolOptions: { checkpoint: { keepSegments: 10 } },
      });
      const context = [createMockUserMessage('test')];

      await collectAgenticLoop(runAgenticLoop(options, context));

      const callOptions = vi.mocked(apiService.sendMessageStream).mock.calls[0][3];
      // boundary = checkpointMessageIds[max(0, 1-1-10)] = checkpointMessageIds[0] = 'cp_1'
      expect(callOptions.checkpointMessageId).toBe('cp_1');
    });

    it('does not pass checkpointMessageId when checkpointMessageIds is empty', async () => {
      const finalResult = {
        textContent: 'ok',
        fullContent: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], finalResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions({
        // No checkpointMessageIds — checkpoint tool disabled or no checkpoints yet
      });
      const context = [createMockUserMessage('test')];

      await collectAgenticLoop(runAgenticLoop(options, context));

      const callOptions = vi.mocked(apiService.sendMessageStream).mock.calls[0][3];
      expect(callOptions.checkpointMessageId).toBeUndefined();
    });

    it('disables tidy when keepSegments is -1 (keep all)', async () => {
      const finalResult = {
        textContent: 'ok',
        fullContent: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], finalResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const options = createMockOptions({
        checkpointMessageIds: ['cp_1', 'cp_2', 'cp_3'],
        toolOptions: { checkpoint: { keepSegments: -1 } },
      });
      const context = [createMockUserMessage('test')];

      await collectAgenticLoop(runAgenticLoop(options, context));

      const callOptions = vi.mocked(apiService.sendMessageStream).mock.calls[0][3];
      // keepSegments=-1 disables tidy entirely
      expect(callOptions.checkpointMessageId).toBeUndefined();
    });
  });

  describe('soft stop', () => {
    beforeEach(() => {
      resetMockState();
    });

    it('stops before tools when shouldStop returns true at tool boundary', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([{ type: 'content', content: '' }], toolUseResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue(toolUseBlocks);

      const options = createMockOptions({
        enabledTools: ['memory'],
        shouldStop: () => true,
      });
      const context = [createMockUserMessage('Do something')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('soft_stopped');
      if (result.status === 'soft_stopped') {
        expect(result.stopPoint).toBe('before_tools');
      }
      // Tool should NOT have been executed
      expect(executeClientSideTool).not.toHaveBeenCalled();
      // Assistant message with tool_use blocks is still in messages
      expect(result.messages).toHaveLength(2); // user + assistant
    });

    it('stops after tools when shouldStop returns true only after tool execution', async () => {
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];

      const toolUseResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([], toolUseResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue(toolUseBlocks);

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({ content: 'Done', isError: false })
      );

      // Return false on first check (before tools), true on second (after tools)
      let checkCount = 0;
      const options = createMockOptions({
        enabledTools: ['memory'],
        shouldStop: () => {
          checkCount++;
          return checkCount > 1;
        },
      });
      const context = [createMockUserMessage('Do something')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('soft_stopped');
      if (result.status === 'soft_stopped') {
        expect(result.stopPoint).toBe('after_tools');
      }
      // Tool WAS executed
      expect(executeClientSideTool).toHaveBeenCalledTimes(1);
      // user + assistant + tool_result = 3 messages
      expect(result.messages).toHaveLength(3);
    });

    it('does not check shouldStop on non-tool-use responses', async () => {
      const mockResult = {
        textContent: 'Hello!',
        fullContent: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      vi.mocked(apiService.sendMessageStream).mockReturnValue(
        createMockStream([{ type: 'content', content: 'Hello!' }], mockResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const shouldStop = vi.fn(() => true);
      const options = createMockOptions({ shouldStop });
      const context = [createMockUserMessage('Hi')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      // Normal completion — shouldStop not checked because stop_reason was end_turn
      expect(result.status).toBe('complete');
      expect(shouldStop).not.toHaveBeenCalled();
    });

    it('preserves deferred return value in soft_stopped result', async () => {
      // Iteration 1: deferred return stores value
      // Iteration 2: tool_use with shouldStop → soft_stopped carries stored value
      const returnBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_r1',
          name: 'return',
          input: { result: 'stored-val' },
        },
      ];
      const toolBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_t1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];

      const iter1Result = {
        textContent: '',
        fullContent: returnBlocks,
        stopReason: 'tool_use',
        inputTokens: 80,
        outputTokens: 40,
      };
      const iter2Result = {
        textContent: '',
        fullContent: toolBlocks,
        stopReason: 'tool_use',
        inputTokens: 90,
        outputTokens: 45,
      };

      setupMultiIterationMock(
        [createMockStream([], iter1Result), createMockStream([], iter2Result)],
        [returnBlocks, toolBlocks]
      );

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'stored-val',
            breakLoop: { returnValue: 'stored-val' },
          });
        }
        return mockToolGenerator({ content: 'Done', isError: false });
      });

      // shouldStop is checked twice per iteration (before + after tools).
      // Iter 1: check 1 (before) = false, iter 1 has no after-tools check (deferred return path).
      // Wait — deferred return solo path doesn't go through executeToolUseBlocks' after-tools check.
      // Actually, the shouldStop checks are in the main loop. Iter 1: before=false, after=false.
      // Iter 2: before=true → soft_stopped before_tools.
      let checkCount = 0;
      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
        shouldStop: () => {
          checkCount++;
          return checkCount > 2; // false for iter1 before+after, true for iter2 before
        },
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('soft_stopped');
      if (result.status === 'soft_stopped') {
        expect(result.returnValue).toBe('stored-val');
        expect(result.stopPoint).toBe('before_tools');
      }
    });
  });

  describe('deferred return wind-down', () => {
    beforeEach(() => {
      resetMockState();
    });

    /**
     * Helper: build streams/extracts for N tool_use iterations after a deferred return,
     * then a final end_turn. The first iteration captures the deferred return via solo
     * return tool; subsequent iterations use a regular tool (memory).
     */
    function buildDeferredReturnScenario(toolIterationsAfterReturn: number) {
      const returnBlocks = [
        { type: 'tool_use' as const, id: 'toolu_ret', name: 'return', input: { result: 'val' } },
      ];
      const memoryBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_mem',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];

      const streams: AsyncGenerator[] = [];
      const extracts: unknown[][] = [];

      // Iteration 1: deferred return
      streams.push(
        createMockStream([], {
          textContent: '',
          fullContent: returnBlocks,
          stopReason: 'tool_use',
          inputTokens: 10,
          outputTokens: 5,
        })
      );
      extracts.push(returnBlocks); // deduped within iteration

      // Iterations 2..N+1: regular tool
      for (let i = 0; i < toolIterationsAfterReturn; i++) {
        streams.push(
          createMockStream([], {
            textContent: '',
            fullContent: memoryBlocks,
            stopReason: 'tool_use',
            inputTokens: 10,
            outputTokens: 5,
          })
        );
        extracts.push(memoryBlocks);
      }

      // Final: end_turn
      streams.push(
        createMockStream([], {
          textContent: 'done',
          fullContent: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          inputTokens: 10,
          outputTokens: 5,
        })
      );
      extracts.push([]);

      return { streams, extracts };
    }

    it('injects soft stop message starting at round 5 after deferred return', async () => {
      // 5 tool iterations after return (iterations 2-6), then end_turn at iteration 7.
      // Deferred return captured at iteration 1, so round 5 = iteration 6.
      const { streams, extracts } = buildDeferredReturnScenario(5);
      setupMultiIterationMock(streams, extracts);

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'val',
            breakLoop: { returnValue: 'val' },
          });
        }
        return mockToolGenerator({ content: 'ok', isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('val');
      }

      // Soft stop message should appear once (at iteration 6, which is round 5)
      const msgEvents = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'message_created' }> =>
          e.type === 'message_created'
      );
      const stopMessages = msgEvents.filter(
        e =>
          e.message.role === 'user' &&
          typeof e.message.content.content === 'string' &&
          e.message.content.content.includes('You should stop')
      );
      expect(stopMessages).toHaveLength(1);
    });

    it('injects soft stop message every round from 5 to 9 (5 total)', async () => {
      // 9 tool iterations after return → iterations 2-10, rounds 1-9
      // Soft stop messages at rounds 5,6,7,8,9 = 5 messages
      const { streams, extracts } = buildDeferredReturnScenario(9);
      setupMultiIterationMock(streams, extracts);

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'val',
            breakLoop: { returnValue: 'val' },
          });
        }
        return mockToolGenerator({ content: 'ok', isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');

      const msgEvents = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'message_created' }> =>
          e.type === 'message_created'
      );
      const stopMessages = msgEvents.filter(
        e =>
          e.message.role === 'user' &&
          typeof e.message.content.content === 'string' &&
          e.message.content.content.includes('You should stop')
      );
      expect(stopMessages).toHaveLength(5);
    });

    it('force stops at round 10 after deferred return', async () => {
      // 10 tool iterations after return → force stop at iteration 11 (round 10)
      // The loop should NOT reach the final end_turn stream.
      const { streams, extracts } = buildDeferredReturnScenario(10);
      setupMultiIterationMock(streams, extracts);

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'val',
            breakLoop: { returnValue: 'val' },
          });
        }
        return mockToolGenerator({ content: 'ok', isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('val');
      }

      // Force stop means we should NOT have reached the end_turn stream.
      // 1 (return) + 10 (memory) = 11 API calls if it ran all tool iterations.
      // The end_turn stream would be call #12. Force stop prevents it.
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(11);
    });

    it('pending blocks deferred return uses iteration 0 as baseline', async () => {
      // Deferred return in pending blocks sets deferredReturnIteration = 0.
      // Then 5 iterations of regular tools → rounds 5-5 get soft stop message.
      // Force stop at iteration 10.
      const memoryBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_mem',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];

      const pendingReturnBlocks = [
        { type: 'tool_use' as const, id: 'toolu_p', name: 'return', input: { result: 'pval' } },
      ];

      const streams: AsyncGenerator[] = [];
      const extracts: unknown[][] = [];

      // 5 iterations of memory tool
      for (let i = 0; i < 5; i++) {
        streams.push(
          createMockStream([], {
            textContent: '',
            fullContent: memoryBlocks,
            stopReason: 'tool_use',
            inputTokens: 10,
            outputTokens: 5,
          })
        );
        extracts.push(memoryBlocks);
      }

      // Final end_turn
      streams.push(
        createMockStream([], {
          textContent: 'done',
          fullContent: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          inputTokens: 10,
          outputTokens: 5,
        })
      );
      extracts.push([]);

      setupMultiIterationMock(streams, extracts);

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'pval',
            breakLoop: { returnValue: 'pval' },
          });
        }
        return mockToolGenerator({ content: 'ok', isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
        pendingToolUseBlocks: pendingReturnBlocks,
      });
      const context = [createMockUserMessage('task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('pval');
      }

      // With deferredReturnIteration=0, iterations 5+ get soft stop messages.
      // iterations 1-4: no message; iteration 5: message (round 5-0=5 >= 5)
      const msgEvents = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'message_created' }> =>
          e.type === 'message_created'
      );
      const stopMessages = msgEvents.filter(
        e =>
          e.message.role === 'user' &&
          typeof e.message.content.content === 'string' &&
          e.message.content.content.includes('You should stop')
      );
      // Iteration 5 = round 5, so exactly 1 soft stop message
      expect(stopMessages).toHaveLength(1);
    });

    it('custom deferredForceStopRounds: 0 force stops immediately after deferred return', async () => {
      // With forceStopRounds=0, the loop should force stop right after the deferred return
      // capture (iteration 1) since iteration - deferredReturnIteration >= 0 is always true.
      const returnBlocks = [
        { type: 'tool_use' as const, id: 'toolu_ret', name: 'return', input: { result: 'val' } },
      ];

      const streams: AsyncGenerator[] = [];
      const extracts: unknown[][] = [];

      // Iteration 1: deferred return
      streams.push(
        createMockStream([], {
          textContent: '',
          fullContent: returnBlocks,
          stopReason: 'tool_use',
          inputTokens: 10,
          outputTokens: 5,
        })
      );
      extracts.push(returnBlocks);

      // Iteration 2 would be a memory tool, but force stop should prevent it
      const memoryBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_mem',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];
      streams.push(
        createMockStream([], {
          textContent: '',
          fullContent: memoryBlocks,
          stopReason: 'tool_use',
          inputTokens: 10,
          outputTokens: 5,
        })
      );
      extracts.push(memoryBlocks);

      setupMultiIterationMock(streams, extracts);

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'val',
            breakLoop: { returnValue: 'val' },
          });
        }
        return mockToolGenerator({ content: 'ok', isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
        deferredForceStopRounds: 0,
      });
      const context = [createMockUserMessage('task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('val');
      }

      // Only 1 API call: the deferred return iteration. Force stop prevents iteration 2.
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(1);
    });

    it('custom deferredSoftStopRounds: 2 starts soft stop messages at round 2', async () => {
      // 3 tool iterations after return (iterations 2-4), then end_turn at iteration 5.
      // Soft stop messages at rounds 2 and 3 (iterations 3 and 4).
      const { streams, extracts } = buildDeferredReturnScenario(3);
      setupMultiIterationMock(streams, extracts);

      vi.mocked(executeClientSideTool).mockImplementation((name: string) => {
        if (name === 'return') {
          return mockToolGenerator({
            content: 'val',
            breakLoop: { returnValue: 'val' },
          });
        }
        return mockToolGenerator({ content: 'ok', isError: false });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
        deferredSoftStopRounds: 2,
      });
      const context = [createMockUserMessage('task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('complete');
      if (result.value.status === 'complete') {
        expect(result.value.returnValue).toBe('val');
      }

      const msgEvents = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'message_created' }> =>
          e.type === 'message_created'
      );
      const stopMessages = msgEvents.filter(
        e =>
          e.message.role === 'user' &&
          typeof e.message.content.content === 'string' &&
          e.message.content.content.includes('You should stop')
      );
      // Rounds 2 and 3 → 2 soft stop messages
      expect(stopMessages).toHaveLength(2);
    });
  });

  describe('breakLoop does not override storedReturnValue', () => {
    it('returns storedReturnValue when breakLoop fires after deferred return', async () => {
      // Iteration 1: return tool → deferred capture of "A"
      // Iteration 2: some tool → breakLoop with "B"
      // Expected: loop returns "A", not "B"
      const returnBlock = [
        { type: 'tool_use' as const, id: 'toolu_ret', name: 'return', input: { result: 'A' } },
      ];
      const otherBlock = [
        { type: 'tool_use' as const, id: 'toolu_other', name: 'memory', input: { op: 'read' } },
      ];

      const toolUseResult1 = {
        textContent: '',
        fullContent: returnBlock,
        stopReason: 'tool_use',
        inputTokens: 80,
        outputTokens: 40,
      };
      const toolUseResult2 = {
        textContent: '',
        fullContent: otherBlock,
        stopReason: 'tool_use',
        inputTokens: 90,
        outputTokens: 45,
      };

      setupMultiIterationMock(
        [createMockStream([], toolUseResult1), createMockStream([], toolUseResult2)],
        [returnBlock, otherBlock]
      );

      let callCount = 0;
      vi.mocked(executeClientSideTool).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Return tool — deferred
          return mockToolGenerator({
            content: 'A',
            breakLoop: { returnValue: 'A' },
          });
        }
        // Second tool triggers breakLoop with different value
        return mockToolGenerator({
          content: 'B',
          breakLoop: { returnValue: 'B' },
        });
      });

      const options = createMockOptions({
        enabledTools: ['return', 'memory'],
        deferReturn: 'free-run',
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('A');
      }
    });
  });

  describe('fallbackToolExtraction', () => {
    it('processes tool_use blocks despite wrong stopReason when enabled', async () => {
      // API returns stopReason: 'end_turn' but content has a return tool_use block
      const returnBlock = [
        { type: 'tool_use' as const, id: 'toolu_fb', name: 'return', input: { result: 'val' } },
      ];

      const wrongStopResult = {
        textContent: '',
        fullContent: returnBlock,
        stopReason: 'end_turn', // wrong — should be 'tool_use'
        inputTokens: 80,
        outputTokens: 40,
      };

      setupMultiIterationMock([createMockStream([], wrongStopResult)], [returnBlock]);

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'val',
          breakLoop: { returnValue: 'val' },
        })
      );

      const options = createMockOptions({
        enabledTools: ['return'],
        fallbackToolExtraction: true,
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('val');
      }
      // The return tool should have been executed
      expect(executeClientSideTool).toHaveBeenCalled();
    });

    it('exits normally when stopReason is wrong and no tool_use blocks present', async () => {
      // API returns stopReason: 'end_turn', no tool_use blocks → normal exit
      const normalResult = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 80,
        outputTokens: 40,
      };

      setupMultiIterationMock([createMockStream([], normalResult)], [[]]);

      const options = createMockOptions({
        enabledTools: ['return'],
        fallbackToolExtraction: true,
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBeUndefined();
      }
      // No tools should have been executed
      expect(executeClientSideTool).not.toHaveBeenCalled();
    });

    it('does not extract fallback blocks when fallbackToolExtraction is disabled', async () => {
      // API returns stopReason: 'end_turn' with tool_use blocks, but fallback is off
      const returnBlock = [
        { type: 'tool_use' as const, id: 'toolu_nf', name: 'return', input: { result: 'val' } },
      ];

      const wrongStopResult = {
        textContent: '',
        fullContent: returnBlock,
        stopReason: 'end_turn',
        inputTokens: 80,
        outputTokens: 40,
      };

      setupMultiIterationMock([createMockStream([], wrongStopResult)], [returnBlock]);

      const options = createMockOptions({
        enabledTools: ['return'],
        // fallbackToolExtraction NOT set — defaults to false
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      // Should exit normally without executing tools
      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBeUndefined();
      }
      expect(executeClientSideTool).not.toHaveBeenCalled();
    });
  });

  describe('createToolResultRenderBlock', () => {
    it('uses error icon when isError is true, ignoring tool iconOutput', () => {
      const block = createToolResultRenderBlock('tu_1', 'return', 'error msg', true);
      expect(block.icon).toBe('❌');
      expect(block.is_error).toBe(true);
    });

    it('uses tool iconOutput when isError is false', () => {
      const block = createToolResultRenderBlock('tu_1', 'return', 'ok', false);
      expect(block.icon).toBe('✅');
    });

    it('uses default success icon for unknown tools', () => {
      const block = createToolResultRenderBlock('tu_1', 'unknown_tool', 'ok');
      expect(block.icon).toBe('✅');
    });
  });

  describe('DUMMY hook + checkpoint interaction', () => {
    beforeEach(() => {
      resetMockState();
      mockHookRuntime.run.mockReset();
      mockHookRuntime.dispose.mockReset();
    });

    it('yields checkpoint_set before DUMMY user-stop exit', async () => {
      // DUMMY intercepts with a checkpoint tool call, then returns 'user'.
      // checkpoint_set must be yielded even though auto-continue never fires.
      let idCounter = 0;
      const { generateUniqueId } = await import('../../../utils/idGenerator');
      vi.mocked(generateUniqueId).mockImplementation(prefix => `${prefix}_${++idCounter}`);

      // Iteration 1: hook returns synthetic response with checkpoint tool
      mockHookRuntime.run.mockResolvedValueOnce({
        value: {
          text: 'Setting checkpoint',
          toolCalls: [{ name: 'checkpoint', input: { note: 'step1' } }],
        },
      });
      // Iteration 2: hook returns 'user' (hand off to user)
      mockHookRuntime.run.mockResolvedValueOnce({ value: 'user' });

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Checkpoint created',
          isError: false,
          checkpoint: true,
        })
      );

      const options = createMockOptions({
        enabledTools: ['checkpoint'],
        toolOptions: { checkpoint: {} },
        activeHook: 'test-hook',
      });
      const context = [createMockUserMessage('start task')];

      const events: AgenticLoopEvent[] = [];
      const gen = runAgenticLoop(options, context);
      let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
      do {
        result = await gen.next();
        if (!result.done) events.push(result.value);
      } while (!result.done);

      expect(result.value.status).toBe('soft_stopped');

      const cpEvents = events.filter(
        (e): e is Extract<AgenticLoopEvent, { type: 'checkpoint_set' }> =>
          e.type === 'checkpoint_set'
      );
      expect(cpEvents).toHaveLength(1);
      // The checkpoint ID should reference the DUMMY assistant message
      expect(cpEvents[0].messageId).toMatch(/^msg_assistant_/);
    });
  });

  describe('extractHookHistory', () => {
    function makeMsg(
      id: string,
      role: 'user' | 'assistant' | 'system',
      text: string
    ): Message<unknown> {
      return {
        id,
        role,
        content: { type: 'text', content: text },
        timestamp: new Date(),
      };
    }

    it('returns empty array when depth is 0', () => {
      const msgs = [makeMsg('m1', 'user', 'hi'), makeMsg('m2', 'assistant', 'hello')];
      expect(extractHookHistory(msgs, 0)).toEqual([]);
    });

    it('returns empty array for negative depth', () => {
      const msgs = [makeMsg('m1', 'user', 'hi')];
      expect(extractHookHistory(msgs, -1)).toEqual([]);
    });

    it('excludes the last message (already in hookInput)', () => {
      const msgs = [makeMsg('m1', 'user', 'hi'), makeMsg('m2', 'assistant', 'hello')];
      const history = extractHookHistory(msgs, 5);
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('m1');
      expect(history[0].role).toBe('user');
      expect(history[0].text).toBe('hi');
    });

    it('limits to depth entries when more messages exist', () => {
      const msgs = [
        makeMsg('m1', 'user', 'one'),
        makeMsg('m2', 'assistant', 'two'),
        makeMsg('m3', 'user', 'three'),
        makeMsg('m4', 'assistant', 'four'),
        makeMsg('m5', 'user', 'five'),
      ];
      const history = extractHookHistory(msgs, 2);
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('m3');
      expect(history[1].id).toBe('m4');
    });

    it('returns all preceding messages when depth exceeds count', () => {
      const msgs = [
        makeMsg('m1', 'user', 'one'),
        makeMsg('m2', 'assistant', 'two'),
        makeMsg('m3', 'user', 'three'),
      ];
      const history = extractHookHistory(msgs, 50);
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('m1');
      expect(history[1].id).toBe('m2');
    });

    it('includes toolCalls when present', () => {
      const msg: Message<unknown> = {
        id: 'm1',
        role: 'assistant',
        content: {
          type: 'text',
          content: '',
          toolCalls: [{ type: 'tool_use', id: 'tu_1', name: 'memory', input: { action: 'view' } }],
        },
        timestamp: new Date(),
      };
      const msgs = [msg, makeMsg('m2', 'user', 'last')];
      const history = extractHookHistory(msgs, 1);
      expect(history[0].toolCalls).toEqual([
        { id: 'tu_1', name: 'memory', input: { action: 'view' } },
      ]);
    });

    it('includes toolResults when present', () => {
      const msg: Message<unknown> = {
        id: 'm1',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          toolResults: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false },
          ],
          renderingContent: [
            {
              category: 'backstage',
              blocks: [{ type: 'tool_result', tool_use_id: 'tu_1', name: 'memory', content: 'ok' }],
            },
          ],
        },
        timestamp: new Date(),
      };
      const msgs = [msg, makeMsg('m2', 'assistant', 'last')];
      const history = extractHookHistory(msgs, 1);
      expect(history[0].toolResults).toEqual([
        { tool_use_id: 'tu_1', name: 'memory', content: 'ok' },
      ]);
    });

    it('omits text field for whitespace-only content', () => {
      const msgs = [makeMsg('m1', 'user', '   '), makeMsg('m2', 'assistant', 'last')];
      const history = extractHookHistory(msgs, 1);
      expect(history[0].text).toBeUndefined();
    });

    it('returns empty array when only one message exists', () => {
      const msgs = [makeMsg('m1', 'user', 'only')];
      const history = extractHookHistory(msgs, 5);
      expect(history).toEqual([]);
    });
  });
});

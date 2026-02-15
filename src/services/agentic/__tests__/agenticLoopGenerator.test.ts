import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runAgenticLoop,
  collectAgenticLoop,
  createTokenTotals,
  addTokens,
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
    buildToolResultMessage: vi.fn(),
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

  vi.mocked(apiService.extractToolUseBlocks).mockImplementation(() => {
    const idx = mockState.extractIdx;
    if (mockState.extractIdx < mockState.extracts.length - 1) {
      mockState.extractIdx++;
    }
    return (mockState.extracts[idx] ?? []) as ToolUseBlock[];
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

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
        { projectId: 'proj_test', chatId: 'chat_test' }
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

      // extractToolUseBlocks is called TWICE per iteration:
      // 1. mergeToolUseInputFromFullContent (for display)
      // 2. actual tool check
      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, toolUseBlocks, [], []] // merge, check, merge, check
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
        { projectId: 'proj_test', chatId: 'chat_test' }
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

      // extractToolUseBlocks called twice per iteration: merge + check
      setupMultiIterationMock(
        [createMockStream([], toolUseResult), createMockStream([], finalResult)],
        [toolUseBlocks, toolUseBlocks, [], []] // iter1: merge, check; iter2: merge, check
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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

      // extractToolUseBlocks called twice per iteration: merge + check
      // iter1: merge(tool1), check(tool1); iter2: merge(tool2), check(tool2); iter3: merge([]), check([])
      setupMultiIterationMock(
        [
          createMockStream([], tool1Result),
          createMockStream([], tool2Result),
          createMockStream([], finalResult),
        ],
        [tool1Blocks, tool1Blocks, tool2Blocks, tool2Blocks, [], []]
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
        { projectId: 'proj_test', chatId: 'chat_test' }
      );
      expect(executeClientSideTool).toHaveBeenNthCalledWith(
        2,
        'write',
        { path: '/b' },
        ['read', 'write'],
        {},
        { projectId: 'proj_test', chatId: 'chat_test' }
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
        [toolUseBlocks, toolUseBlocks, [], []]
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
        [toolUseBlocks, toolUseBlocks, [], []]
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
        { projectId: 'proj_test', chatId: 'chat_test' }
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
        [toolUseBlocks, toolUseBlocks, [], []]
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
        [toolUseBlocks, toolUseBlocks, [], []]
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
        [returnToolBlocks, returnToolBlocks, [], []]
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'answer42',
          breakLoop: { returnValue: 'answer42' },
        })
      );

      const options = createMockOptions({
        enabledTools: ['return'],
        deferReturn: true,
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

    it('deferred return: multiple calls keep last value', async () => {
      // Two iterations with return tool calls, then final response
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
        [returnBlock1, returnBlock1, returnBlock2, returnBlock2, [], []]
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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
        deferReturn: true,
      });
      const context = [createMockUserMessage('Do task')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('second');
      }

      // Three API calls (loop continued through both return calls)
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(3);
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
      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'pending-val',
          breakLoop: { returnValue: 'pending-val' },
        })
      );

      const options = createMockOptions({
        enabledTools: ['return'],
        deferReturn: true,
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
        [toolUseBlocks, toolUseBlocks, [], []]
      );

      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

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

      // The tool cost event should contain the minion's totals
      const toolCostEvent = tokenEvents.find(e => e.tokens.cost === 0.042);
      expect(toolCostEvent).toBeDefined();
      expect(toolCostEvent!.tokens.inputTokens).toBe(500);
      expect(toolCostEvent!.tokens.outputTokens).toBe(200);

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
  });
});

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

vi.mock('../../tools/clientSideTools', () => ({
  executeClientSideTool: vi.fn(),
  toolRegistry: {
    get: vi.fn(() => ({
      iconInput: '🔧',
      iconOutput: '✅',
      renderInput: undefined,
      renderOutput: undefined,
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

      // Use breakLoop to exit after tool execution
      vi.mocked(executeClientSideTool).mockResolvedValue({
        content: 'Files listed successfully',
        isError: false,
        breakLoop: { status: 'complete', returnValue: 'tool executed' },
      });

      const options = createMockOptions({ enabledTools: ['memory'] });
      const context = [createMockUserMessage('List files')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      expect(executeClientSideTool).toHaveBeenCalledWith('memory', { command: 'view', path: '/' });
      if (result.status === 'complete') {
        expect(result.returnValue).toBe('tool executed');
      }
    });

    it('handles tool suspension via breakLoop', async () => {
      const toolUseResult = {
        textContent: '',
        fullContent: [
          { type: 'tool_use', id: 'toolu_1', name: 'ask_user', input: { question: 'What color?' } },
        ],
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([{ type: 'content', content: '' }], toolUseResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([
        { type: 'tool_use', id: 'toolu_1', name: 'ask_user', input: { question: 'What color?' } },
      ]);

      vi.mocked(executeClientSideTool).mockResolvedValue({
        content: 'Awaiting user input',
        breakLoop: { status: 'suspended' },
      });

      const options = createMockOptions({ enabledTools: ['ask_user'] });
      const context = [createMockUserMessage('Help me choose')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('suspended');
      if (result.status === 'suspended') {
        expect(result.pendingToolCall.name).toBe('ask_user');
        expect(result.otherToolResults).toHaveLength(0);
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

      vi.mocked(executeClientSideTool).mockResolvedValue({
        content: 'Returning value',
        breakLoop: { status: 'complete', returnValue: 'final answer' },
      });

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

      expect(result.status).toBe('complete');
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

      vi.mocked(executeClientSideTool).mockResolvedValue({
        content: 'Files listed successfully',
        isError: false,
      });

      const options = createMockOptions({ enabledTools: ['memory'] });
      const context = [createMockUserMessage('List files')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      expect(executeClientSideTool).toHaveBeenCalledWith('memory', { command: 'view', path: '/' });
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

      vi.mocked(executeClientSideTool).mockResolvedValue({
        content: 'Done',
        isError: false,
      });

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

      vi.mocked(executeClientSideTool).mockResolvedValue({
        content: 'Tool executed',
        isError: false,
      });

      const options = createMockOptions({ enabledTools: ['read', 'write'] });
      const context = [createMockUserMessage('Do multiple tasks')];

      const result = await collectAgenticLoop(runAgenticLoop(options, context));

      expect(result.status).toBe('complete');
      expect(executeClientSideTool).toHaveBeenCalledTimes(2);
      expect(executeClientSideTool).toHaveBeenNthCalledWith(1, 'read', { path: '/a' });
      expect(executeClientSideTool).toHaveBeenNthCalledWith(2, 'write', { path: '/b' });
      // 100 + 120 + 140 = 360 input tokens
      expect(result.tokens.inputTokens).toBe(360);
      // 30 + 40 + 50 = 120 output tokens
      expect(result.tokens.outputTokens).toBe(120);
      // user + (assistant + tool_result) × 2 + assistant = 6 messages
      expect(result.messages).toHaveLength(6);
    });
  });
});

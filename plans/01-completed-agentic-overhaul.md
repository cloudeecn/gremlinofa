This plan has been completed

# Agentic Loop Overhaul

## Problem

The current `agenticLoop.ts` is tightly coupled to:

1. **Chat/Project objects** - Needs `chat` and `project` for settings, token accumulation
2. **Write operations** - Calls `storage.saveMessage()` and `storage.saveChat()` directly
3. **Callback pattern** - Uses callbacks for UI updates, mixing concerns

This coupling makes the loop:

- Hard to test in isolation
- Impossible to reuse for sub-agent scenarios
- Difficult to reason about state flow

## Design Goals

1. **Chat/Project agnostic** - Loop receives flat options, not Chat/Project objects. Can run without chat/project if no tool needs their resources.
2. **Generator pattern** - Yield events instead of callbacks
3. **Single context array** - No separate "pending message" buffer
4. **Support suspension** - Tools can break the loop to await external input
5. **Nested loops** - AgentA can call AgentB as a subroutine

## Design Principles

### Storage Access

The loop is a **service** that:

- ✅ **Reads** from storage (attachments via `storage.getAttachments`)
- ❌ **Does NOT write** messages/chats (yields events, consumer handles persistence)

Tools handle their own data access via VFS (memory tool, filesystem tool, JS tool).

---

## Core Types

### AgenticLoopOptions

Flat structure (no nested `StreamOptions`). Consumer builds this via `buildAgenticLoopOptions()` in useChat.

```typescript
interface AgenticLoopOptions {
  // API
  apiDef: APIDefinition;
  model: Model;

  // Context IDs (for tools, optional for chat/project agnosticism)
  projectId: string;
  chatId?: string; // Optional - undefined when running standalone/sub-agent

  // Stream settings (flattened)
  temperature?: number;
  maxTokens: number;
  systemPrompt?: string;
  preFillResponse?: string;
  webSearchEnabled: boolean;
  enabledTools: string[];
  disableStream: boolean;

  // Anthropic reasoning
  enableReasoning: boolean;
  reasoningBudgetTokens: number;
  thinkingKeepTurns?: number;

  // OpenAI reasoning
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
}
```

### AgenticLoopEvent (yielded during execution)

```typescript
type AgenticLoopEvent =
  | { type: 'streaming_start' }
  | { type: 'streaming_chunk'; groups: RenderingBlockGroup[] }
  | { type: 'streaming_end' }
  | { type: 'message_created'; message: Message }
  | { type: 'tokens_consumed'; tokens: TokenTotals }
  | { type: 'first_chunk' };
```

### AgenticLoopResult (returned at end)

```typescript
type AgenticLoopResult =
  | {
      status: 'complete';
      messages: Message[];
      tokens: TokenTotals;
      returnValue?: string; // From 'return' tool (future)
    }
  | {
      status: 'suspended';
      messages: Message[];
      tokens: TokenTotals;
      pendingToolCall: ToolUseBlock; // The tool that caused suspension
      otherToolResults: ToolResultBlock[]; // Results of tools executed before suspension
    }
  | {
      status: 'error';
      messages: Message[];
      tokens: TokenTotals;
      error: Error;
    }
  | {
      status: 'max_iterations';
      messages: Message[];
      tokens: TokenTotals;
    };
```

### TokenTotals

```typescript
interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearchCount: number;
  cost: number;
  costUnreliable: boolean;
}
```

---

## Tool Suspension Mechanism

### Extended ToolResult

```typescript
export interface ToolResult {
  content: string;
  isError?: boolean;
  // Signal to break the loop
  breakLoop?: {
    status: 'suspended' | 'complete';
    returnValue?: string; // For 'complete' status
  };
}
```

### How Suspension Works

1. Tool executes and returns `{ breakLoop: { status: 'suspended' } }`
2. Loop does NOT create a tool_result for this call
3. Loop returns with `status: 'suspended'` and `pendingToolCall`
4. Caller can resume by passing previous messages + tool_result message

### Future Tools That Can Suspend

- `ask_clarify_question` - Ask main agent/user for clarification
- `delegate_to_user` - Require human input
- `await_approval` - Pause for explicit approval

These tools are NOT implemented in this overhaul—just the mechanism.

---

## Generator Function Signature

```typescript
async function* runAgenticLoop(
  options: AgenticLoopOptions,
  context: Message[]
): AsyncGenerator<AgenticLoopEvent, AgenticLoopResult, void>
```

## Implementation Pseudocode

```typescript
async function* runAgenticLoop(
  options: AgenticLoopOptions,
  context: Message[]
): AsyncGenerator<AgenticLoopEvent, AgenticLoopResult, void> {
  const { apiDef, model, projectId, enabledTools } = options;

  // Copy to avoid mutating caller's array (React state safety)
  const messages = [...context];

  const totals: TokenTotals = {
    /* zeros */
  };
  let iteration = 0;
  const MAX_ITERATIONS = 50;

  // Configure JS tool if enabled
  if (enabledTools?.includes('javascript')) {
    configureJsTool(projectId /* loadLib */);
  }

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    yield { type: 'streaming_start' };

    // Load attachments for user messages before sending to API
    const messagesWithAttachments = await loadAttachmentsForMessages(messages);

    const assembler = new StreamingContentAssembler({
      /* ... */
    });
    const stream = apiService.sendMessageStream(messagesWithAttachments, model.id, apiDef, options);

    let hasFirstChunk = false;
    for await (const chunk of stream) {
      if (!hasFirstChunk) {
        hasFirstChunk = true;
        yield { type: 'first_chunk' };
      }
      assembler.pushChunk(chunk);
      yield { type: 'streaming_chunk', groups: assembler.getGroups() };
    }

    yield { type: 'streaming_end' };

    const result = stream.return?.value; // Get final StreamResult

    // Build assistant message
    const assistantMessage = buildAssistantMessage(result, assembler, apiDef.apiType);
    messages.push(assistantMessage);
    yield { type: 'message_created', message: assistantMessage };

    // Accumulate tokens
    const iterTokens = extractTokens(result, model);
    addTokens(totals, iterTokens);
    yield { type: 'tokens_consumed', tokens: iterTokens };

    // Check stop reason
    if (result.stopReason !== 'tool_use') {
      return { status: 'complete', messages, tokens: totals };
    }

    // Execute tools
    const toolBlocks = apiService.extractToolUseBlocks(apiDef.apiType, result.fullContent);
    const toolResults: ToolResultBlock[] = [];

    for (const toolUse of toolBlocks) {
      const toolResult = await executeClientSideTool(toolUse.name, toolUse.input);

      // Check for suspension
      if (toolResult.breakLoop?.status === 'suspended') {
        return {
          status: 'suspended',
          messages,
          tokens: totals,
          pendingToolCall: toolUse,
          otherToolResults: toolResults,
        };
      }

      // Check for completion (return tool)
      if (toolResult.breakLoop?.status === 'complete') {
        return {
          status: 'complete',
          messages,
          tokens: totals,
          returnValue: toolResult.breakLoop.returnValue,
        };
      }

      // Normal tool result
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: toolResult.content,
        is_error: toolResult.isError,
      });
    }

    // Build and append tool result message
    const toolResultMessage = apiService.buildToolResultMessage(apiDef.apiType, toolResults);
    messages.push(toolResultMessage);
    yield { type: 'message_created', message: toolResultMessage };

    // Continue loop with updated context
  }

  return { status: 'max_iterations', messages, tokens: totals };
}
```

---

## Consumer Example (useChat.ts)

```typescript
async function sendMessage(userMessage: Message) {
  const context = [...messages, userMessage];

  const accumulator = createTokenAccumulator();

  for await (const event of runAgenticLoop(loopOptions, context)) {
    switch (event.type) {
      case 'message_created':
        await storage.saveMessage(chatId, event.message);
        setMessages(prev => [...prev, event.message]);
        break;
      case 'streaming_chunk':
        setStreamingContent(event.groups);
        break;
      case 'tokens_consumed':
        accumulator.add(event.tokens);
        break;
      // ... handle other events
    }
  }

  // Get final result
  const result = /* generator return value */;

  // Update chat with accumulated totals
  const updatedChat = {
    ...chat,
    totalInputTokens: chat.totalInputTokens + accumulator.totals.inputTokens,
    // ... other totals
  };
  await storage.saveChat(updatedChat);
  setChat(updatedChat);

  if (result.status === 'suspended') {
    setPendingToolCall(result.pendingToolCall);
  }
}
```

---

## Nested Agent Calls

```typescript
// AgentA has a tool that invokes AgentB
const invokeAgentTool: ClientSideTool = {
  name: 'invoke_agent',
  execute: async (input: { agentId: string; prompt: string }) => {
    const agentBOptions = getAgentOptions(input.agentId);
    const agentBContext = [buildUserMessage(input.prompt)];

    // Run sub-loop to completion
    const result = await collectAgenticLoop(runAgenticLoop(agentBOptions, agentBContext));

    switch (result.status) {
      case 'complete':
        return { content: result.returnValue ?? summarize(result.messages) };
      case 'suspended':
        // Sub-agent needs clarification - bubble up
        return {
          content: result.pendingToolCall.input.question,
          breakLoop: { status: 'suspended' },
        };
      case 'error':
        return { content: `Agent error: ${result.error.message}`, isError: true };
    }
  },
};

// Helper to consume generator and get final result
async function collectAgenticLoop(
  gen: AsyncGenerator<AgenticLoopEvent, AgenticLoopResult>
): Promise<AgenticLoopResult> {
  let result: IteratorResult<AgenticLoopEvent, AgenticLoopResult>;
  do {
    result = await gen.next();
  } while (!result.done);
  return result.value;
}
```

---

## Migration Notes

### Removed from Loop

- `storage.saveMessage()` - Consumer handles persistence
- `storage.saveChat()` - Consumer handles persistence
- `storage.saveProject()` - Consumer handles persistence
- `callbacks.*` - Replaced by yielded events
- `Chat` / `Project` objects - Replaced by flat options
- `PendingMessage` type - Replaced by single context array
- `buildStreamOptions()` - Moved to useChat as `buildAgenticLoopOptions()`

### Kept in Loop

- Tool execution
- Streaming assembly
- Token calculation
- API calls
- `storage.getAttachments()` - Reading attachments is OK (app-scoped resource)
- `loadAttachmentsForMessages()` - Attachment loading for API payloads

### SystemPromptContext

Keep all 4 fields for future tool adaptability:

```typescript
interface SystemPromptContext {
  projectId: string; // Used by memory/fs tools for VFS access
  chatId?: string; // Optional - for future chat manipulation tools
  apiDefinitionId: string; // For model-aware system prompts
  modelId: string; // For model-aware system prompts
}
```

The `chatId` is optional because the loop can run without a chat context (sub-agents, standalone execution). When present, tools can access chat resources.

---

## Implementation Phases

### Phase 1: Core Generator ✅ COMPLETED

- [x] Create new `agenticLoopGenerator.ts` with generator implementation in services/agentic
- [x] Add `ToolResult.breakLoop` field to types (in clientSideTools.ts)
- [x] Add `AgenticLoopResult` type with all statuses
- [x] Add `AgenticLoopEvent` type
- [x] Add `TokenTotals` type and accumulator utility
- [x] Unit tests for generator (16 tests, mock API, mock tools, multi-iteration scenarios)

### Phase 2: Consumer Integration ✅ COMPLETED

- [x] Update `useChat.ts` to use generator
- [x] Implement `consumeAgenticLoop` helper (renamed from `collectAgenticLoop`)
- [x] Update storage save logic in consumer (user/tool result messages saved before loop)
- [x] Update streaming state management (via event handlers)
- [x] Unit tests pass (36 tests in useChat.test.ts, 1629 total)

### Phase 3: Cleanup ✅ COMPLETED

- [x] Remove old `agenticLoop.ts` and its test file
- [x] Remove unused `PendingMessage` type (was in old agenticLoop.ts)
- [x] Update `development.md` documentation
- [x] Update `SystemPromptContext` - make `chatId` optional

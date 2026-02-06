This plan has been completed.

# Minion System Design

A tool that lets the main LLM delegate tasks to a sub-agent LLM.

## Overview

The minion system allows the primary chat LLM to spawn independent sub-agent conversations for delegating tasks. Each minion runs its own agentic loop with scoped-down tools, persists its conversation history, and returns results to the caller.

### Key Design Decisions

1. **Tool-level configuration**: Minion system prompt and model are configured via `toolOptions` (not Project fields)
2. **Real-time streaming**: Minion runs its own `StreamingContentAssembler` and streams to main chat UI
3. **No nested minions**: Minion tool excluded from minion's available tools
4. **Visibility separation**: Minion chats visible to user for debugging, caller LLM only sees tool_use/tool_result
5. **Tool scoping**: `return` tool hidden from caller; `minion` tool hidden from minions

---

## Phase 1: Types & Storage ✅

### Goal

Add types and storage layer for minion chats. No tools or UI yet.

### Changes

#### 1.1 Types (`src/types/index.ts`)

Add `MinionChat` type:

```typescript
export interface MinionChat {
  id: string;
  parentChatId: string; // The main chat that spawned this minion
  projectId: string;
  createdAt: Date;
  lastModifiedAt: Date;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalReasoningTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalCost?: number;
  contextWindowUsage?: number;
  costUnreliable?: boolean;
}
```

Extend `ToolContext` for minion streaming:

```typescript
export interface ToolContext {
  projectId: string;
  chatId?: string;
  onMinionStreaming?: (groups: RenderingBlockGroup[], minionChatId: string) => void;
}
```

#### 1.2 Content Types (`src/types/content.ts`)

Extend `ToolResultRenderBlock`:

```typescript
export interface ToolResultRenderBlock {
  // ... existing fields
  minionChatId?: string;
  minionGroups?: RenderingBlockGroup[];
  minionResponse?: string;
  minionUsedReturnTool?: boolean;
}
```

#### 1.3 Storage (`src/services/storage/`)

Add `MINION_CHATS` table constant and CRUD methods:

- `getMinionChats(parentChatId)` / `getMinionChat(id)` / `saveMinionChat()` / `deleteMinionChat()`
- `getMinionMessages(minionChatId)` / `saveMinionMessage()`
- Update `deleteChat()` to cascade delete minion chats

### Tests

`src/services/storage/__tests__/minionStorage.test.ts`

### Verification

```bash
npm run verify && npm run test:silent -- --testPathPattern=minionStorage
```

---

## Phase 2: Tool Options Types ✅

### Goal

Extend `ToolOptionDefinition` to support longtext and model types (not just boolean).

### Changes

#### 2.1 Types (`src/types/index.ts`)

```typescript
// Tool option value types
export type ToolOptionValue = boolean | string | ModelReference;

export interface ModelReference {
  apiDefinitionId: string;
  modelId: string;
}

// Discriminated union for option definitions
export type ToolOptionDefinition = BooleanToolOption | LongtextToolOption | ModelToolOption;

interface BaseToolOption {
  id: string;
  label: string;
  subtitle?: string;
}

export interface BooleanToolOption extends BaseToolOption {
  type: 'boolean';
  default: boolean;
}

export interface LongtextToolOption extends BaseToolOption {
  type: 'longtext';
  default: string;
  placeholder?: string;
}

export interface ModelToolOption extends BaseToolOption {
  type: 'model';
  // No default - prepopulated from project when first enabled
}

// Updated storage type
export type ToolOptions = Record<string, ToolOptionValue>;
```

#### 2.2 Backward Compatibility

Existing boolean options continue to work. Migration helper:

```typescript
function ensureToolOptionsInitialized(
  project: Project,
  toolName: string,
  toolDef: ClientSideTool
): ToolOptions {
  const existing = project.toolOptions?.[toolName] || {};
  const result = { ...existing };

  for (const opt of toolDef.optionDefinitions || []) {
    if (result[opt.id] === undefined) {
      if (opt.type === 'model') {
        // Prepopulate from project
        result[opt.id] = {
          apiDefinitionId: project.apiDefinitionId!,
          modelId: project.modelId!,
        };
      } else {
        result[opt.id] = opt.default;
      }
    }
  }
  return result;
}
```

### Tests

`src/types/__tests__/toolOptions.test.ts` - Type guards, migration helper

### Verification

```bash
npm run verify && npm run test:silent -- --testPathPattern=toolOptions
```

---

## Phase 3: Return Tool ✅

### Goal

Implement the `return` tool that breaks the agentic loop with a result.

### Changes

#### 3.1 Return Tool (`src/services/tools/returnTool.ts`)

```typescript
export const returnTool: ClientSideTool = {
  name: 'return',
  displayName: 'Return',
  displaySubtitle: 'Return a result and stop execution',
  description: 'Return a result from the current task and stop execution.',
  inputSchema: {
    type: 'object',
    properties: {
      result: { type: 'string', description: 'The result to return' },
    },
    required: ['result'],
  },
  iconInput: '↩️',
  iconOutput: '✅',

  execute: async (input): Promise<ToolResult> => {
    const result = input.result as string;
    return {
      content: result,
      breakLoop: { status: 'complete', returnValue: result },
    };
  },

  renderInput: input => input.result as string,
  renderOutput: output => output,
};
```

#### 3.2 Registration

Add to `registerAllTools()` but filter from caller's visible tools in `getToolDefinitions()`.

### Tests

`src/services/tools/__tests__/returnTool.test.ts`

### Verification

```bash
npm run verify && npm run test:silent -- --testPathPattern=returnTool
```

---

## Phase 4: Minion Tool ✅

### Goal

Implement the `minion` tool that spawns sub-agent loops.

### Changes

#### 4.1 Minion Tool (`src/services/tools/minionTool.ts`)

```typescript
export const minionTool: ClientSideTool = {
  name: 'minion',
  displayName: 'Minion',
  displaySubtitle: 'Delegate a task to a sub-agent',
  description: 'Delegate a task to a minion sub-agent.',
  inputSchema: {
    type: 'object',
    properties: {
      minionChatId: { type: 'string', description: 'Optional: existing minion chat ID' },
      message: { type: 'string', description: 'Task to send to minion' },
      enableWeb: { type: 'boolean', description: 'Enable web search' },
      enabledTools: { type: 'array', items: { type: 'string' }, description: 'Scoped tools' },
    },
    required: ['message', 'enableWeb', 'enabledTools'],
  },
  iconInput: '🤖',
  iconOutput: '🤖',

  optionDefinitions: [
    {
      type: 'longtext',
      id: 'systemPrompt',
      label: 'Minion System Prompt',
      subtitle: 'Instructions for sub-agent minions',
      default: '',
      placeholder: 'Instructions for minion agents...',
    },
    {
      type: 'model',
      id: 'model',
      label: 'Minion Model',
      subtitle: 'Use a cheaper model for delegated tasks',
    },
  ],

  execute: async (input, toolOptions, context): Promise<ToolResult> => {
    // See detailed implementation below
  },
};
```

**Execute Implementation** (key parts):

1. Load project, get minion model from `toolOptions.minion.model`
2. Create or load minion chat
3. Build scoped tools: `requestedTools ∩ projectTools - minion + return`
4. Run `runAgenticLoop()`, stream via `context.onMinionStreaming?.()`
5. Track `usedReturnTool` flag, return with `_minionMeta`

#### 4.2 agenticLoopGenerator.ts Changes

Update `createToolResultRenderBlock` to accept `minionMeta`:

```typescript
interface MinionMeta {
  minionChatId: string;
  minionGroups: RenderingBlockGroup[];
  minionResponse: string;
  minionUsedReturnTool: boolean;
}
```

#### 4.3 useChat.ts Changes

- Add `minionStreamingState` state
- Pass `onMinionStreaming` callback in `toolContext`
- Add `minionStreamingState` to `UseChatReturn`

### Tests

`src/services/tools/__tests__/minionTool.test.ts` (with mocked storage/apiService)

### Verification

```bash
npm run verify && npm run test:silent -- --testPathPattern=minionTool
```

---

## Phase 5: Tool Options UI ✅

### Goal

Add UI for longtext and model tool options in ProjectSettingsView.

### Changes

#### 5.1 Longtext Option UI

- Textarea preview (truncated) with "Edit" button
- Modal with full textarea (like SystemPromptModal)
- Save/cancel buttons

#### 5.2 Model Option UI

- Reuse existing `ModelSelector` component
- Required field (no "use project default" option)
- Prepopulate from project when minion first enabled

#### 5.3 ProjectSettingsView Changes

Render different controls based on `optionDefinition.type`:

```tsx
{opt.type === 'boolean' && <Toggle ... />}
{opt.type === 'longtext' && <LongtextOption ... />}
{opt.type === 'model' && <ModelOption ... />}
```

### Implementation Notes

- Created `LongtextOptionEditor` component for editing longtext options in a modal
- Updated `ProjectSettingsView` to render all three option types dynamically
- Added state management for longtext and model option modals
- Reused existing `ModelSelector` component for model options
- Replaced specific `getToolOption`/`setToolOption` with generic `getToolOptionValue`/`setToolOptionValue`

### Tests

Existing ProjectSettingsView tests still pass.

### Verification

```bash
npm run verify && npm run test:silent -- --testPathPattern=ProjectSettingsView
```

---

## Phase 6: Minion Chat Display ✅

### Goal

Display minion results in chat with real-time streaming.

### Changes

#### 6.1 MinionResultView (`src/components/chat/MinionResultView.tsx`)

- Auto-expand if `minionUsedReturnTool` is true
- Green background for return tool result, amber for text fallback
- Toggle to show/hide minion activity groups
- "Copy Minion Chat JSON" button

#### 6.2 Wire into existing components

- `ToolResultBubble`: Detect `minionChatId`, render `MinionResultView`
- `BackstageView`: Same detection in `ToolResultSegment`

#### 6.3 StreamingMessage Changes

Show real-time minion streaming when `minionStreamingState` present:

```tsx
{
  minionStreamingState && (
    <div className="ml-4 border-l-2 border-purple-300 pl-4">
      <div className="text-xs text-purple-600">🤖 Minion working...</div>
      {/* Render groups */}
    </div>
  );
}
```

### Tests

`src/components/chat/__tests__/MinionResultView.test.tsx`

### Verification

```bash
npm run verify && npm run test:silent -- --testPathPattern=MinionResultView
```

---

## Phase 7: Polish & Export ✅

### Goal

Error handling, data export/import, integration testing.

### Changes

#### 7.1 Error Messages

Consistent error messages in minionTool.ts - already implemented with consistent format.

#### 7.2 Data Export/Import

Added `MINION_CHATS` to:

- `EXPORT_TABLES` array in `dataExport.ts`
- Object stores in `IndexedDBAdapter.ts` (bumped DB_VERSION to 6)

#### 7.3 Integration Test

Full flow test in `minionIntegration.test.ts`:

- Simple task completion with minionMeta
- Return tool for explicit results
- Streaming via onMinionStreaming callback
- Continue existing minion conversation
- Tool scoping (excludes minion, includes return)
- Error handling (project/API/model not found, agentic loop failure, max iterations)
- Custom system prompt and web search options

### Tests

`src/services/tools/__tests__/minionIntegration.test.ts`

### Verification

```bash
npm run verify && npm run test:silent
```

---

## Future Enhancements

1. Rollback on error
2. Minion chat viewer UI
3. Cost aggregation to parent chat
4. Minion templates

---

## Summary

| Phase | Scope              | Files                               | Tests                     |
| ----- | ------------------ | ----------------------------------- | ------------------------- |
| 1     | Types & Storage    | types/, storage/                    | minionStorage.test.ts     |
| 2     | Tool Options Types | types/index.ts                      | toolOptions.test.ts       |
| 3     | Return Tool        | returnTool.ts                       | returnTool.test.ts        |
| 4     | Minion Tool        | minionTool.ts, agenticLoop, useChat | minionTool.test.ts        |
| 5     | Tool Options UI    | ProjectSettingsView                 | Snapshot tests            |
| 6     | Minion Display     | MinionResultView, ToolResultBubble  | MinionResultView.test.ts  |
| 7     | Polish & Export    | dataExport, dataImport              | minionIntegration.test.ts |

### Dependencies

```
1 ──► 4 ──► 6 ──► 7
2 ──► 5 ──►
3 ──► 4
```

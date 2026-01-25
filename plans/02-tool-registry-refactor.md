This plan has been completed

# Tool Registry Refactor

## Problem / Request

The current tool registration system has several issues:

1. Tools use factory functions (`initMemoryTool`, `initJsTool`, etc.) that create instances at runtime
2. Tool options are scattered - `jsLibEnabled`, `memoryUseSystemPrompt` are stored in Project, not defined by tools
3. Tool instances maintain state (e.g., `hasShownLibraryLogs` in jsTool for first-call detection)
4. Memory tool has special system prompt injection logic that leaks into the registry
5. The registry dynamically registers/unregisters tools based on project settings

**Goals:**

- App-level static registry storing all ClientSideTool objects
- ProjectSettings shows enable/disable for each tool from registry
- Tool options (like `loadLib`, `useSystemPrompt`) defined IN the tool itself
- Selected tool options passed to `execute()`, which should be stateless
- Make `description`, `inputSchema` functions that take tool options (for dynamic content)
- Make `apiOverrides` a function: `getApiOverride(apiType, toolOptions)`
- Remove factory functions (no more `create*Tool`, `init*Tool`, `dispose*Tool`)
- Memory tool should use the `systemPrompt` function for its custom logic
- JS tool: remove first-call-in-agentic-loop tracking, always show lib output
- Remove "Manage Memory Files" link from ProjectSettings (VFS Manager accessible elsewhere)

---

## Design

### 1. Tool Options Type (Boolean Only)

```typescript
// Per-tool options - keyed by option ID, boolean values only
type ToolOptions = Record<string, boolean>;

// In ClientSideTool
interface ToolOptionDefinition {
  id: string; // e.g., "loadLib"
  label: string; // e.g., "Load /lib Scripts"
  description?: string; // Shown below the toggle in ProjectSettings
  default: boolean;
}
```

### 2. ClientSideTool Interface Changes

```typescript
interface ClientSideTool {
  name: string;
  displayName: string; // For UI in ProjectSettings (e.g., "JavaScript Execution")

  // Can be static or dynamic based on options
  // If function, called with resolved options when building API definitions
  description: string | ((options: ToolOptions) => string);
  inputSchema: InputSchema | ((options: ToolOptions) => InputSchema);

  // Tool-specific boolean options the user can configure per-project
  optionDefinitions?: ToolOptionDefinition[];

  // Stateless execute - receives both input and toolOptions
  execute(
    input: Record<string, unknown>,
    toolOptions: ToolOptions,
    context: ToolContext
  ): Promise<ToolResult>;

  // Dynamic API overrides (replaces static apiOverrides object)
  // Returns undefined to use standard definition (with resolved description/inputSchema)
  getApiOverride?(
    apiType: APIType,
    toolOptions: ToolOptions
  ): BetaToolUnion | ChatCompletionTool | OpenAI.Responses.Tool | undefined;

  // System prompt - can be static string or async function
  // Function receives both context (with apiType) AND toolOptions
  // For memory tool: non-Anthropic APIs always get system prompt injection
  systemPrompt?:
    | string
    | ((context: SystemPromptContext, toolOptions: ToolOptions) => Promise<string> | string);

  // Render helpers (unchanged)
  renderInput?: (input: Record<string, unknown>) => string;
  renderOutput?: (output: string, isError?: boolean) => string;
  iconInput?: string;
  iconOutput?: string;

  // REMOVED: alwaysEnabled field (no longer needed)
}

// Context passed to execute()
interface ToolContext {
  projectId: string;
  chatId?: string;
}

// SystemPromptContext (updated to include apiType)
interface SystemPromptContext {
  projectId: string;
  chatId?: string;
  apiDefinitionId: string;
  modelId: string;
  apiType: APIType; // NEW: needed for memory tool to check if Anthropic
}
```

### 3. Project Schema Changes

```typescript
interface Project {
  // ...existing fields...

  // NEW: which tools are enabled
  enabledTools?: string[]; // ['memory', 'javascript', 'filesystem']

  // NEW: per-tool options
  toolOptions?: Record<string, ToolOptions>;
  // e.g., { memory: { useSystemPrompt: true }, javascript: { loadLib: false } }

  // DEPRECATED (kept for migration only):
  // memoryEnabled, memoryUseSystemPrompt, jsExecutionEnabled, jsLibEnabled, fsToolEnabled
}
```

### 4. Registry API Changes

```typescript
class ClientSideToolRegistry {
  private tools = new Map<string, ClientSideTool>();

  // Called once at app startup with all tool definitions
  registerAll(tools: ClientSideTool[]): void;

  // Get all available tools (for ProjectSettings UI)
  getAllTools(): ClientSideTool[];

  // Get a single tool by name (from all registered tools)
  get(name: string): ClientSideTool | undefined;

  // Check if tool exists in registry
  has(name: string): boolean;

  // Get tool definitions for API
  // - Only includes tools in enabledToolNames
  // - Uses getApiOverride() if available, otherwise builds standard def
  // - Resolves function-based description/inputSchema with toolOptions
  getToolDefinitionsForAPI(
    apiType: APIType,
    enabledToolNames: string[],
    toolOptions: Record<string, ToolOptions>
  ): APIToolDefinition[];

  // Get system prompts from enabled tools
  // - Only includes tools in enabledToolNames
  // - Skips if getApiOverride() returns non-undefined for the apiType
  // - Passes context (with apiType) and toolOptions to systemPrompt function
  getSystemPrompts(
    apiType: APIType,
    enabledToolNames: string[],
    context: SystemPromptContext,
    toolOptions: Record<string, ToolOptions>
  ): Promise<string[]>;

  // Execute tool
  // - Disabled tools treated as non-existing (returns "Unknown tool" error)
  // - Passes toolOptions and context to execute()
  executeClientSideTool(
    toolName: string,
    input: Record<string, unknown>,
    enabledToolNames: string[],
    toolOptions: Record<string, ToolOptions>,
    context: ToolContext
  ): Promise<ToolResult>;

  // For tests only - reset to empty state
  _resetForTests(): void;
}
```

### 5. Tool Definitions

**jsTool:**

```typescript
const jsTool: ClientSideTool = {
  name: 'javascript',
  displayName: 'JavaScript Execution',
  optionDefinitions: [
    {
      id: 'loadLib',
      label: 'Load /lib Scripts',
      description: 'Auto-load .js files from /lib when JS session starts',
      default: true,
    },
  ],
  description: 'Execute JavaScript in a QuickJS sandbox (ES2023)...',
  inputSchema: {
    /* static */
  },
  execute: async (input, toolOptions, context) => {
    const vm = await JsVMContext.create(context.projectId, toolOptions.loadLib ?? true);
    // Always show lib output (no first-call tracking)
    // ...
  },
};
```

**memoryTool:**

```typescript
const memoryTool: ClientSideTool = {
  name: 'memory',
  displayName: 'Memory',
  optionDefinitions: [
    {
      id: 'useSystemPrompt',
      label: '(Anthropic) Use System Prompt Mode',
      description: 'Inject memory listing into system prompt instead of native tool',
      default: false,
    },
  ],
  description: MEMORY_DESCRIPTION,
  inputSchema: MEMORY_INPUT_SCHEMA,

  getApiOverride: (apiType, toolOptions) => {
    // Return Anthropic native tool shorthand only when:
    // 1. API is Anthropic, AND
    // 2. NOT using system prompt mode
    if (apiType === 'anthropic' && !toolOptions.useSystemPrompt) {
      return { type: 'memory_20250818', name: 'memory' };
    }
    // All other cases: return undefined (use standard definition)
    return undefined;
  },

  systemPrompt: async (context, toolOptions) => {
    // System prompt injection rules:
    // - Anthropic with useSystemPrompt=false: NO injection (native tool handles it)
    // - Anthropic with useSystemPrompt=true: YES injection
    // - Non-Anthropic APIs: ALWAYS inject (they don't have native tool support)
    if (context.apiType !== 'anthropic' || toolOptions.useSystemPrompt) {
      return generateMemorySystemPrompt(context.projectId);
    }
    return '';
  },

  execute: async (input, toolOptions, context) => {
    // Stateless - uses VFS APIs directly
    return executeMemoryCommand(context.projectId, input);
  },
};
```

**fsTool:**

```typescript
const fsTool: ClientSideTool = {
  name: 'filesystem',
  displayName: 'Filesystem Access',
  // No options - just enable/disable
  description: "Access the project's virtual filesystem...",
  inputSchema: {
    /* static */
  },
  execute: async (input, toolOptions, context) => {
    // Stateless - uses VFS APIs directly
    return executeFsCommand(context.projectId, input);
  },
};
```

### 6. Data Migration

Migration happens when project is loaded from storage (in useChat.ts or useProject.ts):

```typescript
function migrateProjectToolSettings(project: Project): { project: Project; needsSave: boolean } {
  // Skip if already migrated
  if (project.enabledTools !== undefined) {
    return { project, needsSave: false };
  }

  const enabledTools: string[] = [];
  const toolOptions: Record<string, ToolOptions> = {};

  // Migrate memory tool
  if (project.memoryEnabled) {
    enabledTools.push('memory');
    if (project.memoryUseSystemPrompt) {
      toolOptions.memory = { useSystemPrompt: true };
    }
  }

  // Migrate JS tool
  if (project.jsExecutionEnabled) {
    enabledTools.push('javascript');
    if (project.jsLibEnabled === false) {
      // default is true
      toolOptions.javascript = { loadLib: false };
    }
  }

  // Migrate filesystem tool
  if (project.fsToolEnabled) {
    enabledTools.push('filesystem');
  }

  return {
    project: {
      ...project,
      enabledTools,
      toolOptions: Object.keys(toolOptions).length > 0 ? toolOptions : undefined,
      // Clear deprecated fields
      memoryEnabled: undefined,
      memoryUseSystemPrompt: undefined,
      jsExecutionEnabled: undefined,
      jsLibEnabled: undefined,
      fsToolEnabled: undefined,
    },
    needsSave: true,
  };
}
```

---

## Implementation Plan

### Phase 1: Types & Registry Refactor 

- [x] 1.1 Update `ClientSideTool` interface in `types/index.ts`:
  - Add `displayName?: string` (optional for backward compat)
  - Add `optionDefinitions?: ToolOptionDefinition[]`
  - Change `description` to `string | ((opts: ToolOptions) => string)`
  - Change `inputSchema` to `ToolInputSchema | ((opts: ToolOptions) => ToolInputSchema)`
  - Add `getApiOverride?(apiType: APIType, opts: ToolOptions)`
  - Keep `apiOverrides` field marked as deprecated
  - Keep `alwaysEnabled` field marked as deprecated
  - Update `systemPrompt` signature to `string | ((ctx, opts) => Promise<string> | string)`
  - Update `execute` signature: `execute(input, toolOptions?, context?)`
  - Add `ToolContext`, `ToolOptionDefinition`, `ToolInputSchema` types
  - Update `SystemPromptContext` to include `apiType?: APIType`

- [x] 1.2 Update Project type in `types/index.ts`:
  - Add `enabledTools?: string[]`
  - Add `toolOptions?: Record<string, ToolOptions>`
  - Mark old fields as deprecated in comments

- [x] 1.3 Refactor `ClientSideToolRegistry` in `clientSideTools.ts`:
  - Add `registerAll(tools)` method for static registration at startup
  - Update `getToolDefinitionsForAPI()`:
    - Accept optional `toolOptions` parameter
    - Filter by `enabledToolNames` (legacy: also check alwaysEnabled)
    - Resolve function-based `description`/`inputSchema` with `toolOptions[toolName]`
    - Use `getApiOverride()` when available
  - Update `getSystemPrompts()`:
    - Accept optional `toolOptions` parameter
    - Pass `toolOptions[toolName]` to systemPrompt function
    - Use `getApiOverride()` to check if should skip (returns non-undefined)
  - Update `executeClientSideTool()`:
    - Accept optional `enabledToolNames`, `toolOptions` and `context` parameters
    - When enabledToolNames provided, treat disabled tools as non-existing
    - Pass `toolOptions[toolName]` and `context` to `execute()`
  - Add `getAllTools()` method for ProjectSettings UI
  - Add `_resetForTests()` method for test isolation
  - Keep `register()`/`unregister()` methods marked as deprecated

### Phase 2: Refactor Individual Tools 

- [x] 2.1 Refactor `jsTool.ts`:
  - Define static tool object with `displayName` and `optionDefinitions`
  - Make `execute()` stateless - receive `toolOptions.loadLib` and `context.projectId`
  - Remove `hasShownLibraryLogs` state - always show lib output
  - Remove `initJsTool()`, `disposeJsTool()`, `configureJsTool()`, `isJsToolInitialized()`
  - Remove `JsToolInstance` class wrapper
  - Export static `jsTool` definition for registry

- [x] 2.2 Refactor `memoryTool.ts`:
  - Define static tool object with `displayName` and `optionDefinitions`
  - Implement `getApiOverride(apiType, opts)`:
    - Return native tool only when Anthropic AND not useSystemPrompt
  - Implement `systemPrompt(context, opts)`:
    - Return memory listing when non-Anthropic OR useSystemPrompt
  - Make `execute()` stateless - use VFS APIs directly with `context.projectId`
  - Keep deprecated stubs for `initMemoryTool()`, `disposeMemoryTool()`, etc. (for Phase 3)
  - Export static `memoryTool` definition for registry

- [x] 2.3 Refactor `fsTool.ts`:
  - Define static tool object with `displayName` (no optionDefinitions needed)
  - Make `execute()` stateless - use VFS APIs directly with `context.projectId`
  - Keep deprecated stubs for `initFsTool()`, `disposeFsTool()` (for Phase 3)
  - Export static `fsTool` definition for registry

- [x] 2.4 Create tool registration entry point:
  - Create `src/services/tools/index.ts` that:
    - Imports `jsTool`, `memoryTool`, `fsTool`
    - Exports `registerAllTools()` function that calls `toolRegistry.registerAll([...])`
  - Note: `registerAllTools()` should be called by consumers (Phase 3 will add to main.tsx)

### Phase 3: Update Consumers

- [x] 3.1 Update `useChat.ts`:
  - Added `buildEnabledToolsFromProject()` and `buildToolOptionsFromProject()` helper functions
  - Updated `buildAgenticLoopOptions()` to pass `enabledTools` and `toolOptions`
  - Updated system prompt context to include `apiType`
  - Removed tool init/dispose calls and cleanup in useEffect returns

- [x] 3.2 Update `agenticLoopGenerator.ts`:
  - Added `toolOptions: Record<string, ToolOptions>` to `AgenticLoopOptions`
  - Removed `jsLibEnabled` from `AgenticLoopOptions`
  - Removed `configureJsTool()` import and call
  - Updated `executeClientSideTool()` calls to pass all new parameters
  - Added `toolContext` with projectId/chatId for tool execution

- [x] 3.3 Add subtitle fields to types and tools:
  - Add `displaySubtitle?: string` to `ClientSideTool` interface (tool-level UI description)
  - Add `subtitle?: string` to `ToolOptionDefinition` interface (option-level UI description)
  - Update `memoryTool`:
    - displaySubtitle: "Use a virtual FS to remember across conversations (Optimized for Anthropic)"
    - `useSystemPrompt` option subtitle: "Inject memory listing into system prompt instead of native tool. (Cannot disable for other providers.)"
  - Update `jsTool`:
    - displaySubtitle: "Execute code in a secure sandbox in your browser"
    - `loadLib` option subtitle: "Auto-load .js files from /lib when JS session starts"
  - Update `fsTool`:
    - displaySubtitle: "Read/write VFS files (/memories readonly)"

- [x] 3.4 Implement eager migration in storage layer:
  - Create `migrateProjectToolSettings(project)` function that:
    - Checks if already migrated (`enabledTools !== undefined`)
    - Converts old boolean flags � `enabledTools[]` + `toolOptions{}`
    - Deletes deprecated fields from the object
    - Returns `{ project, migrated: boolean }`
  - Add migration call to `unifiedStorage.getProject()` - migrate and save if needed
  - Add migration call to `unifiedStorage.getProjects()` - migrate each and save if needed

- [x] 3.5 Update `ProjectSettingsView.tsx` for dynamic rendering:
  - Import `toolRegistry.getAllTools()` for available tools
  - Replace hardcoded client-side tool toggles with dynamic rendering:
    - Loop through `getAllTools()` and render toggle for each
    - Use tool's `displayName` for label, `displaySubtitle` for description
    - When tool enabled and has `optionDefinitions`, render nested option toggles
    - Use option's `label` for toggle label, `subtitle` for description
  - Keep server-side tools (Web Search) hardcoded
  - Update state from individual booleans to `enabledTools: string[]` and `toolOptions: Record<string, ToolOptions>`
  - Update `handleSave()` to save `enabledTools` and `toolOptions` to project
  - Remove "Manage Memory Files" link (already done)

- [x] 3.6 Update `useChat.ts` to read migrated format:
  - Remove `buildEnabledToolsFromProject()` and `buildToolOptionsFromProject()` helper functions
  - Read directly from `project.enabledTools ?? []` and `project.toolOptions ?? {}`
  - Migration handled by storage layer now

- [x] 3.7 Add `registerAllTools()` to `main.tsx`:
  - Tools are registered at app startup before React renders

### Phase 4: Cleanup & Documentation

- [x] 4.1 Remove deprecated code:
  - Deleted old init/dispose/configure exports from tool files
  - Removed `alwaysEnabled` references from registry
  - Cleaned up unused imports

- [x] 4.2 Update tests:
  - Updated `clientSideTools.test.ts`:
    - Uses `_resetForTests()` in beforeEach/afterEach instead of register/unregister
    - Updated tests to use new function signatures with toolOptions and context
    - Removed tests for `alwaysEnabled` behavior
  - Updated `memoryTool.test.ts` for stateless execute with context
  - All existing tool tests pass with new stateless architecture
  - Migration function tested implicitly through storage layer

- [x] 4.3 Update `development.md`:
  - Updated "Client-Side Tools" section to reflect new architecture
  - Documented static registration, tool options, and stateless execute
  - Updated Memory Tool, JavaScript Execution Tool, and Filesystem Tool sections
  - Documented Project schema changes (enabledTools, toolOptions)

# GremlinOFA Development Progress

## Documentation Rules

- NO large code blocks - use readable descriptions instead of large code blocks. Small inline code is fine.
- Implementation details belong in Architecture/Implementation sections, not in checklists
  - Document the lifecycle of any resource requires manual release.
- **CRITICAL: This document is a STATE SNAPSHOT, not a development journal.**
  - NO "Recent \*" sections (Recent Fixes, Recent Improvements, Recent Changes, etc.)
  - NO "Completed" or "Done" sections documenting past work. NO "New" feature, no "New" mark in checklist -- the feature is either there or not there.
  - NO chronological narratives or change logs
  - Completed items stay in checklists as [x], but without dates or narratives. If something is done, mark it [x] in the checklist and move on.
  - The ONLY exception: "Known Issues" section for active bugs. Remove when bug is fixed.

Keep it factual, concise, current state only.

## Project Overview

GremlinOFA (Gremlin Of The Friday Afternoon) is a general-purpose AI chatbot web application built with React and Vite that supports multiple AI providers (ChatGPT compatible, Anthropic) with project-based organization and chat management.

**Tech Stack:** React • TypeScript • Vite • React Router • Tailwind CSS • IndexedDB • AES-256-GCM encryption • React Context API • PWA

## Features Status

### Core Features (Implemented)

- [x] Project & chat management with cascading deletion
- [x] Project settings (system prompt, pre-fill, model, temperature, reasoning, web search, message format)
- [x] Chat with streaming responses, message editing, forking, resend, and cost tracking
- [x] Message rendering (Markdown, syntax highlighting, LaTeX math with horizontal scroll, thinking blocks, citations, code block copy)
- [x] Image attachments (resize, compress, multi-select, preview, lightbox)
- [x] Virtual scrolling for long message histories with scroll-to-bottom button
- [x] API clients (OpenAI Responses, OpenAI Chat Completions, Anthropic) with streaming
- [x] Model discovery and caching per API definition
- [x] Pricing system with per-message cost snapshots
- [x] Encrypted storage (IndexedDB + AES-256-GCM)
- [x] Data export/import with re-encryption support
- [x] PWA with offline support and install prompt
- [x] Responsive layout (desktop two-panel, mobile drawer)
- [x] Draft persistence (localStorage with auto-save)

### Pending Features

**Infrastructure & Build**

- [x] Configure build optimization (conditional base path, PWA denylist for /dev)
- [x] Production source maps with runtime mapping for readable stack traces
- [ ] Bundle size analysis (chunk splitting for large KaTeX/highlight.js bundles)

**PWA**

- [ ] Splash screen configuration
- [ ] Update notification system

**Storage & Data**

- [x] Lightweight deployable remote storage (`storage-backend/` - SQLite + Express)
- [x] OOBE wizard (start fresh / import backup / use existing remote data)
- [x] Attachment manager (view, select, delete, delete older than X days, missing attachment handling)
- [x] Storage quota display (local IndexedDB only, shows usage/quota with warning at >100MB or >50%)
- [ ] Data migration between localStorage and remote storage
- [x] Remote storage bulk operations (for faster export/import):
  - [x] Add `exportPaginated()` and `batchSave()` to `StorageAdapter` interface
  - [x] Implement in `RemoteStorageAdapter` (calls `/_export` and `/_batch` endpoints)
  - [x] Implement in `IndexedDBAdapter` (cursor-based pagination, bulk put with transaction)
  - [x] Add tests for both adapters
  - [x] Use in `dataExport.ts` for exporting (removed IndexedDB cursor hack)
  - [x] Use in `dataImport.ts` for faster batch importing

**UI & UX**

- [ ] Dark mode support with toggle
- [ ] Accessibility features (ARIA labels, keyboard navigation)
- [ ] Loading states and skeletons
- [ ] Monochrome emoji

**Chat Features**

- [ ] Background API support (responses continue after navigation)
- [ ] Abort ongoing API calls

**API & Pricing**

- [ ] API key validation
- [x] Pricing display in Model Selector
- [ ] Cache pricing display
- [ ] Script to automatically parse pricing data from api provider's pricing page

**Statistics & Display**

- [x] Token display formatting (##.#k format)
- [x] Cost display precision (3 decimals)
- [x] Chat-level token totals (cumulative)
- [x] Context window usage (recalculated)
- [x] Real-time token usage in chat header
- [x] Incremental cost/token persistence during agent loop (crash-resilient)
- [x] Fork tracking and cost analysis
- [x] Tool call cost tracking (minion sub-agent costs flow into chat totals)
- [x] Minion chat view (read-only overlay, accessible via "View Chat" button in tool result; main chat continues streaming underneath)

**Documentation**

- [x] README with setup instructions
- [ ] User documentation
- [x] Contributing guidelines

**Production & Monitoring**

- [ ] Performance monitoring
- [ ] Error tracking setup
- [x] Never do any analytics integration

### Testing Status

- [x] Core services tested (encryption, compression, storage, CSV helper, data export/import, markdownRenderer)
- [x] Hooks tested (useChat, useProject, useApp, useIsMobile, useIsKeyboardVisible, useAlert, useError, useVirtualScroll, useStreamingAssembler, useAttachmentManager, usePreferences, useMinionChat)
- [x] Chat components tested (MessageBubble, UserMessageBubble, AssistantMessageBubble, LegacyAssistantBubble, MessageList, BackstageView, ErrorBlockView, TextGroupView, ToolResultView, ToolResultBubble, StopReasonBadge, StreamingMessage, CacheWarning, WebLLMLoadingView, MinionChatView)
- [x] Error components tested (ErrorView, ErrorFloatingButton)
- [x] OOBE components tested (OOBEScreen, OOBEComplete)
- [x] Integration tests (import/export roundtrip with 210+ records, duplicate handling, CSV special characters)
- [x] Cross-adapter export/import tests (IndexedDB ↔ Remote, bidirectional sync, pagination, re-encryption)
- [x] Cross-adapter E2E roundtrip tests (fake-indexeddb + live storage-backend, real encryption)
- [x] WebLLM client unit tests (webllmClient, webllmModelInfo, apiService.webllm)
- [x] WebGPU capability detection tests
- [x] Remote storage E2E tests (RemoteStorageAdapter against real storage-backend)
- [ ] E2E tests (full app)

## Data Model

### API Definitions

- Multiple API definitions per provider type (APIType: `responses_api`, `chatgpt`, `anthropic`, `webllm`)
- Each definition: name, icon (optional emoji), baseUrl (optional), apiKey (not required for WEBLLM or when `isLocal` is true)
- `isLocal` flag marks non-WebLLM providers that don't need API keys (e.g., local LLM servers)
- `modelsEndpoint` (optional) - Custom URL for fetching models list without authentication
  - When set, uses plain `fetch()` instead of SDK's model listing API
  - Auto-detects response format: OpenAI-compatible `{ data: [...] }`, plain array `[{...}]`, or string array `["model-1", ...]`
  - Applies OpenRouter metadata (pricing, context window) if present in response
- `isDefault` flag marks system-provided definitions (can be deleted by users)
- **Default creation**: On first run, one default definition created per API type for discoverability
- **Deletion**: Users can delete any definition including defaults; won't respawn unless entire API type is missing
- **Spawning logic**: Checks by `apiType` (not name), preventing duplicates when renaming definitions
- Model lists cached per definition

### Projects

Projects organize chats with shared settings:

- **Name** and **Icon** (default: 📁)
- **System prompt** (via `SystemPromptModal`) and **Pre-fill response** (in Advanced section)
- **Default API definition/model** (required)
- **Anthropic reasoning**: enable toggle + budget tokens (default: 1024) + keep thinking turns
- **OpenAI/Responses reasoning**: effort (`undefined` = auto), summary (`undefined` = auto)
- **Web search** toggle
- **Message format**: three modes (user message / with metadata / use template)
- **Tools**: Memory (Anthropic only), JavaScript Execution, Filesystem, Sketchbook, Checkpoint
- **Advanced** (collapsed): temperature, max output tokens (default: 1536), disable streaming, extended context (1M)

### Chats

- Organized under projects, inherit project settings
- Can override API definition/model per chat
- Store message history with metadata (tokens, model, timestamps)
- Track sink cost (accumulated from deleted messages)

### Attachments

Stored separately from messages for efficient management:

- Separate `attachments` table in IndexedDB (base64-encoded, encrypted)
- Supported: JPEG, PNG, GIF, WebP (up to 10 per message)
- Auto-resize (max 1920px), quality optimization (0.85 for JPEG)
- **Immediate processing**: Files processed on selection (not on send) to prevent performance issues with large HDR images
- **Lightbox preview**: Click thumbnails in sent messages to view full-size (`ImageLightbox` component)
- Lifecycle: cascade deletion, fork support (copied with new IDs), edit reattachment

## Architecture

### Code Organization

Tests are co-located with source files in `__tests__/` subdirectories following the pattern `ComponentName.test.tsx` or `moduleName.test.ts`.

```
src/
├── components/     # UI: Sidebar, Modals, project/, chat/, ui/
├── contexts/       # React Context providers (App, Alert, Error)
├── hooks/          # Custom hooks (useChat, useProject, useVirtualScroll, etc.)
├── services/       # Business logic subdirectories:
│   ├── api/        # API clients, pricing modules, stream mappers
│   ├── compression/# Gzip compression using Compression Streams API
│   ├── encryption/ # AES-256-GCM encryption service
│   ├── storage/    # Storage adapters (IndexDB and RemoteStorage), unified storage API
│   └── streaming/  # StreamingContentAssembler for real-time rendering
├── types/          # TypeScript definitions (entities, content blocks)
├── utils/          # Utilities (CSV, image processing, markdown, formatters)
├── constants/      # Static data (emoji list)
└── test/           # Test configuration (Vitest setup)
public/             # Static assets and PWA icons
```

### Storage & Encryption

**Storage Adapter Pattern:**

- `StorageAdapter.ts` interface defines adapter contract
- Adapters: `IndexedDBAdapter.ts` (local), `RemoteStorageAdapter.ts` (remote API)
- `unifiedStorage.ts` high-level API wraps adapter operations
- `storageConfig.ts` stores user's storage mode preference (localStorage key: `gremlinofa_storage_config`)
- **Auto-routing**: `index.ts` reads config at startup and creates the appropriate adapter automatically
- Factory functions: `createStorage()` and `createStorageAdapter()` for creating instances (useful for migration/sync)
- Tables: `api_definitions`, `models_cache`, `projects`, `chats`, `messages`, `attachments`, `memories`, `memory_journals`, `app_metadata`, `vfs_meta`, `vfs_files`, `vfs_versions`
- All tables have the same columns

**Remote Storage:**

- `RemoteStorageAdapter` connects to `storage-backend/` via REST API
- Auth: Basic authentication with userId + optional password
- userId derived from CEK via `encryptionService.deriveUserId()` (PBKDF2-SHA256, 600k iterations, 64-char hex)
- userId is computed once during OOBE and stored in `StorageConfig` (avoids async derivation at runtime)
- Password hashing: User-entered password is hashed via `hashPassword()` (SHA-512 with `|gremlinofa` salt) before storage/transmission, preventing plaintext password leakage if users reuse common passwords
- Config type: `StorageConfig = { type: 'local' } | { type: 'remote'; baseUrl; password; userId }`

**Storage Entry Point (`index.ts`):**

- `createStorageAdapter(config?)` factory creates appropriate adapter based on provided config (or reads from localStorage if not provided)
- `createStorage(config?)` factory creates new `UnifiedStorage` instance with explicit config (useful for OOBE, migration/sync scenarios)
- Default `storage` export is a singleton created at module load time (reads config from localStorage)

**Encryption:**

- CEK (Content Encryption Key): 32-byte random key, auto-generated on first run
- CEK storage: localStorage (`chatbot_cek`) in base32 format (52 characters)
- Data encryption: AES-256-GCM with random IV per operation
- Backward compatibility: base64-encoded CEKs supported for import
- Format conversion: Data Manager offers one-click base64→base32 conversion for legacy CEKs

**Storage Quota Display:**

- `StorageAdapter.getStorageQuota()` returns `{ usage: number; quota: number } | null`
- `IndexedDBAdapter` uses `navigator.storage.estimate()` (browser Storage API)
- `RemoteStorageAdapter` returns `null` (quota tracking requires backend support)
- Displayed on Welcome screen and Data Manager page (local storage only)
- Color coding: gray (≤50%), yellow (>50%), red (>80%)
- Warning banner shown when usage >100MB OR usage >50% of quota
- Format: `💾 Storage: 150 MB / 2 GB (8%)`
- Utility functions in `src/utils/formatBytes.ts`: `formatBytes()`, `formatStorageDisplay()`, `shouldShowStorageWarning()`

**Data Compression:**

- Messages and model caches compressed with gzip before encryption (60-80% space savings)
- Uses browser's Compression Streams API (native, no dependencies)
- Binary-direct approach: compress → prepend "GZ" bytes → encrypt
- "GZ" indicator bytes `[71, 90]` prepended to detect compressed data on read
- Automatic detection on read (backward compatible with uncompressed data)
- Bulk compression tool in Data Manager for migrating old uncompressed messages

**Data Import/Export:**

- CSV format (RFC 4180 compliant) with all tables
- Re-encryption workflow: decrypt with source CEK → re-encrypt with app CEK
- Duplicate ID handling: skip existing records, except for API definitions with empty credentials (overwrite allowed)
- Default API definitions: exported only if they have credentials (apiKey or custom baseUrl) filled in; imported with merge logic (overwrite if local has empty credentials)
- **Unified bulk operations** via `StorageAdapter` interface:
  - `exportPaginated(table, afterId?, columns?)` - cursor-based pagination (200 rows/20MB limits), returns `{ rows, hasMore }`. Optional `columns` array to fetch only specific fields.
  - `batchSave(table, rows, skipExisting)` - atomic batch writes, returns `{ saved, skipped }`
  - `batchGet(table, ids, columns?)` - fetch multiple records by ID in one request, returns `{ rows }`. Optional `columns` array for partial records.
  - Works identically for both `IndexedDBAdapter` and `RemoteStorageAdapter`
  - 10-100x faster imports to remote storage (100 records/request vs 1)
- **Streaming import**: Memory-efficient chunked parsing for large backups (handles 300MB+ on iOS)
  - `streamCSVRows()` async generator reads file in 64KB chunks via FileReader
  - `parseCSVChunk()` maintains state across chunks for RFC 4180 compliance
  - Batches records by table (100 per batch), flushes on table boundary or batch full
  - Uses `batchSave()` for atomic writes with proper duplicate handling
- **Streaming export**: Cursor-level streaming with chunked blob assembly
  - `streamExportCSVLines()` async generator uses `exportPaginated()` for all adapter types
  - Handles pagination automatically (continues until `hasMore: false`)
  - `createExportBlob()` assembles Blob in chunks of 100 lines (configurable)
  - Memory footprint: ~1 page of records at a time + Blob chunks

### API Architecture

**API Types:**

- `APIType` = protocol/client template (ChatGPT, Anthropic, WebLLM)
- `APIDefinition` = configured instance (e.g., "xAI", "OpenRouter")

**StreamOptions** (in `baseClient.ts`):

- `temperature?: number` - Model temperature
- `maxTokens: number` - Max output tokens
- `enableReasoning: boolean` - Anthropic: enable thinking blocks
- `reasoningBudgetTokens: number` - Anthropic: budget for thinking
- `thinkingKeepTurns?: number` - Anthropic: thinking block preservation (`undefined` = model default, `-1` = keep all, `0+` = keep N turns). Opus 4.5 keeps all by default; others keep 1 turn.
- `reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'` - OpenAI/Responses: reasoning effort level (`undefined` = auto)
- `reasoningSummary?: 'auto' | 'concise' | 'detailed'` - OpenAI/Responses: summary mode (`undefined` = auto)
- `systemPrompt?: string` - System prompt
- `preFillResponse?: string` - Pre-fill assistant response (Anthropic only)
- `webSearchEnabled?: boolean` - Enable web search
- `enabledTools?: string[]` - Enabled client-side tools
- `extendedContext?: boolean` - Anthropic: opt into 1M context window beta (`context-1m-2025-08-07` header). Models with `supportsExtendedContext` in metadata: Opus 4.6, Sonnet 4.5, Sonnet 4. Above 200K input tokens, all tokens charged at premium rates (2x input, 1.5x output).
- `checkpointMessageId?: string` - Context swipe: message ID of the last checkpoint (triggers pre-checkpoint trimming)
- `swipeToolNames?: Set<string>` - Context swipe: tool names whose blocks should be removed from pre-checkpoint messages

**API Clients:**

- Base client with shared streaming logic
- `ResponsesClient` (OpenAI Responses API with reasoning, vision, web search)
- `OpenAIClient` (Chat Completions with o-series/GPT-5 support)
- `AnthropicClient` (thinking blocks, prompt caching, web search/fetch, citations, Bedrock via `@anthropic-ai/bedrock-sdk` - see below)
- `BedrockClient` (AWS Bedrock Converse API for non-Claude models - see Bedrock Client section below)
- `WebLLMClient` (local inference via WebGPU, no API key required)
  - Runs models entirely in browser using WebGPU
  - Default API definition created on first run
  - Models cached in browser storage
  - Zero cost (all calculations return $0)
  - Requires WebGPU-compatible browser (Chrome 113+, Edge 113+, Safari 18+)
  - VRAM compatibility checking via `webgpuCapabilities.ts` (estimates from `maxBufferSize * 2`)
  - Model selector shows VRAM warnings, disables incompatible models
  - Enhanced error messages for common issues (OOM, WebGPU init, network, storage)
  - Model metadata (VRAM, download size, context window) from WebLLM's `prebuiltAppConfig`
  - Loading state observable via `subscribeToLoadingState()` for UI progress display
  - Engine lifecycle: singleton per session; when switching models, unloads current before loading new; `disposeEngine()` available to release GPU memory

**AnthropicClient Bedrock Support:**

`AnthropicClient` can route through AWS Bedrock using `@anthropic-ai/bedrock-sdk` as a drop-in replacement. This provides a simpler alternative to `BedrockClient` for Claude models on Bedrock.

- **Endpoint Detection**: `baseUrl` is checked for Bedrock patterns
- **Shorthand Format**: `bedrock:us-east-2` - SDK auto-generates URL from region
- **Full URL Format**: `https://bedrock-runtime.us-east-2.amazonaws.com` (for custom endpoints/proxies)
- **Authentication**: Bearer token injected via `Authorization` header using `defaultHeaders`
- **Model Discovery**: Uses `@aws-sdk/client-bedrock` with `ListFoundationModelsCommand({ byProvider: 'Anthropic' })` + `ListInferenceProfilesCommand` (most models require inference profiles)
- **Model Family**: Messages stored as `modelFamily: 'anthropic'` (same as direct Anthropic API)

Usage: Create an Anthropic API definition with `baseUrl` set to `bedrock:us-west-2` (or full URL) and enter your API key.

**Bedrock Client:**

AWS Bedrock Converse API support via `@aws-sdk/client-bedrock` and `@aws-sdk/client-bedrock-runtime`.

- **Endpoint Shorthand**: `baseUrl` supports multiple formats for convenience:
  - `us-west-2` - Just the region (simplest)
  - `bedrock:us-west-2` - Explicit bedrock prefix
  - `https://bedrock-runtime.us-west-2.amazonaws.com` - Full URL
- **Authentication**: Bearer token via `token` config option (API key-based, not IAM credentials)
- **Model Discovery**: Multi-phase discovery process:
  1. Primary region: `ListFoundationModelsCommand` + `ListInferenceProfilesCommand` + `ListImportedModelsCommand` + `ListCustomModelsCommand` in parallel
  2. Cross-region: Collects regions from inference profile ARNs, fetches foundation models from other regions to get accurate modality data
  3. Imported/Custom models added from primary region only (they don't have cross-region profiles)
- **Supported Models**: Claude, Llama, Mistral, Amazon Titan (all models with TEXT output modality), plus user-imported and custom (fine-tuned/distilled) models
- **Model ID Format**: Foundation models use `provider.model-name-version`, inference profiles use `inferenceProfileId` (e.g., `us.anthropic.claude-3-5-sonnet-20241022-v2:0`), imported/custom models use full ARN
- **Region Tracking**: Inference profiles store `region: string[]` with all available regions (e.g., `["us-east-1", "us-west-2"]`)
- **Model Naming**: Imported models prefixed with `[Imported]`, custom models prefixed with `[Custom]`

**Streaming:**

- Default: `ConverseStreamCommand` for real-time responses
- Non-streaming: `ConverseCommand` when `disableStream: true`
- Both paths convert to unified `StreamChunk` types via `bedrockStreamMapper.ts`

**Content Block Types:**

- TextMember (`{ text: string }`)
- ToolUseMember (`{ toolUse: { toolUseId, name, input } }`)
- ToolResultMember (`{ toolResult: { toolUseId, content, status } }`)
- ReasoningContentMember (`{ reasoningContent: { reasoningText: { text, signature? } } }`)
- CitationsContentMember (`{ citationsContent: {...} }`)
- ImageMember (`{ image: { format, source: { bytes } } }`)

**Reasoning Support:**

- Model type detection via `detectBedrockReasoningType(modelId)`:
  - Claude 3.x → `thinking` config (budget_tokens)
  - Claude 4+ → `reasoning_config` (budget_tokens)
  - Nova 2 → `reasoningConfig` with `maxReasoningEffort` (low/medium/high). Nova 1 models don't support reasoning.
  - DeepSeek → `showThinking` boolean
- Config built via `buildReasoningConfig(modelType, options)`
- Budget controlled via `reasoningBudgetTokens` (Claude), effort via `reasoningEffort` (Nova 2)

**Stream Mapper Pattern:**

- Separates provider-specific event mapping from client logic
- Event → MapperState → StreamChunk[] (stateful transformation)
- Mappers: `anthropicStreamMapper.ts`, `responsesStreamMapper.ts`, `completionStreamMapper.ts`, `bedrockStreamMapper.ts`
- `completionFullContentAccumulator.ts` - Accumulates streaming chunks to build fullContent for Chat Completions (content + tool_calls, excludes reasoning which can't be sent back to API)
- `bedrockFullContentAccumulator.ts` - Accumulates raw Bedrock stream events to build fullContent (all 6 ContentBlock types: Text, ToolUse, ToolResult, Reasoning, Citations, Image)

### Message Content Architecture

Messages store content in multiple fields, each serving a distinct purpose:

| Field              | Scope        | Purpose                                                                                                                                                     |
| ------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fullContent`      | API-aware    | Authoritative model output as-is from the API. Used for context assembly when chat's `apiType` matches the message's `modelFamily`. Stored using SDK types. |
| `content`          | API-agnostic | Plain text fallback. Used when user switches API provider mid-chat (apiType mismatch).                                                                      |
| `renderingContent` | API-agnostic | Pre-grouped `RenderingBlockGroup[]` for UI display. May transform content for better presentation.                                                          |
| `metadata`         | API-agnostic | Token usage, cost, context window stats.                                                                                                                    |

**Principle**: `fullContent` is authoritative for API interactions. `renderingContent` is for display only—never use it for context assembly.

**API Boundary Components:**

Only these components are aware of provider SDK types. All other code uses unified types.

| Component                | Per-API?    | Purpose                                                                              |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------ |
| `APIClient`              | Yes         | `anthropicClient`, `openaiClient`, `responsesClient`, `webllmClient`                 |
| `StreamMapper`           | Yes         | Converts SDK stream events to unified `StreamChunk` types                            |
| `FullContentAccumulator` | When needed | Builds `fullContent` from streaming chunks when SDK doesn't provide `finalMessage()` |

**Streaming Data Flow:**

```
SDK Stream Events
    ↓
StreamMapper → StreamChunk[] (unified events)
    ↓
StreamingContentAssembler → renderingContent (for UI)

SDK finalMessage() or FullContentAccumulator → fullContent (for storage/replay/agentic logic)
```

**Non-Streaming Data Flow:**

Non-streaming responses generate synthetic `StreamChunk` events to reuse the same rendering pipeline:

```
Response Message → convertMessageToStreamChunks() → StreamChunk[]
                                                        ↓
                                        StreamingContentAssembler → renderingContent

Response Message → createFullContentFromMessage() → fullContent
```

**fullContent Priority:**

1. Use SDK's `finalMessage()` when available (most authoritative)
2. Otherwise use `FullContentAccumulator` to assemble from stream
3. Stay true to the stream—don't omit or transform content

**Cross-Provider Compatibility:**

When `chat.apiType !== message.modelFamily`, the message was created by a different provider. In this case, context assembly falls back to `content` (plain text) instead of `fullContent`, since provider-specific types won't be compatible.

**Client-Side Tools:**

- `src/services/tools/clientSideTools.ts` - Tool registry and execution
- Static registration at startup: `registerAllTools()` called in `main.tsx` before React renders
- Available tools: `memory`, `javascript`, `filesystem`, `sketchbook`, `checkpoint`
- Tool definitions sent to API via `getToolDefinitionsForAPI(apiType, enabledToolNames, toolOptions)`
- Execution via `executeClientSideTool(toolName, input, enabledToolNames, toolOptions, context)`
- `ClientSideTool` interface:
  - `displayName?: string` - Display name for UI (falls back to `name`)
  - `displaySubtitle?: string` - Description shown below toggle in ProjectSettings
  - `internal?: boolean` - Internal tools not shown in ProjectSettings UI (e.g., `return` for minions)
  - `complex?: boolean` - Complex tools run in a later phase after simple tools (e.g., `minion`)
  - `optionDefinitions?: ToolOptionDefinition[]` - Tool-specific boolean options configurable per-project
  - `description: string | ((opts) => string)` - Static or dynamic description based on toolOptions
  - `inputSchema: ToolInputSchema | ((opts) => ToolInputSchema)` - Static or dynamic input schema
  - `execute(input, toolOptions, context): AsyncGenerator<ToolStreamEvent, ToolResult>` - All tools are async generators. Simple tools return without yielding; streaming tools (e.g., minion) yield `groups_update` events.
  - `getApiOverride?(apiType, toolOptions)` - Returns provider-specific tool definition or undefined
  - `systemPrompt?: string | ((ctx, opts) => Promise<string> | string)` - Static or dynamic system prompt
  - `renderInput?: (input) => string` - Transform tool input for display in BackstageView (default: JSON.stringify)
  - `renderOutput?: (output, isError?) => string` - Transform tool output for display (default: raw content)
  - `iconInput?: string` - Emoji/unicode icon for tool_use blocks (default: 🔧)
  - `iconOutput?: string` - Emoji/unicode icon for tool_result blocks (default: ✅/❌)
- **Tool Options System** (Project schema):
  - `enabledTools?: string[]` - List of enabled tool names (e.g., `['memory', 'javascript', 'filesystem']`)
  - `toolOptions?: Record<string, ToolOptions>` - Per-tool options keyed by tool name
  - `ToolOptions = Record<string, ToolOptionValue>` where `ToolOptionValue = boolean | string | ModelReference | ModelReference[]`
  - `ModelReference = { apiDefinitionId: string; modelId: string }` for model selection options
  - `ToolOptionDefinition` is a discriminated union with four types:
    - `BooleanToolOption`: `{ type: 'boolean'; id; label; subtitle?; default: boolean }`
    - `LongtextToolOption`: `{ type: 'longtext'; id; label; subtitle?; default: string; placeholder? }`
    - `ModelToolOption`: `{ type: 'model'; id; label; subtitle? }` (no default, prepopulated from project)
    - `ModelListToolOption`: `{ type: 'modellist'; id; label; subtitle? }` (initialized to `[]`)
  - Type guards: `isBooleanOption()`, `isLongtextOption()`, `isModelOption()`, `isModelListOption()`, `isModelReference()`, `isModelReferenceArray()`
  - `initializeToolOptions(existing, optionDefs, projectContext)` - Initializes options with defaults, preserves existing values
  - Migration: Storage layer auto-migrates old boolean flags on project load (see `migrateProjectToolSettings()` in `unifiedStorage.ts`)
  - Legacy fields (`memoryEnabled`, `jsExecutionEnabled`, etc.) cleared after migration
- **Persisted rendering**: Tool render functions are called at message save time, not render time:
  - `ToolUseRenderBlock.renderedInput` and `ToolUseRenderBlock.icon` populated in `useChat` after `finalize()`
  - `ToolResultRenderBlock.renderedContent` and `ToolResultRenderBlock.icon` populated when creating tool result blocks
  - `BackstageView` uses persisted fields with fallback to defaults (backward compatible)
  - Ensures tool blocks display correctly even if tool is later disabled
- System prompt construction in `useChat.ts`:
  - `toolRegistry.getSystemPrompts(apiType, enabledTools)` returns prompts from enabled tools
  - Combined: `[project.systemPrompt, ...toolPrompts].filter(Boolean).join('\n\n')`
- API-specific format generation:
  - **Anthropic**: `{ name, description, input_schema }` or custom override
  - **OpenAI/Responses**: `{ type: 'function', function: { name, description, parameters } }`
- `memory` tool provides persistent virtual filesystem (see Memory Tool section below), dynamically registered/unregistered per project; two modes:
  - **Native mode (default)**: Uses Anthropic's `memory_20250818` shorthand via `apiOverrides`
  - **System prompt mode**: Injects memory listing + README.md into system prompt (toggle in Project Settings)
- Agentic loop in `useChat.ts` handles `stop_reason: 'tool_use'`:
  1. Extract `tool_use` blocks from `fullContent`
  2. Execute client-side tools locally
  3. Build `tool_result` messages with `renderingContent`
  4. Save intermediate messages to storage + update UI state
  5. Send continuation request
  6. Loop until `stop_reason !== 'tool_use'` or max iterations (50)
- **Unresolved tool call recovery**: When a response ends with unresolved `tool_use` blocks (e.g., token limit reached mid-agentic-loop):
  1. `unresolvedToolCalls` detected via `getUnresolvedToolCalls()` in `useChat.ts`
  2. `PendingToolCallsBanner` shows in MessageList with Reject/Accept buttons
  3. User actions:
     - **Reject button**: Sends error "Token limit reached, ask user to continue"
     - **Accept button**: Delegates tool execution to the agentic loop (`pendingToolUseBlocks`) for streamed execution with live status updates
     - **User sends message**: Sends reject response along with user's message
  4. ChatInput send button enabled even with empty input when pending tools exist
- Intermediate messages persisted with proper `renderingContent`:
  - Assistant messages with `tool_use` render in `BackstageView` as expandable "Calling [tool_name]" blocks
  - User messages with `tool_result` render via `ToolResultBubble` (detected by `fullContent` containing `tool_result` blocks)

**Pricing:**

- Standalone modules per provider with model matching (exact, prefix, fallback)
- Per-message pricing snapshots stored with metadata
- Web search count tracked per message and included in cost calculation
- Cost unreliability detection:
  - Model's `matchedMode` is 'unreliable' or 'default' (unknown model)
  - Any price is undefined when corresponding usage count is non-zero
  - `costUnreliable` flag propagated from messages to chat
  - UI shows "(unreliable)" tag in chat status bar and project chat list

### Rendering System

**Content Types** (`src/types/content.ts`):

- `RenderingBlockGroup` with category (backstage/text/error)
- Block types: `ThinkingRenderBlock`, `TextRenderBlock`, `WebSearchRenderBlock`, `WebFetchRenderBlock`, `ToolUseRenderBlock`, `ToolResultRenderBlock`, `ToolInfoRenderBlock` (with `displayName`, `apiDefinitionId`, `modelId`), `ErrorRenderBlock`
- `RenderingBlockGroup.isToolGenerated?: boolean` — marks tool-generated content for distinct styling
- `ToolResultRenderBlock.renderingGroups?: RenderingBlockGroup[]` — nested content from tool's internal work (e.g., minion sub-agent)
- Citations pre-rendered as `<a class="citation-link" data-cited="...">` tags

**Design Principles:**

1. API-agnostic rendering format (provider-specific `fullContent` preserved separately)
2. Backstage/frontstage separation (thinking/tools collapsible, text visible)
3. Pre-grouped storage (avoid runtime grouping)
4. Text consolidation (continuous text blocks merged)

**User Message renderingContent:**

- User messages store original input in `renderingContent` as `TextRenderBlock`
- Format: `[{ category: 'text', blocks: [{ type: 'text', text: originalInput }] }]`
- Display extracts text from renderingContent, falls back to `stripMetadata(content)` for old messages
- Separates API payload (`content` with metadata) from display (`renderingContent` without metadata)

**StreamingContentAssembler:**

- Assembles `StreamChunk` events into `RenderingBlockGroup[]` during streaming
- Single source of truth for rendering content conversion (streaming path uses `finalize()`)
- Maintains object stability for React optimization (blocks mutated in place)
- Text consolidation: consecutive text blocks reused instead of creating new ones
- Citation handling: `citations_delta` events accumulated during text blocks, rendered as `<a>` tags on block end
- `finalize()` returns deep copy for storage; `finalizeWithError()` appends error block
- `migrateMessageRendering()` on clients retained only for migrating old messages without `renderingContent`

**Component Structure:**

```
MessageList.tsx                    # Container with virtual scrolling
├── MessageBubble.tsx              # Container with virtual scrolling logic, delegates rendering
│   ├── UserMessageBubble.tsx      # User messages (blue bubble, attachments, edit/fork/copy/dump JSON)
│   ├── ToolResultBubble.tsx       # Tool result messages (role: USER with tool_result blocks, delete action)
│   ├── AssistantMessageBubble.tsx # Assistant messages with renderingContent (new format)
│   │   ├── BackstageView          # Collapsible thinking/search/fetch/tool_use/tool_result
│   │   ├── ErrorBlockView         # Collapsible error with stack trace
│   │   ├── TextGroupView          # Text with citations
│   │   └── StopReasonBadge        # Stop reason display
│   └── LegacyAssistantBubble.tsx  # Legacy assistant messages (markdown fallback)
└── StreamingMessage.tsx           # In-progress responses
```

**Rendering Pipeline:**

1. Markdown parsing (`marked`) with custom extensions for math and code
2. Math rendered inline via KaTeX during token processing
3. Code blocks syntax highlighted (`highlight.js`) with copy button
4. HTML sanitization (`DOMPurify`)

**Math Rendering (via marked extensions):**

- Implemented as marked tokenizer/renderer extensions in `markdownRenderer.ts`
- Validation logic in `mathRenderer.ts` with swappable `MathRenderer` interface
- KaTeX for rendering (fast, ~200KB bundle)
- Delimiters: `$...$` (inline), `$$...$$` (display block)
- **Code block protection**: Math inside `` `code` `` or ` ``` ` fenced blocks is preserved (not rendered)
- Escaped `\$` not treated as math delimiter; backticks in math content rejected
- Display math allows multiline; inline math single-line only
- Try-and-skip algorithm for inline math:
  1. Find first `$`, find second `$`, validate content
  2. If valid math → emit token, consume both `$`
  3. If NOT valid → return undefined, let marked try next pattern
- Two-stage validation to prevent false positives:
  1. Quick bailout: content must have math indicators (`\ { } ^ _ + * / = ( ) [ ] & % # ~ < >`) or be single character
  2. Minus sign (`-`) requires context: must be followed by space/digit/dot (rejects hyphens like `x-y`)
  3. KaTeX validation: remaining candidates validated by KaTeX parser
- Handles currency correctly: `$1.5, $(x^2)$` extracts only `(x^2)`, `$20 for $\frac{1}{4}$` extracts only `\frac{1}{4}`
- **Mobile scrolling**: Display math (`.katex-display`) has `overflow-x: auto` for horizontal scroll on small screens; inline math (`.katex`) has `max-width: 100%` with overflow handling

**Note:** Streaming messages display raw text (no markdown/highlighting) for performance. Full rendering applies only to finished messages.

### Virtual Scrolling

- `useVirtualScroll` hook with IntersectionObserver (5 screen heights buffer)
- **Scroll container as root**: Observer uses the scroll container element as `root` instead of viewport, ensuring accurate intersection detection in nested scroll contexts
- **Buffer calculation**: Uses pixel-based `rootMargin` (`containerHeight * bufferScreens`px) instead of percentages for reliable cross-browser behavior
- **Minimum buffer**: 600px minimum container height ensures reasonable buffer on small screens
- **Pending registration queue**: Handles race condition where ref callbacks fire before observer is ready
- Height caching: measured synchronously on mount, tracked via ResizeObserver
- Placeholders: render `<div style={{height: cachedHeight}}>` when offscreen
- Flicker-free: messages render fully → measure → hide if outside buffer
- Performance: 1000+ messages → ~20 DOM nodes
- Scroll-to-bottom floating button (appears when scrolled up)
- Auto-scroll correction after streaming ends (handles overscroll from markdown rendering)
- Debug logging: console.debug messages track observer creation, rootMargin, and element visibility changes

### Attachment Manager

**Architecture:**

- `useAttachmentManager` hook manages state and operations
- `AttachmentManagerView` main view (accessible via `/attachments` route from Data Manager)
- `AttachmentSection` displays attachments grouped by chat with lazy loading
- `DeleteOlderThanModal` bulk delete with preview count

**Data Flow:**

1. Open `/attachments` → `useAttachmentManager.loadSections()` calls `storage.getAllAttachmentSections()`
2. Batch traversal: `attachments → messages → chats → projects`
   - Uses `exportPaginated` to get all attachments (no decryption, just metadata)
   - Uses `batchGet` to fetch related messages, chats, projects in batches
   - Only chats/projects are decrypted (for names); attachments and messages use metadata columns
3. Build `AttachmentSection[]` with metadata only (no image data decrypted yet)
4. Render sections with placeholders
5. Section becomes visible (IntersectionObserver) → `loadSectionData(chatId)` decrypts attachment data
6. Section leaves viewport → `unloadSectionData(chatId)` releases memory
7. Re-render section with actual images (or placeholders when unloaded)

**Memory Management:**

- IntersectionObserver tracks both enter and leave events (2 screen heights buffer)
- `loadedData` Map stores decrypted base64 image data per chat section
- Data is unloaded when section scrolls out of buffer zone to prevent OOM crashes
- Prevents memory accumulation when scrolling through hundreds of attachments

**Storage Methods** (`unifiedStorage.ts`):

- `getAllAttachmentSections()` - Walks hierarchy, returns flat records with chat/project metadata
- `deleteAttachment(id)` - Single deletion, returns affected messageId
- `deleteAttachmentsOlderThan(days)` - Bulk delete, returns `{ deleted, updatedMessageIds }`
- `updateMessageAttachmentIds(chatId, messageId, newIds)` - Updates message after attachment removal

**UI Features:**

- Sections sorted by chat timestamp (descending) with relative time display ("X days ago")
- Multi-select with per-section "Select All" (supports indeterminate state)
- Floating action bar when items selected (count + delete button)
- "Delete older than X days" with preview count before confirmation
- Delete result toast notification

**Missing Attachment Handling** (`useChat.ts`):

- User messages store `originalAttachmentCount` at send time to track how many attachments were originally included
- On `sendMessageToAPI()`, compares `originalAttachmentCount` with currently loaded attachments
- If missing: prepends `<system-note>X attachment(s) removed to save space.</system-note>\n\n` to message content
- Filters `attachmentIds` to only include found ones for API payload
- Backward compatible: falls back to `attachmentIds.length` for messages without `originalAttachmentCount`

### Error Handling System

**API Error Handling:**

- API clients (OpenAI, Responses, Anthropic) return errors in `StreamResult.error`
- No error chunks are yielded during streaming - errors are returned at end
- `StreamResult.error` contains `{ message, status?, stack? }`
- `useChat` hook uses `StreamingContentAssembler.finalizeWithError()` to append error blocks

**Error Boundary:**

- Non-blocking error boundary that logs errors and continues rendering
- Global error capture (`window.onerror`, `unhandledrejection`)
- Errors stored in ErrorContext with message, stack trace, and timestamp

**Source Map Resolution:**

- Production builds generate source maps (`build.sourcemap: true`)
- `stackTraceMapper.ts` uses `stacktrace-js` library to map minified stacks to original source
- Stack mapping is async - shows "Mapping..." badge while fetching `.map` files
- Mapped stacks show "Source Mapped" badge with original file names and line numbers
- Graceful fallback: if mapping fails, original minified stack is displayed
- Console stack traces are mapped automatically by browser DevTools

**Error UI:**

- `ErrorFloatingButton` (bottom-left): Shows error count badge, hidden when no errors
- `ErrorView` modal: Displays error list with navigation (prev/next), stack trace always visible
- Actions: Dismiss individual errors or clear all
- Streaming errors display via `ErrorRenderBlock` in message `renderingContent`

**Context/Hook:**

- `ErrorContext` + `ErrorProvider` wraps app at root level
- `useError()` hook provides `errors`, `addError`, `removeError`, `clearErrors`

### UI & Navigation

**Routing** (React Router v7 with HashRouter):

- `/` - Welcome screen
- `/project/:projectId` - Project view (shows default model under title)
- `/project/:projectId/settings` - Project settings
- `/project/:projectId/vfs/*` - VFS Manager (memory files, supports deep links to paths)
- `/chat/:chatId` - Chat conversation
- `/attachments` - Attachment manager
- `/settings` - API definitions configuration
- `/data` - Data management (export, import, compression, CEK)

**Responsive Design:**

- Breakpoint: 768px (md)
- Desktop: Side-by-side two-panel (sidebar 280px fixed)
- Mobile: Overlay drawer, hamburger menu per view
- `useIsMobile()` hook for responsive components (no prop drilling)

**VFS Manager:**

UI for viewing and editing files stored in the VFS (memory tool). Accessible from Project Settings > Tools > Memory > "Manage Memory Files" link.

Component structure:

```
VfsManagerView (page at /project/:projectId/vfs)
├── Header (back to project settings, title)
├── Desktop Layout (side-by-side via flex)
│   ├── VfsDirectoryTree (left panel ~40%)
│   └── Content panel (right ~60%): VfsFileViewer / VfsFileEditor / VfsDiffViewer
└── Mobile Layout
    ├── VfsDirectoryTree (full width)
    └── VfsFileModal (when file selected)
```

Features:

- **Directory tree**: Expand/collapse directories, lazy loading, file sizes
- **File viewer**: Read-only content display with version badge, binary file preview (images rendered, others show download button), MIME type badge
- **File editor**: Edit with draft persistence (`vfs-editor` place), auto-versioning on save (text files only)
- **Diff viewer**: Compare versions with LCS diff algorithm, rollback support
- **Delete**: Soft-delete files and directories (recursive)
- **Download**: UTF-8 text files download as `.txt`, binary files download with original MIME type
- **Create**: Create empty text files and directories from directory panel
- **Upload**: Upload files with auto-detection (valid UTF-8 → text, otherwise → binary via magic bytes)
- **Download ZIP**: Download entire directory as ZIP archive (uses `fflate` library)
- **Drop old versions**: For files with >10 versions, drop historical versions keeping last 10. After dropping, badge shows "v15 (10 stored)" to indicate actual stored version count differs from version number. Diff viewer respects minStoredVersion and shows "Oldest stored:" label when viewing the earliest available version.

**Unified Reasoning Section:**

The Reasoning section in Project Settings uses a unified design with a global "Enable Reasoning" toggle in the header. When enabled, all provider-specific reasoning options are shown in organized subsections:

- **Anthropic / Bedrock Claude**: Budget Tokens + Keep Thinking Turns
- **OpenAI / Bedrock Nova / DeepSeek**: Reasoning Effort + Reasoning Summary

This design eliminates the need for separate reasoning UI per provider, simplifying configuration when switching between models. The correct options are automatically applied based on the active model's provider.

**Draft Persistence:**

- localStorage with multi-key format: `draft_<place>_<contextId>` → `{ content, createdAt }`
- Auto-save (500ms debounce), auto-restore on mount, auto-clear on context change
- Places: `chatview`, `project-chat`, `system-prompt-modal`, `vfs-editor`, `tool-option-longtext`
- `tool-option-longtext` uses composite contextId: `projectId|toolName|optionId`
- Editors compare current value vs initial prop to show "Unsaved changes" banner with Revert
- Helper functions:
  - `clearDraft(place, contextId)` - clears specific draft
  - `clearAllDrafts()` - removes all drafts (called on purgeAllData/detach)
  - `cleanupExpiredDrafts()` - removes drafts older than `DRAFT_MAX_AGE_MS` (24 hours), called on app init

### ID Generation & Race Protection

- Base32-encoded random strings (32 chars = 160 bits entropy)
- Format: `prefix_randomstring` (e.g., `msg_user_a7k2m9p4...`)
- ChatId verification in useChat methods prevents stale callback issues
- **Component remounting on ID change**: Route components use `key={id}` to force remount when switching between entities (e.g., `ChatView key={chatId}`), preventing stale state issues on mobile PWA

### Memory Tool

**Overview:**

Implements Anthropic's memory tool specification - a persistent virtual filesystem that allows LLMs to store and retrieve information across conversations. Files persist per project and survive page reloads. Uses VfsService for tree-structured storage with per-file versioning.

**Files:**

- `src/services/tools/memoryTool.ts` - Tool implementation with `MemoryToolInstance` class
- `src/services/vfs/vfsService.ts` - VFS backend with tree structure and versioning

**Commands (Anthropic spec compliant):**

| Command       | Parameters                           | Description                                                                   |
| ------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `view`        | `path`, `view_range?`                | View directory listing (with file sizes) or file contents (with line numbers) |
| `create`      | `path`, `file_text`                  | Create new file (error if exists)                                             |
| `str_replace` | `path`, `old_str`, `new_str`         | Replace unique string (error if not found or multiple matches)                |
| `insert`      | `path`, `insert_line`, `insert_text` | Insert text at specific line (0-indexed)                                      |
| `delete`      | `path`                               | Delete file or directory (soft delete)                                        |
| `rename`      | `old_path`, `new_path`               | Rename/move file (error if destination exists)                                |
| `mkdir`       | `path`                               | Create a new directory                                                        |
| `append`      | `path`, `file_text`                  | Append text to existing file, or create file if not exists                    |

**VFS Architecture:**

- Root path: `/memories` (all paths normalized to this)
- Tree-structured filesystem stored in `vfs_meta` table (JSON tree per project)
- Files stored in `vfs_files` table with stable UUID (`fileId`) that survives renames
- Per-file versioning in `vfs_versions` table (auto-versioned on every update)
- Soft-delete with orphan tracking for displaced files during renames
- 999,999 line limit per file (returns error if exceeded)
- **Namespace isolation**: All public VFS functions accept an optional `namespace` parameter. When set, paths are resolved through the namespace (e.g., `/minions/coder` + `/memories/note.md` → `/minions/coder/memories/note.md`). `resolveNamespacedPath()` handles resolution with path traversal mitigation.
- **Cross-namespace mounts**: Two shared paths bypass namespace prefixing:
  - `/share` — read-only for namespaced callers (main agent has write access). Enforced via `assertWritable()` in VFS core, throws `VfsError('READONLY')`.
  - `/sharerw` — read-write for all, including namespaced callers. Enables minion-to-minion collaboration.
- **Mount root protection**: `/share` directory root cannot be deleted or renamed (throws `INVALID_PATH`). `/sharerw` has no root protection — the main agent can delete it if needed.
- **Concurrency control**: Per-project promise chain (`treeLock.ts`) serializes all VFS operations — both reads and writes. `strReplace` and `insert` use internal primitives directly (no re-entrant calls to exported functions). Prevents lost-update race conditions and TOCTOU bugs when parallel tool calls access the same project's tree.

**Storage Tables:**

- `vfs_meta`: Tree structure + orphans per project
- `vfs_files`: Current file content (parentId = projectId)
- `vfs_versions`: Historical snapshots (parentId = fileId)
- VFS data cleaned up automatically when project is deleted

**Migration:**

Old memory system data (`memories`, `memory_journals` tables) is automatically migrated to VFS on app startup via `UnifiedStorage.initialize()`. Migration is idempotent - skips projects that already have VFS data. Process:

1. Replay journal entries chronologically (builds version history in VFS)
2. Compare VFS state with current `memories` table and sync differences
3. Delete old `memories` and `memory_journals` records after successful migration

**Instance Management:**

- `memoryTool` - Static tool definition exported from `memoryTool.ts`
- Tools registered via `registerAllTools()` at app startup (in `main.tsx`)
- `initMemoryTool(projectId)` - **Deprecated** stub (kept for backward compatibility)
- `disposeMemoryTool(projectId)` - **Deprecated** no-op

**Message Format (exact wording per spec):**

```
view (dir):  "Here're the files and directories up to 2 levels deep in {path}..."
view (file): "Here's the content of {path} with line numbers:"
create:      "File created successfully at: {path}"
str_replace: "The memory file has been edited." + snippet
insert:      "The file {path} has been edited."
delete:      "Successfully deleted {path}"
rename:      "Successfully renamed {old_path} to {new_path}"
```

**Error Handling:**

- Path not found: `"The path {path} does not exist. Please provide a valid path."`
- File exists (create): `"Error: File {path} already exists"`
- String not found (str_replace): `"No replacement was performed, old_str \`{str}\` did not appear verbatim in {path}."`
- Multiple matches (str_replace): `"No replacement was performed. Multiple occurrences of old_str \`{str}\` in lines: {nums}. Please ensure it is unique"`
- Invalid line (insert): `"Error: Invalid \`insert_line\` parameter: {n}. It should be within the range of lines of the file: [0, {max}]"`
- Destination exists (rename): `"Error: The destination {path} already exists"`

### Filesystem Tool

**Overview:**

Client-side tool that provides LLM access to the project's virtual filesystem. Similar to the memory tool but operates from VFS root (`/`) with `/memories` as readonly. Useful for storing code, data files, configuration, and scripts. Supports both text and binary files.

**Files:**

- `src/services/tools/fsTool.ts` - Tool implementation with `FsToolInstance` class

**Commands:**

| Command       | Parameters                           | Description                                                       |
| ------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `view`        | `path`, `view_range?`                | View directory listing, text file (with line numbers), or dataUrl |
| `create`      | `path`, `file_text`                  | Create new file (accepts text or dataUrl for binary)              |
| `str_replace` | `path`, `old_str`, `new_str`         | Replace unique string (text files only)                           |
| `insert`      | `path`, `insert_line`, `insert_text` | Insert text at specific line (text files only)                    |
| `delete`      | `path`                               | Delete file or directory (soft delete)                            |
| `rename`      | `old_path`, `new_path`               | Rename/move file (error if destination exists)                    |
| `mkdir`       | `path`                               | Create a new directory                                            |
| `append`      | `path`, `file_text`                  | Append text to existing file, or create file if not exists        |

**Binary File Support:**

- **Create binary files**: Pass dataUrl format (`data:<mime>;base64,<data>`) as `file_text`
- **View binary files**: Returns `Binary file {path} ({mime}):\n{dataUrl}` format
- **Text operations blocked**: `str_replace`, `insert`, and `append` return error on binary files
- MIME detection via magic bytes (JPEG, PNG, GIF, WebP, PDF, ZIP)
- File type change (text↔binary or MIME change) orphans old file, creates new

**Readonly Enforcement:**

- `/memories` path and all its contents are readonly (tool-level, fsTool blocks writes to /memories which is managed by the memory tool)
- `/share` is read-only for namespaced callers (VFS-level, enforced by `assertWritable()` in VFS core)
- Write operations to readonly paths return user-friendly error messages

**Instance Management:**

- `fsTool` - Static tool definition exported from `fsTool.ts`
- `initFsTool(projectId)` - **Deprecated** stub (kept for backward compatibility)
- `disposeFsTool(projectId)` - **Deprecated** no-op

### JavaScript Execution Tool

**Overview:**

Client-side tool that executes JavaScript code in a secure QuickJS-ng sandbox. Enables the AI to perform calculations, data transformations, and algorithm demonstrations. Each tool call runs in a fresh context with browser-like event loop semantics.

**Files:**

- `src/services/tools/jsTool.ts` - Tool registration and input/output formatting
- `src/services/tools/jsvm/JsVMContext.ts` - QuickJS context wrapper with event loop
- `src/services/tools/jsvm/polyfills.ts` - Browser API polyfills (setTimeout, TextEncoder, etc.)
- `src/services/tools/jsvm/fsPolyfill.ts` - VFS filesystem bridge for `fs` API

**Dependencies:**

- `quickjs-emscripten-core` - QuickJS WASM bindings with context management
- `@jitl/quickjs-ng-wasmfile-release-sync` - QuickJS-ng WASM variant (ES2023 support)

**Input Parameters:**

| Parameter | Type   | Required | Description                |
| --------- | ------ | -------- | -------------------------- |
| `code`    | string | Yes      | JavaScript code to execute |

**Code Execution Model:**

- Each tool call creates a fresh QuickJS context (no state persistence between calls)
- User code wrapped in async IIFE: `(async () => { ${code} })()`
- Use `return` to output a value (e.g., `return 1 + 1` → `2`)
- Top-level `await` is supported (e.g., `const data = await fs.readFile('/data.json', 'utf-8'); return JSON.parse(data);`)
- To persist data between calls, use the `fs` API to write/read files

**Output Format:**

Library output (only shown on first JS call in agentic loop, omitted for libraries with no output):

```
=== Output of library lodash.js ===
[LOG] lodash loaded
=== Console output ===
[LOG] hello world
[WARN] careful there
=== Result ===
42
```

If no console output and result is undefined: `undefined`

**Security:**

- Code runs in isolated QuickJS WebAssembly sandbox
- No access to browser APIs (DOM, fetch, localStorage)
- No network access

**JsVMContext Architecture:**

The `JsVMContext` class provides a browser-like JavaScript execution environment:

- **Event Loop**: Promise-based via `executePendingJobs(1)` per tick with browser yields
- **Timeout**: 60s execution limit via `setInterruptHandler()` (kills infinite loops mid-execution)
- **Console Capture**: All console methods (log, warn, error, info, debug) captured

**Event Loop Semantics:**

1. User code evaluates synchronously
2. While `hasPendingJob()` is true:
   - Yield to browser (`setTimeout(0)`)
   - `executePendingJobs(1)` processes one microtask
   - Check 60s timeout deadline
3. setTimeout uses `Promise.resolve().then(wrapper)` internally

**Polyfills (injected into every context):**

| API                      | Description                                             |
| ------------------------ | ------------------------------------------------------- |
| `self`                   | Points to `globalThis` (UMD/IIFE library compatibility) |
| `setTimeout(cb, delay?)` | Queues callback to microtask queue (delay ignored)      |
| `clearTimeout(id)`       | Cancels pending timeout                                 |
| `setInterval`            | Stub (runs once, returns ID)                            |
| `clearInterval`          | Same as clearTimeout                                    |
| `TextEncoder`            | UTF-8 string to bytes                                   |
| `TextDecoder`            | UTF-8 bytes to string                                   |
| `btoa(str)`              | Base64 encode                                           |
| `atob(str)`              | Base64 decode                                           |
| `halt(message)`          | Immediately stop execution, preserve logs before halt   |
| `fs` / `__fs`            | VFS filesystem API (see below)                          |

**UMD/IIFE Library Compatibility:**

UMD/IIFE Library can be loaded because:

- `self` global exists (browser environment detection)
- setTimeout/clearTimeout available (async patterns)
- Standard execution in global scope (not module mode)

**Filesystem API (`fs` / `__fs`):**

Node.js-like async filesystem operations backed by the project's VFS. All methods return Promises (must use `await`). Available as both `fs` and `__fs` on globalThis.

| Method                     | Returns                | Description                               |
| -------------------------- | ---------------------- | ----------------------------------------- |
| `readFile(path)`           | `Promise<ArrayBuffer>` | Read file as binary (Node.js Buffer-like) |
| `readFile(path, encoding)` | `Promise<string>`      | Read file as string with encoding         |
| `writeFile(path, data)`    | `Promise<void>`        | Create/overwrite file (string or binary)  |
| `exists(path)`             | `Promise<boolean>`     | Check if path exists                      |
| `mkdir(path)`              | `Promise<void>`        | Create directory                          |
| `readdir(path)`            | `Promise<string[]>`    | List directory entries                    |
| `unlink(path)`             | `Promise<void>`        | Delete file                               |
| `rmdir(path)`              | `Promise<void>`        | Delete directory (recursive)              |
| `rename(oldPath, newPath)` | `Promise<void>`        | Move/rename file or directory             |
| `stat(path)`               | `Promise<StatResult>`  | Get file/directory info                   |

`StatResult` type: `{ isFile: boolean, isDirectory: boolean, size: number, readonly: boolean, mtime: Date, isBinary: boolean, mime: string }`

**fs Readonly Enforcement:**

- `/memories` path and all its contents are read-only (tool-level check)
- `/share` is read-only for namespaced callers (VFS-level, throws `READONLY` → mapped to `EROFS`)
- Write operations (`writeFile`, `mkdir`, `unlink`, `rmdir`, `rename`) throw `EROFS` error
- `stat()` returns `readonly: true` for paths under `/memories` and for `/share` paths when namespaced

**fs Binary File Support:**

- `stat()` returns `isBinary: boolean` and `mime: string` for files
- Binary files stored as base64 in VFS, text files as UTF-8 strings
- MIME detection via magic bytes (JPEG, PNG, GIF, WebP, PDF, ZIP)

**fs Error Codes (Node.js-style):**

- `ENOENT` - Path not found
- `EEXIST` - File/directory already exists
- `EISDIR` - Illegal operation on directory (read file on dir)
- `ENOTDIR` - Not a directory
- `ENOTEMPTY` - Directory not empty
- `EINVAL` - Invalid argument
- `EROFS` - Read-only filesystem

**fs Event Loop Integration:**

Filesystem operations are async and resolved during the QuickJS event loop. Each fs method queues a pending operation that executes during `executePendingJobs()`. The `FsBridge` class manages:

- Pending operations queue (`PendingFsOp[]`)
- Promise handle creation and resolution
- Result marshalling between JS host and QuickJS context

**Library Preloading (`/lib`):**

Each tool call loads and executes all `.js` files in the `/lib` directory (if it exists and project.jsLibEnabled is true):

- Lists all `.js` files, sorts alphabetically for deterministic order
- Executes each script with the filename parameter for proper stack traces
- Library output (console logs) only shown on first JS call in each agentic loop
- Headers like `=== Output of library X.js ===` are omitted for libraries with no output
- Use for: loading utility libraries (lodash, date-fns UMD builds), custom helpers, polyfills
- Errors logged to console but don't prevent tool execution

**Agentic Loop Integration:**

Library output is always shown (no first-call tracking). The `loadLib` option controls whether `/lib` scripts are loaded.

**Instance Management:**

> **Note:** See deprecation note in Memory Tool section - same applies here.

- `jsTool` - Static tool definition exported from `jsTool.ts`
- `initJsTool()` - **Deprecated** stub
- `disposeJsTool()` - **Deprecated** no-op
- `configureJsTool(projectId, loadLib)` - **Deprecated** no-op (library loading now via `toolOptions.loadLib`)

### Minion Tool

**Overview:**

Client-side tool that delegates tasks to a sub-agent LLM. Each minion runs its own agentic loop with scoped tools, persists its conversation history, and returns results to the caller. Enables parallel task execution and delegation of specific work.

**Files:**

- `src/services/tools/minionTool.ts` - Tool implementation with model configuration
- `src/services/storage/unifiedStorage.ts` - MinionChat and message storage

**Input Parameters:**

| Parameter      | Type     | Required             | Description                                                                            |
| -------------- | -------- | -------------------- | -------------------------------------------------------------------------------------- |
| `action`       | string   | No                   | `'message'` (default) or `'retry'`. Retry rolls back to checkpoint and re-executes.    |
| `message`      | string   | For `message` action | Task to send to minion. For `retry`: omit to re-send original, or provide replacement. |
| `minionChatId` | string   | For `retry` action   | Existing minion chat ID to continue or retry                                           |
| `enableWeb`    | boolean  | No                   | Enable web search for minion (only exposed when `allowWebSearch` option is true)       |
| `enabledTools` | string[] | No                   | Tools for minion (validated against project tools, defaults to none)                   |
| `persona`      | string   | No                   | Persona name (matches `/minions/<name>.md`). Only when `namespacedMinion` is enabled.  |
| `model`        | string   | No                   | Model to use (`apiDefId:modelId`). Only when `namespacedMinion` + `models` configured. |
| `displayName`  | string   | No                   | Display name shown in the UI for this minion call. If omitted, persona name is used.   |

**Tool Options:**

- `systemPrompt` (longtext) - Instructions for minion sub-agents
- `model` (ModelReference) - Model for delegated tasks (can use cheaper model)
- `models` (ModelReference[]) - Models the LLM can choose from when calling minions. When non-empty and `namespacedMinion` is enabled, adds `model` input parameter with enum of `apiDefId:modelId` strings. LLM omitting `model` falls back to default `model` option.
- `allowWebSearch` (boolean, default: false) - Project-level gate for minion web search. Must be enabled for `enableWeb` to work. When disabled, `enableWeb` parameter and web search mention are omitted from the schema/description sent to the LLM.
- `returnOnly` (boolean, default: false) - When return tool provides a result and accumulated text exists, suppress text from the result JSON (only return the explicit result)
- `noReturnTool` (boolean, default: false) - Remove the return tool from minion toolset
- `disableReasoning` (boolean, default: false) - Turn off reasoning/thinking for minion calls regardless of project settings
- `deferReturn` (boolean, default: false) - Return tool stores result without breaking the agentic loop. The loop continues until natural completion, then returns the stored value. Multiple calls overwrite (last wins). Sets `deferReturn` on `AgenticLoopOptions` and injects it into the return tool's options so its description reflects the mode.
- `namespacedMinion` (boolean, default: false) - Isolate each persona into its own VFS namespace. When enabled, adds `persona` input parameter and system prompt with available personas list.

**Persona System (namespacedMinion):**

When `namespacedMinion` is enabled, each minion gets VFS namespace isolation based on its persona:

- Persona files stored at `/minions/<name>.md` in root VFS. Content becomes the minion's system prompt.
- `/minions/_global.md` (optional) — content prepended to the system prompt for all personas (including default). Read from root VFS before persona-specific prompt.
- `persona` input parameter selects a persona (omit for `default`). Each persona maps to namespace `/minions/<persona>`.
- Namespace flows through the agentic loop: `AgenticLoopOptions.namespace` → `ToolContext.namespace` → all VFS calls in memory, filesystem, and JavaScript tools.
- A persona's `/memories/README.md` resolves to `/minions/<persona>/memories/README.md` in VFS storage.
- `/share` paths bypass namespace prefixing — read-only for namespaced minions (main agent writes, minions read).
- `/sharerw` paths bypass namespace prefixing — read-write for all, enables minion-to-minion collaboration.
- System prompt injection lists available personas from `/minions/*.md` with their first lines.

**Tool Scoping:**

Minion's available tools are computed as: `(requestedTools ∩ projectTools) - minion + return`

- Defaults to `['return']` when `enabledTools` is omitted (caller must explicitly grant tools)
- Can't spawn nested minions (self-exclusion)
- `return` tool always available for explicit result signaling
- Requested tools validated against project tools — error returned if any tool is not available
- Uses intersection with project tools (can't access tools not enabled for project)

**MinionChat Storage:**

Minion conversations stored separately for debugging visibility:

- `getMinionChat(id)` / `getMinionChats(parentChatId)` / `saveMinionChat()`
- `getMinionMessages(minionChatId)` / `saveMinionMessage()`
- Cascade deletion when parent chat is deleted
- `checkpoint?: string` field stores last message ID before minion run (used by retry action for rollback). New chats start with `CHECKPOINT_START` sentinel (`'_start'`) to enable first-run retry.
- Persisted settings: `displayName`, `persona`, `apiDefinitionId`, `modelId` — stored on creation and updated on continuation. Enables stored-model fallback when continuing without re-specifying model.

**Result Handling:**

- Return JSON content: `{ text, stopReason, minionChatId, result? }`
  - `text` — concatenated text from ALL assistant messages in the turn (joined by `\n\n`)
  - `stopReason` — last assistant message's stop reason (`tool_use` mapped to `end_turn` when return tool triggered completion)
  - `minionChatId` — for continuing the conversation
  - `result` — only present when return tool was used (explicit return value)
- `renderingGroups` on ToolResult carries nested display content:
  - First group: `ToolInfoRenderBlock` with task description (`input`), sub-chat reference (`chatId`), optional `persona` name, `displayName`, `apiDefinitionId`, and `modelId`
  - Remaining groups: accumulated rendering from sub-agent messages (marked `isToolGenerated: true`)
  - Transferred to `ToolResultRenderBlock.renderingGroups` by `createToolResultRenderBlock`
- `tokenTotals` on ToolResult carries accumulated API costs from sub-agent loop
  - Transferred to `ToolResultRenderBlock.tokenTotals` for per-block cost display
  - Accumulated by outer agentic loop into tool result message metadata and chat totals
  - Displayed in `ToolResultView` header (compact `$X.XXX`) and `ToolResultBubble` footer

**Execution Phases:**

The `executeMinion` function has three ordered phases with distinct error recovery guidance:

1. **Phase 1** (load + checkpoint): Validate inputs, load/create chat, retry rollback, save checkpoint. Errors append "Resend to reattempt." — no meaningful state change occurred.
2. **Phase 2** (validation): Check web search, model, project, API def, tools. Errors append "Resend with the message to reattempt." — checkpoint is saved but no user message yet.
3. **Phase 3** (execution): Check pendingReturnToolUse, build/save user message, run agentic loop. Errors here can be retried via `action: 'retry'`.

**Return Tool Resumption:**

- When continuing a minion chat that ended with `return` tool call:
  - Detects pending return tool in last assistant message's fullContent
  - Builds tool_result message instead of user message
  - User's message becomes the return tool's result content
- Enables proper API conversation flow after explicit return signaling

**Minion Chat Display:**

- `ToolResultView` renders minion results (and any tool result with `renderingGroups`)
- Always collapsed by default, shows last activity line as preview when collapsed
- Header shows: `displayName` (if set, otherwise persona name if non-default) before expand icon, last-block activity icon (💭/🔧/💬/etc.) after expand icon
- Settings info line (persona, API icon, model ID) shown at top of expanded content
- Blue box for task input (from `ToolInfoRenderBlock`), green/red box for final result
- Activity groups (backstage/text) rendered with `isToolGenerated` styling
- "View Chat" button opens overlay over ChatView (when `chatId` present and `MinionChatOverlayContext` provided), "Copy JSON" for debugging
- `ToolResultBubble` hides timestamp/cost/actions line while any tool result is still pending/running
- Integrated into `ToolResultBubble` (complex results) and `BackstageView.ToolResultSegment`
- Real-time streaming via pending-message pattern (see Minion Streaming UI below)

**Generator-Based Streaming:**

- Minion tool is an async generator that yields `{ type: 'groups_update', groups }` events
- The agentic loop consumes these via `tool_block_update` events, forwarding to the consumer
- No separate streaming state map — streaming updates flow through the pending tool_result message

**Minion Streaming UI:**

Minion streaming uses the pending-message pattern instead of a separate streaming state map:

1. Agentic loop yields `pending_tool_result` → consumer adds temporary message to React state
2. Tool yields `groups_update` → agentic loop yields `tool_block_update` → consumer updates `renderingGroups` on the matching block
3. Tool completes → `message_created` replaces the pending message with the final persisted one

**Return Tool:**

Internal tool available only to minions for explicit result signaling:

- `returnTool` in `src/services/tools/returnTool.ts`
- `internal: true` flag hides from ProjectSettings UI
- Returns `breakLoop: { returnValue }` to stop agentic loop
- Used by minions to signal task completion with specific result
- **Deferred mode** (`deferReturn` option on minion tool): Return tool stores the value without breaking the loop. The agentic loop replies with "Result stored. Please wait for next instruction." and continues until natural completion. Multiple deferred returns overwrite — last value wins. Dynamic description changes based on mode.

### Checkpoint Tool

Client-side tool that marks progress during long agentic loops. When the AI calls checkpoint, a flag propagates through the agentic loop. After the turn ends naturally (end_turn/max_tokens), the consumer auto-sends a continue message, starting a fresh API call where old thinking blocks get trimmed by `thinkingKeepTurns`.

- `checkpointTool` in `src/services/tools/checkpointTool.ts`
- `internal: false` — visible in ProjectSettings, must be explicitly enabled
- Input: `{ note: string }` — progress summary that stays in conversation history
- Returns `{ content, checkpoint: true }` — no `breakLoop`, loop continues normally
- Tool options:
  - `continueMessage` (longtext, default: `"please continue"`)
  - `swipeFilesystem` / `swipeMemory` / `swipeJavascript` / `swipeMinion` / `swipeSketchbook` / `swipeCheckpoint` (boolean, all default `true`) — which tool blocks to remove from pre-checkpoint context
- `iconInput: '📍'`, `iconOutput: '✅'`

**Checkpoint flow:**

```
AI calls checkpoint(note) → tool returns with checkpoint: true → flag propagates
    → loop continues → AI finishes turn naturally (end_turn/max_tokens)
    → main loop detects checkpointSet → yields checkpoint_set event with assistant message ID
    → creates user message with continueMessage → re-enters while loop for fresh API call
    → context swipe trims old thinking + tool blocks → AI sees note and continues
```

**Flag propagation** (`agenticLoopGenerator.ts`):

- `executeToolsParallel` → `executeToolUseBlocks` → main loop's `checkpointSet` variable
- Auto-continue handled entirely inside `runAgenticLoop`: when `checkpointSet && stopReason !== 'tool_use'`, yields `checkpoint_set` event, creates a continue user message, yields it, resets flag, and `continue`s the loop
- Continue text read from `toolOptions.checkpoint?.continueMessage` (falls back to `'please continue'`)
- Local `checkpointMessageId` variable tracks the ID within the generator loop — set when `checkpointSet = true` (points to the assistant message containing the checkpoint tool_use), used in `streamOptions` so context swipe applies on the auto-continued turn
- Consumer (`useChat.ts`) handles `checkpoint_set` event by persisting `checkpointMessageId` on the `Chat` object

**Context Swipe** (`src/services/api/contextSwipe.ts`):

When `checkpointMessageId` is set, messages older than the checkpoint get selectively trimmed before each API call:

- Thinking/reasoning blocks always removed from pre-checkpoint messages
- Tool blocks (`tool_use` + matching `tool_result`) removed per swipe option toggles
- The checkpoint message itself: only thinking removed, tool blocks preserved
- Messages newer than checkpoint are untouched
- Messages with mismatched `modelFamily` or missing `fullContent` are skipped
- Each API client calls `applyContextSwipe()` with a provider-specific `FilterBlocksFn` before message conversion
- Tool name derivation: `deriveSwipeToolNames()` maps checkpoint option IDs to tool names, defaulting to true (swipe enabled)

### Agentic Loop

**Architecture:**

The agentic loop is implemented as an async generator in `src/services/agentic/agenticLoopGenerator.ts`. This design yields events instead of using callbacks, enabling:

- Chat/project agnostic operation (receives flat `AgenticLoopOptions`)
- Tool suspension support via `ToolResult.breakLoop` field
- Nested agent calls via `collectAgenticLoop()` helper
- Single context array (no separate message buffer)
- Token accumulation across iterations via `TokenTotals` type
- Tool cost propagation: tools returning `tokenTotals` get accumulated into loop totals and chat totals

**Key Exports** (`agenticLoopGenerator.ts`):

- `runAgenticLoop(options, context)` - Main async generator function
- `collectAgenticLoop(gen)` - Helper to consume generator and get final result
- `createTokenTotals()` - Re-exported from `src/utils/tokenTotals.ts`
- `addTokens(target, source)` - Re-exported from `src/utils/tokenTotals.ts`
- `populateToolRenderFields(groups)` - Add rendered display fields to tool blocks
- `createToolResultRenderBlock(...)` - Create tool result render block with display fields
- `loadAttachmentsForMessages(messages)` - Load attachments and handle missing attachment notes

**Token Totals** (`src/utils/tokenTotals.ts`):

- `TokenTotals` interface defined in `src/types/content.ts` (no-import file, avoids circular deps)
- `createTokenTotals()` - Zero-initialized totals
- `addTokens(target, source)` - Accumulate (mutates target)
- `hasTokenUsage(totals)` - True if any non-zero usage

**Event Types:**

```typescript
type AgenticLoopEvent =
  | { type: 'streaming_start' }
  | { type: 'streaming_chunk'; groups: RenderingBlockGroup[] }
  | { type: 'streaming_end' }
  | { type: 'message_created'; message: Message<unknown> }
  | { type: 'tokens_consumed'; tokens: TokenTotals }
  | { type: 'first_chunk' }
  | { type: 'pending_tool_result'; message: Message<unknown> }
  | { type: 'tool_block_update'; toolUseId: string; block: Partial<ToolResultRenderBlock> }
  | { type: 'checkpoint_set'; messageId: string };
```

**Result Types:**

```typescript
type AgenticLoopResult =
  | { status: 'complete'; messages; tokens; returnValue? }
  | { status: 'error'; messages; tokens; error }
  | { status: 'max_iterations'; messages; tokens };
```

**Consumer** (`useChat.ts`):

- `consumeAgenticLoop(options, context, chat, project, handlers)` - Consumes generator and handles persistence
- `buildAgenticLoopOptions()` - Builds flat options from Chat/Project/APIDefinition/Model
- `buildEventHandlers()` - Creates event handler callbacks for React state updates
- User messages saved before calling generator
- Tool result messages saved before calling generator
- Assistant messages saved via `message_created` events from generator

**Streaming Render Throttle:**

`onStreamingUpdate` and `onToolBlockUpdate` in `buildEventHandlers()` are throttled at 200ms intervals (`STREAMING_THROTTLE_MS`). Multiple parallel minions on fast models can produce hundreds of state updates per second — the throttle batches these into ~5 React renders/second. `onStreamingUpdate` uses latest-wins semantics (intermediate chunks dropped). `onToolBlockUpdate` accumulates a `Map<toolUseId, update>` and flushes all accumulated updates in a single `setMessages` call. Both timers are flushed synchronously in `onStreamingEnd` and cleaned up on unmount.

**Features:**

- Unified loop handles all cases (normal send, continue, stop)
- Automatic tool execution and continuation
- JS tool configuration at loop start (project context, library log reset)
- Cost/token accumulation across iterations
- Read-only storage access (reads attachments, consumer handles persistence)
- Error handling with cleanup

**Tool Execution Helper:**

`executeToolUseBlocks()` is an extracted async generator that handles tool execution with full streaming support (pending → running → streaming updates → complete). Used via `yield*` from two call sites:

1. Pre-loop: executing `pendingToolUseBlocks` before the first API call
2. In-loop: after `stop_reason === 'tool_use'`

**Phased tool execution:** Tools are classified as simple or complex via `ClientSideTool.complex` flag (currently only `minion` is complex). When both types appear in a single response, simple tools run first (phase 1), then complex tools (phase 2). Within each phase, tools run in parallel via `executeToolsParallel()` with `Promise.race` multiplexing. Results are merged in original tool order.

**Return tool error handling:** If the `return` tool appears alongside other tools (`length > 1`), it receives an error result (`"return cannot be called in parallel with other tools. please try again"`) and the other tools execute normally. The loop continues so the LLM can retry. When `return` is the only tool, it executes normally and breakLoop is honored.

**Pending Tool Resolution (`AgenticLoopOptions`):**

- `pendingToolUseBlocks?: ToolUseBlock[]` — pre-existing tool_use blocks to execute before the first API call (used by `resolvePendingToolCalls` continue mode)
- `pendingTrailingContext?: Message<unknown>[]` — already-saved messages injected after tool results (e.g., user follow-up message)
- `deferReturn?: boolean` — when true, the return tool stores its value without breaking the loop. The stored value is delivered as `returnValue` when the loop ends naturally. Multiple deferred returns overwrite (last wins).

**Integration with useChat.ts:**

- `sendMessage` - Thin wrapper: reads state → builds context → calls `runAgenticLoop`
- `resolvePendingToolCalls` stop mode: builds error tool results immediately → calls `runAgenticLoop`
- `resolvePendingToolCalls` continue mode: passes `pendingToolUseBlocks` to loop for streamed execution
- Consumer handles `storage.saveChat` and `storage.saveProject` after loop completes

**Project Setting:**

- `jsExecutionEnabled?: boolean` on `Project` type
- Toggle in Project Settings UI
- Tool initialized/disposed in `useChat.ts` based on setting

### OOBE (Out-of-Box Experience)

**Flow:**

1. App checks for CEK in localStorage on startup
2. No CEK → OOBE screen (full-page, no sidebar)
3. User selects storage type (IndexedDB or Remote) and initialization mode
4. For Remote storage: URL and optional password required, connection tested via `/health` endpoint
5. After setup → OOBE Complete page shows CEK and import stats
6. User clicks "Launch App" → page reloads to sync all states

**Components:**

- `OOBEScreen.tsx` - Single-page wizard with storage selection and init mode
- `OOBEComplete.tsx` - Post-setup confirmation with CEK display and copy button

**Storage Types:**

- **IndexedDB (Local)**: Data stored in browser's IndexedDB
- **Remote Storage**: Sync across devices via `storage-backend/` REST API

**Initialization Modes:**

- **Start Fresh**: Generate new CEK, initialize storage, create default API definitions
- **Import from Backup**: User provides CSV backup file + source CEK, performs migration import
- **Use Existing Data** (remote only): Connect to remote storage with existing CEK, verifies by decrypting one record

**State Management:**

- OOBE runs before `AppProvider` mounts (CEK check is synchronous)
- After OOBE completes, `location.reload()` ensures clean state initialization
- Normal app flow resumes after reload (CEK now exists in localStorage)

### Build & Deployment

**Dual-mode Configuration:**

- Production (`npm run build`): `base: '/'`, outputs to `dist/` for static hosting at domain root
- Development (`npm run dev`): `base: '/dev/'`, runs on port 5199, expects nginx proxy at `/dev`

**PWA Strategy:**

- PWA (manifest + service worker) only active in production build
- Service worker's `navigateFallbackDenylist: [/^\/dev/]` prevents caching `/dev/*` requests
- Prod and dev can share same domain with isolated caching

**nginx Integration (reference):**

```nginx
# Production - serve static files
location / {
    root /path/to/dist;
    try_files $uri $uri/ /index.html;
}

# Dev - proxy to Vite server with HMR WebSocket support
location /dev {
    proxy_pass http://127.0.0.1:5199;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## Development Guidelines

1. **Type Safety**: TypeScript strict mode, avoid `any`
2. **Components**: Functional with hooks
3. **Error Handling**: All API calls and async operations
4. **Code Style**: ESLint + Prettier
5. **Security**: All data encrypted in IndexDB. CEK in localStorage. DOMPurify for XSS prevention.
6. **Performance**: Lazy load, React.memo, virtual scrolling, debounced input
7. **Accessibility**: Semantic HTML, ARIA labels, keyboard navigation
8. **Testing**: Critical paths and complex logic
9. **String Unions over Const Objects**: Prefer `type X = 'a' | 'b' | 'c'` over `const X = { A: 'a', ... } as const`. Use const objects only when runtime iteration is needed (e.g., `Tables` for `Object.values(Tables)`).

**Scrolling Pattern:**

```tsx
className = 'overflow-y-auto overscroll-y-contain ios-scroll';
```

Parent flex containers need `min-h-0` for proper shrinking.

**Safe Area Insets (iOS):**

Viewport uses `viewport-fit=cover` to extend into unsafe areas.

**Viewport Height:** Use `h-dvh` (Tailwind's dynamic viewport height) instead of `h-screen`. iOS Safari's `100vh` includes the area behind browser chrome and safe areas, making pages taller than the visible viewport. `dvh` units account for this and give the actual visible height. This applies to modal `max-h-[*]` constraints too — use `dvh` not `vh` (e.g., `max-h-[85dvh]`).

CSS utility classes defined in `index.css`:

- `safe-area-inset-x` - left/right padding for notch devices
- `safe-area-inset-top` - top padding (empty div, creates spacer)
- `safe-area-inset-bottom` - bottom padding (empty div, creates spacer)
- `scroll-safe-bottom` - bottom padding for scrollable content

**Wrapper Pattern (required for headers/footers):**

Headers use `h-14` (56px) for content, but adding `safe-area-inset-top` as padding would squish content (CSS border-box). Solution: separate wrapper structure.

```tsx
{
  /* Header with safe area */
}
<div className="border-b border-gray-200 bg-white">
  <div className="safe-area-inset-top" /> {/* spacer div */}
  <div className="flex h-14 items-center px-4">{/* header content */}</div>
</div>;

{
  /* Footer with safe area */
}
<div className="border-t border-gray-200 bg-white">
  <div className="flex gap-3 p-4">{/* footer content */}</div>
  <div className="safe-area-inset-bottom" /> {/* spacer div */}
</div>;
```

**Component Usage:**

- **All page headers** (`ProjectView`, `ChatView`, `ProjectSettingsView`, `SettingsPage`, `DataManagerPage`, `AttachmentManagerView`) use wrapper pattern with `safe-area-inset-top` spacer
- **Fixed footers** (`ChatInput`, `ProjectSettingsView`) use wrapper pattern with `safe-area-inset-bottom` spacer
- **Sidebar footer** uses `safe-area-inset-bottom` directly (no fixed height constraint)
- **Scrollable containers** use `scroll-safe-bottom` for bottom padding
- **Root container** (`App.tsx`) uses `safe-area-inset-x` for left/right padding

**Modal Pattern:** Conditional rendering (unmount when closed), not opacity toggle.

**Responsive Pattern:** Use `useIsMobile()` hook internally, not as prop.

**Input Font Size:** All `<input>` elements must use `text-base` (16px) or larger. iOS Safari auto-zooms the viewport when focusing inputs with font-size < 16px.

### User Preferences

`usePreferences()` hook provides UI preferences with hardcoded defaults (extensible for future preferences page/storage):

- `iconOnRight: boolean` - Move tool icons to right side in `BackstageView`, `ToolResultView`, and `ToolResultBubble` headers (default: `true`)

When `iconOnRight` is `true`:

- All icons displayed on right side (previous icons faded, last icon full opacity)
- No state text labels in headers — icons alone identify activity type

## Known Issues 🐛

### Anthropic Citation Document Index

When using web search + memory tool together, citations in assistant messages may contain `document_index` references that become invalid after client-side tool execution breaks the turn. Workaround: citations are stripped from text blocks when the previous message contains a `tool_result` (in `anthropicClient.ts`). This may cause some citation data loss in multi-tool-use conversations, but prevents API 400 errors.

**Root cause unclear** - could be:

1. Server tool (web_fetch) document counted separately from web_search results
2. Document indices invalidated when conversation turn is split by tool calls
3. Claude incorrectly counting search results

### TypeScript Warnings

- useEffect missing dependency: Case-by-case investigation needed

## Technical Debt

- Hardcoded pricing needs maintenance mechanism
- Accessibility audit needed

## Future Considerations

1. [x] **OpenAI/xAI Thinking** - Implement `migrateMessageRendering` thinking support when providers expose thinking
2. [x] **Code Execution** - Add `CodeExecutionRenderBlock` for agentic features
3. [x] **Custom Tools** - Extend block types beyond web search/fetch
4. **Citation Tooltips** - Hover tooltips for `data-cited` content
5. **Streaming Abort** - Handle abort signal mid-stream

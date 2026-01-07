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
- [x] Project settings (system prompt, pre-fill, model, temperature, reasoning, web search, metadata)
- [x] Chat with streaming responses, message editing, forking, and cost tracking
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
- [x] Fork tracking and cost analysis

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
- [x] Hooks tested (useChat, useProject, useApp, useIsMobile, useAlert, useError, useVirtualScroll, useStreamingAssembler, useAttachmentManager)
- [x] Chat components tested (MessageBubble, UserMessageBubble, AssistantMessageBubble, LegacyAssistantBubble, MessageList, BackstageView, ErrorBlockView, TextGroupView, StopReasonBadge, StreamingMessage, CacheWarning, WebLLMLoadingView)
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

- Multiple API definitions per provider type (APIType: RESPONSES_API, CHATGPT, ANTHROPIC, WEBLLM)
- Each definition: name, baseUrl (optional), apiKey (not required for WEBLLM)
- Default definitions auto-created; model lists cached per definition

### Projects

Projects organize chats with shared settings:

- **Name** and **Icon** (default: 📁)
- **System prompt** (via `SystemPromptModal`) and **Pre-fill response** (in Advanced section)
- **Default API definition/model** (required)
- **Anthropic reasoning**: enable toggle + budget tokens (default: 1024) + keep thinking turns
- **OpenAI/Responses reasoning**: effort (`undefined` = auto), summary (`undefined` = auto)
- **Web search** toggle
- **Message metadata**: timestamp mode (UTC/Local/Disabled), context window usage, current cost
- **Tools**: Memory (Anthropic only), JavaScript Execution
- **Advanced** (collapsed): temperature, max output tokens (default: 1536)

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
- Tables: `api_definitions`, `models_cache`, `projects`, `chats`, `messages`, `attachments`, `memories`, `memory_journals`, `app_metadata`
- All tables have the same columns

**Remote Storage:**

- `RemoteStorageAdapter` connects to `storage-backend/` via REST API
- Auth: Basic authentication with userId + optional password
- userId derived from CEK via `encryptionService.deriveUserId()` (PBKDF2-SHA256, 100k iterations, 64-char hex)
- userId is computed once during OOBE and stored in `StorageConfig` (avoids async derivation at runtime)
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

**Message Compression:**

- Messages compressed with gzip before encryption (60-80% space savings)
- Uses browser's Compression Streams API (native, no dependencies)
- Binary-direct approach: compress → prepend "GZ" bytes → encrypt
- "GZ" indicator bytes `[71, 90]` prepended to detect compressed data on read
- Automatic detection on read (backward compatible with uncompressed messages)
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

**API Clients:**

- Base client with shared streaming logic
- `ResponsesClient` (OpenAI Responses API with reasoning, vision, web search)
- `OpenAIClient` (Chat Completions with o-series/GPT-5 support)
- `AnthropicClient` (thinking blocks, prompt caching, web search/fetch, citations)
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

**Stream Mapper Pattern:**

- Separates provider-specific event mapping from client logic
- Event → MapperState → StreamChunk[] (stateful transformation)
- Currently: `anthropicStreamMapper.ts`, `responsesStreamMapper.ts`; OpenAI Chat Completions uses inline mapping

**Client-Side Tools:**

- `src/services/tools/clientSideTools.ts` - Tool registry and execution
- Tools registered with `toolRegistry.register()`, executed via `executeClientSideTool()`
- Tool definitions sent to API via `getToolDefinitionsForAPI(apiType, enabledToolNames)`
- `ClientSideTool` interface supports:
  - `alwaysEnabled: true` - Tool included regardless of enabledToolNames (e.g., `ping`)
  - `apiOverrides: Partial<APIToolOverrides>` - Type-safe API-specific definition overrides using SDK types (`BetaToolUnion` for Anthropic, `ChatCompletionTool` for OpenAI, `Tool` for Responses API)
  - `systemPrompt?: string` - Injected after project's system prompt when tool is enabled; skipped if tool uses `apiOverrides` for the current API type (provider handles its own system prompt injection)
  - `renderInput?: (input) => string` - Transform tool input for display in BackstageView (default: JSON.stringify)
  - `renderOutput?: (output, isError?) => string` - Transform tool output for display (default: raw content)
  - `iconInput?: string` - Emoji/unicode icon for tool_use blocks (default: 🔧)
  - `iconOutput?: string` - Emoji/unicode icon for tool_result blocks (default: ✅/❌)
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
- `ping` tool included for testing tool infrastructure ("test tool calling" → pong), marked `alwaysEnabled: true`
- `memory` tool provides persistent virtual filesystem (see Memory Tool section below), dynamically registered/unregistered per project; uses Anthropic's `memory_20250818` shorthand via `apiOverrides`
- Agentic loop in `useChat.ts` handles `stop_reason: 'tool_use'`:
  1. Extract `tool_use` blocks from `fullContent`
  2. Execute client-side tools locally
  3. Build `tool_result` messages with `renderingContent`
  4. Save intermediate messages to storage + update UI state
  5. Send continuation request
  6. Loop until `stop_reason !== 'tool_use'` or max iterations (10)
- Intermediate messages persisted with proper `renderingContent`:
  - Assistant messages with `tool_use` render in `BackstageView` as expandable "Calling [tool_name]" blocks
  - User messages with `tool_result` render via `ToolResultBubble` (detected by `fullContent` containing `tool_result` blocks)

**Pricing:**

- Standalone modules per provider with model matching (exact, prefix, fallback)
- Per-message pricing snapshots stored with metadata

### Rendering System

**Content Types** (`src/types/content.ts`):

- `RenderingBlockGroup` with category (backstage/text/error)
- Block types: `ThinkingRenderBlock`, `TextRenderBlock`, `WebSearchRenderBlock`, `WebFetchRenderBlock`, `ToolUseRenderBlock`, `ToolResultRenderBlock`, `ErrorRenderBlock`
- Citations pre-rendered as `<a class="citation-link" data-cited="...">` tags

**Design Principles:**

1. API-agnostic rendering format (provider-specific `fullContent` preserved separately)
2. Backstage/frontstage separation (thinking/tools collapsible, text visible)
3. Pre-grouped storage (avoid runtime grouping)
4. Text consolidation (continuous text blocks merged)

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
│   ├── UserMessageBubble.tsx      # User messages (blue bubble, attachments, edit/fork/copy)
│   ├── ToolResultBubble.tsx       # Tool result messages (role: USER with tool_result blocks)
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

- `useVirtualScroll` hook with IntersectionObserver (2 screen heights buffer)
- Height caching: measured synchronously on mount, tracked via ResizeObserver
- Placeholders: render `<div style={{height: cachedHeight}}>` when offscreen
- Flicker-free: messages render fully → measure → hide if outside buffer
- Performance: 1000+ messages → ~20 DOM nodes
- Scroll-to-bottom floating button (appears when scrolled up)
- Auto-scroll correction after streaming ends (handles overscroll from markdown rendering)

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
- `/chat/:chatId` - Chat conversation
- `/attachments` - Attachment manager
- `/settings` - API definitions configuration
- `/data` - Data management (export, import, compression, CEK)

**Responsive Design:**

- Breakpoint: 768px (md)
- Desktop: Side-by-side two-panel (sidebar 280px fixed)
- Mobile: Overlay drawer, hamburger menu per view
- `useIsMobile()` hook for responsive components (no prop drilling)

**Provider-Specific Settings Pattern:**

Settings that apply to the currently selected API provider appear in the main section. Settings for other providers appear in a collapsible "Other Provider Config" section. For example, when using an Anthropic model, Anthropic reasoning (enable + budget) appears in Reasoning section, while OpenAI reasoning (effort + summary) appears in Other Provider Config. This keeps the UI focused while still allowing pre-configuration of all providers.

**Draft Persistence:**

- localStorage with key format: `<place>|<contextId>|<content>`
- Auto-save (500ms debounce), auto-restore on mount, auto-clear on context change
- Places: `chatview`, `project-chat`, `project-instructions`, `system-prompt-modal`
- Returns `{ hasDraftDifference }` - true when restored draft differs from `initialDbValue`
- Helper functions: `clearDraft()` clears localStorage, `clearDraftDifference(place, contextId)` clears difference flag

### ID Generation & Race Protection

- Base32-encoded random strings (32 chars = 160 bits entropy)
- Format: `prefix_randomstring` (e.g., `msg_user_a7k2m9p4...`)
- ChatId verification in useChat methods prevents stale callback issues
- **Component remounting on ID change**: Route components use `key={id}` to force remount when switching between entities (e.g., `ChatView key={chatId}`), preventing stale state issues on mobile PWA

### Memory Tool

**Overview:**

Implements Anthropic's memory tool specification - a persistent virtual filesystem that allows Claude to store and retrieve information across conversations. Files persist per project and survive page reloads.

**Files:**

- `src/services/tools/memoryTool.ts` - Tool implementation with `MemoryToolInstance` class
- `src/services/memory/memoryStorage.ts` - Persistent storage layer (encrypted, compressed)
- `src/components/project/MemoryManagerView.tsx` - UI for viewing/managing memory files

**Commands (Anthropic spec compliant):**

| Command       | Parameters                           | Description                                                                   |
| ------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `view`        | `path`, `view_range?`                | View directory listing (with file sizes) or file contents (with line numbers) |
| `create`      | `path`, `file_text`                  | Create new file (error if exists)                                             |
| `str_replace` | `path`, `old_str`, `new_str`         | Replace unique string (error if not found or multiple matches)                |
| `insert`      | `path`, `insert_line`, `insert_text` | Insert text at specific line (0-indexed)                                      |
| `delete`      | `path`                               | Delete file or directory                                                      |
| `rename`      | `old_path`, `new_path`               | Rename/move file (error if destination exists)                                |

**Virtual Filesystem:**

- Root path: `/memories` (all paths normalized to this)
- Flat file structure stored as `Record<string, MemoryFile>`
- Each file tracks `content`, `createdAt`, `updatedAt` timestamps
- 999,999 line limit per file (returns error if exceeded)

**Storage:**

- Uses same encryption/compression as messages (`encryptWithCompression`)
- Keyed by `projectId` in `memories` table
- Auto-save: dirty flag cleared after each write operation

**Journal (Version History):**

- Every write operation (create, str_replace, insert, delete, rename) logs a journal entry
- Journal stored in `memory_journals` table with `parentId` = projectId
- Each entry stores the full command parameters as encrypted JSON
- `getJournalVersion(projectId)` returns the write count (version number)
- `loadJournal(projectId)` returns all entries sorted by timestamp

**Memory Manager UI (`MemoryManagerView.tsx`):**

- Shows version number (total writes) in header
- "Verify" button reconstructs filesystem from journal, compares with current state
- If differences found, offers to overwrite current state with replayed version
- "Edit" button opens modal with textarea to manually edit file content
- "Diff" button on file view compares current vs previous version using LCS diff
- Navigation buttons (◀ ▶) to browse diff between any two versions
- "Rollback" button (in diff mode) restores file to the currently viewed version
- Manual file deletion (🗑️ button) records a `delete` command in journal
- "Clear All" deletes both filesystem and journal history

**User Actions (journal commands):**

| Command         | Source               | Description                                    |
| --------------- | -------------------- | ---------------------------------------------- |
| `user_edit`     | Edit modal → Save    | Full file replacement with user-edited content |
| `user_rollback` | Diff view → Rollback | Full file replacement with historical version  |

Both commands store `{ command, path, file_text }` and are replayed as delete + create.

**Instance Management:**

- `MemoryToolInstance` class holds filesystem state per project
- `initMemoryTool(projectId)` - Load from storage or create empty (cached in Map)
- `getMemoryTool(projectId)` - Get cached instance
- `disposeMemoryTool(projectId)` - Remove from cache when chat closes

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

### JavaScript Execution Tool

**Overview:**

Client-side tool that executes JavaScript code in a secure QuickJS sandbox. Enables the AI to perform calculations, data transformations, and algorithm demonstrations. Supports persistent sessions within an agentic loop.

**Files:**

- `src/services/tools/jsTool.ts` - Tool implementation

**Dependencies:**

- `quickjs-emscripten-core` - QuickJS WASM bindings with context management
- `@jitl/quickjs-singlefile-browser-release-sync` - Browser-compatible WASM variant

**Input Parameters:**

| Parameter   | Type    | Required | Description                                                          |
| ----------- | ------- | -------- | -------------------------------------------------------------------- |
| `code`      | string  | Yes      | JavaScript code to execute                                           |
| `ephemeral` | boolean | No       | Execute in isolated context without affecting the persistent session |

**Output Format:**

Console output with level prefixes, followed by result:

```
[LOG] hello world
[WARN] careful there
=== Result ===
42
```

If no console output and result is undefined: `(no output)`

**Security:**

- Code runs in isolated QuickJS WebAssembly sandbox
- No access to browser APIs (DOM, fetch, localStorage)
- No network access

**Execution Modes:**

1. **Ephemeral** (default): Each tool call is isolated, no state persists
2. **Session**: VM state persists across multiple tool calls within an agentic loop

**Session Lifecycle:**

Sessions enable the AI to build up state across multiple tool calls:

- `createJsSession()` - Create persistent QuickJS context with console redirection
- `hasJsSession()` - Check if session is active
- `disposeJsSession()` - Release context and free memory

**Agentic Loop Integration (`useChat.ts`):**

1. When first `tool_use` response detected and JS tool enabled → `createJsSession()`
2. All JS tool executions within the loop share the same context (variables persist)
3. When loop completes (stop_reason changes or max iterations) → `disposeJsSession()`
4. On error → `disposeJsSession()` in catch block

**Use Case Example:**

Call 1: `const data = [1, 2, 3]; data.length` → `3`
Call 2: `data.push(4); data` → `[1, 2, 3, 4]` (data persists!)

**Instance Management:**

- `initJsTool()` - Create singleton instance, register with toolRegistry
- `disposeJsTool()` - Unregister from toolRegistry, dispose any active session, clear instance

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

**Scrolling Pattern:**

```tsx
className = 'overflow-y-auto overscroll-y-contain ios-scroll';
```

Parent flex containers need `min-h-0` for proper shrinking.

**Safe Area Insets (iOS):**

Viewport uses `viewport-fit=cover` to extend into unsafe areas.

**Viewport Height:** Use `h-dvh` (Tailwind's dynamic viewport height) instead of `h-screen`. iOS Safari's `100vh` includes the area behind browser chrome and safe areas, making pages taller than the visible viewport. `dvh` units account for this and give the actual visible height.

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

**iOS Keyboard Handling:**

iOS Safari/PWA has viewport bugs where the virtual keyboard doesn't properly resize the layout, causing touch targets to become misaligned with visual elements.

- `useIOSKeyboard` hook tracks keyboard state via `visualViewport` API
- Sets `--keyboard-offset` CSS variable on document root (0px when keyboard closed)
- `ChatView` applies `paddingBottom: var(--keyboard-offset)` to compensate for iOS viewport issues
- `ChatInput` calls `scrollIntoView()` on focus (with 100ms delay for keyboard animation)
- No effect on desktop/Android (offset stays 0px when viewport behaves correctly)

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

1. **OpenAI/xAI Thinking** - Implement `migrateMessageRendering` thinking support when providers expose thinking
2. **Code Execution** - Add `CodeExecutionRenderBlock` for agentic features
3. **Custom Tools** - Extend block types beyond web search/fetch
4. **Citation Tooltips** - Hover tooltips for `data-cited` content
5. **Streaming Abort** - Handle abort signal mid-stream

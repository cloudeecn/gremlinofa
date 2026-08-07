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

GremlinOFA (Gremlin Of The Friday Afternoon) is a general-purpose AI chatbot web application built with React and Vite that supports multiple AI providers (ChatGPT compatible, Anthropic, Google Gemini, AWS Bedrock) with project-based organization and chat management.

**Tech Stack:** React • TypeScript • Vite • React Router • Tailwind CSS • IndexedDB • AES-256-GCM encryption • React Context API • PWA

## Features Status

### Core Features (Implemented)

- [x] Project & chat management with cascading deletion
- [x] Project settings (system prompt, pre-fill, model, temperature, reasoning, web search, message format)
- [x] Chat with streaming responses, message editing, forking, rollback, and cost tracking (separate minion token/cost tracking in info bar)
- [x] Message rendering (Markdown, syntax highlighting, LaTeX math with disable-math toggle, thinking blocks, citations, code block copy, word-break on non-code containers)
- [x] Image attachments (resize, compress, multi-select, preview, lightbox)
- [x] Virtual scrolling for long message histories with scroll-to-bottom button and hysteresis bounce protection
- [x] API clients (OpenAI Responses, OpenAI Chat Completions, Anthropic, Google Gemini, Bedrock) with streaming and cross-model tool call reconstruction
- [x] Cache-routing key (`prompt_cache_key` for OpenAI/Responses, `metadata.user_id` for Anthropic) — defaults to sha256(projectId); per-project Advanced toggle switches to sha256(chatId) (minion sub-loops naturally key off their own chatId). Gemini and claude-agent have no equivalent field and are unaffected.
- [x] Flex / batch tier (≈50% discount, lower priority). Per-provider `flexTierSupported` toggle gates the per-project `flexTierEnabled` opt-in; OpenAI clients inject `service_tier: 'flex'`, Google Gemini injects `serviceTier: 'flex'`. Cost calc applies a 0.5× multiplier to token-priced lines (per-request fees not discounted). Doubao Seed 2.0/1.8 + gemini-3.5-flash metadata added at the same time.
- [x] Model discovery and caching per API definition
- [x] Pricing system with per-message cost snapshots
- [x] Encrypted storage (IndexedDB + AES-256-GCM)
- [x] Data export/import with re-encryption support
- [x] Project export/import (.gremlin.json bundles — portable, decrypted, hand-craftable)
- [x] PWA with offline support and install prompt
- [x] Responsive layout (desktop two-panel, mobile drawer)
- [x] Draft persistence (localStorage with auto-save)

### Pending Features

**Infrastructure & Build**

- [x] Configure build optimization (conditional base path, PWA denylist for /dev)
- [x] Production source maps with runtime mapping for readable stack traces
- [x] CORS proxy backend (`cors-proxy/` - Express, SSE streaming) with per-API-definition proxy URL + optional caller auth: set `PROXY_AUTH_TOKEN` on the proxy and a per-API-definition `proxyAuthToken` in the app; sent as the `X-Proxy-Auth` header (distinct from the upstream `Authorization` key) and stripped before forwarding. Unset = open proxy (deploy behind an authenticating reverse proxy)
- [ ] Bundle size analysis (chunk splitting for large KaTeX/highlight.js bundles)
- [ ] Native TLS termination in the Node WebSocket server (currently requires reverse proxy)
- [ ] Configurable DB backend for the server (currently hardcoded to `better-sqlite3`; candidates: `node:sqlite` (built-in, zero deps, Node 22.5+), external DB via pure JS drivers (`pg`, `mysql2`), or custom adapters)

**PWA**

- [ ] Splash screen configuration
- [ ] Update notification system

**Storage & Data**

- [x] Lightweight deployable remote storage (`storage-backend/` - SQLite + Express)
- [x] VFS server (integrated build target in `src/server/vfsFacade/` + shared engine in `src/server/vfsEngine/`)
- [x] Symlink policy on server / filesystem VFS — every op realpath-resolves and checks against an allow-list (project root + `VFS_EXTRA_ROOTS`). Off by default: any symlink under a project root is rejected and hidden from listings. `VFS_FOLLOW_SYMLINKS=true` opts in; the canonical target must still land in an allowed root. `VFS_EXTRA_ROOTS` is PATH-style (`/global:projectId|/scoped`). Misconfig aborts boot.
- [x] Remote VFS adapter (frontend `RemoteVfsAdapter` talks to VFS server, E2E encryption deprecated — read-only for migration)
- [x] VFS adapter routing — all callers (UI via `useVfsAdapter` hook, tools/JSVM/hooks via `ToolContext.vfsAdapter`, `createVfsAdapter` factory for cross-namespace access, system prompt generation via `SystemPromptContext.createVfsAdapter`)
- [x] VFS Manager clickable root node (create files/dirs at `/`, download entire VFS as ZIP, upload ZIP)
- [x] OOBE wizard (start fresh / import backup / use existing remote data)
- [x] Attachment manager (view, select, delete, delete older than X days, missing attachment handling)
- [x] Storage quota display (local IndexedDB only, shows usage/quota with warning at >100MB or >50%)
- [ ] Data migration between localStorage and remote storage
- [x] Server: CEK oracle verification on init — encrypted oracle in metadata table, verified before any data writes; wrong-CEK init returns `CEK_MISMATCH` and server stays dormant
- [x] VFS migration during cross-backend import (see design below)
- [x] Remote storage bulk operations (for faster export/import):
  - [x] Add `exportPaginated()` and `batchSave()` to `StorageAdapter` interface
  - [x] Implement in `RemoteStorageAdapter` (calls `/_export` and `/_batch` endpoints)
  - [x] Implement in `IndexedDBAdapter` (cursor-based pagination, bulk put with transaction)
  - [x] Add tests for both adapters
  - [x] Use in `dataExport.ts` for exporting (removed IndexedDB cursor hack)
  - [x] Use in `dataImport.ts` for faster batch importing
- [ ] Storage convergence: absorb `storage-backend/` into main project as build target (like VFS server)
  - Per-table schema with `userId` column (NULL for single-tenant, populated for multi-tenant)
  - Server backend derives `userId` from CEK for multi-tenant readiness
  - Schema migration approach: add column with ALTER TABLE, backfill existing rows

**UI & UX**

- [ ] Dark mode support with toggle
- [ ] Accessibility features (ARIA labels, keyboard navigation)
- [ ] Loading states and skeletons
- [ ] Monochrome emoji
- [x] ProjectView new chat: Enter inserts newline on mobile (matches ChatInput behavior)
- [x] ProjectView new chat: "Send as File" button (📄) writes text to VFS `/tmp/` and starts chat with file path (only shown when filesystem tool is enabled)

**Chat Features**

- [x] Background API support (loop runs in worker / server; UI re-attaches via long-lived `attachChat` subscription, navigation does not kill the loop)
- [x] Soft stop for agentic loop (stop button halts at next tool boundary)
- [x] Abort ongoing API calls (hard abort via `gremlinClient.abortLoop` → `LoopRegistry.abort` → `AbortController` → API client `signal:` option)
- [x] Focus mode (⋯ menu: hides backstage, tool results, metadata; shows only user text/images + assistant text)
- [x] Expand minions (⋯ menu: inline minion name/model/input/output without collapsed bar)
- [x] Disable Math toggle (⋯ menu: renders `$...$` as literal text instead of KaTeX)
- [x] Always Auto Scroll (⋯ menu: keeps auto-scroll active regardless of scroll position)
- [x] DUMMY System (LLM-registered JS hooks intercept the agentic loop before API calls — synthetic responses, user handoff, or passthrough; async hooks and top-level await supported)
- [x] Remote human minion ("Touch Grass") — delegates minion tasks to a human via `touch-grass-backend/`. Minion tool gains `remote` parameter + `remoteEndpoint`/`remotePassword` options. Backend provides web UI for human operators with session list, chat view, and long-poll delivery.

**API & Pricing**

- [ ] API key validation
- [x] Advanced settings per API definition (collapsible section in Settings)
  - [x] Prune previous thinking blocks (strips thinking/reasoning from historical messages for providers that reject them)
  - [x] Prune empty text blocks (removes empty text blocks from historical messages)
  - [x] Enforce genuine Anthropic (rejects responses with zero cache activity or unsigned thinking blocks)
  - [x] De facto thinking mode (sends `{thinking: {type: enabled/disabled}}` for DeepSeek, Kimi, MiMo, etc. — settable per model metadata or per provider)
  - [x] Nudge model to think (appends a nudge phrase like `<<WITH THINKING STEPS>>` to last user message at send time — for models that skip chain-of-thought without a nudge; resolved as a loop option via `buildAgenticLoopOptionsForContext`, overridable per minion call via `minionTool` `nudgeThinking` input)
  - [x] Mandate chain-of-thought (requires at least one response with reasoning tokens/thinking blocks per agentic run — triggers minion savepoint rollback on retry)
- [x] Pricing display in Model Selector
- [x] Cache pricing fallback (cache tokens priced at inputPrice when no cache-specific price)
- [x] Cache pricing display
- [ ] Script to automatically parse pricing data from api provider's pricing page
- [ ] Context-length-tiered pricing — higher tiers are recorded in `unsupportedHighContextPricing` (e.g. Qwen ≥256K) but `calculateCost` always bills the base (sub-threshold) tier

**Statistics & Display**

- [x] Token display formatting (##.#k format, grouped by direction: `↑(123, C↑101, C↓202) ↓(456, R:789)`)
- [x] Cost display precision (3 decimals)
- [x] Chat-level token totals (cumulative)
- [x] Context window usage (recalculated)
- [x] Real-time token usage in chat header
- [x] Incremental cost/token persistence during agent loop (crash-resilient)
- [x] Fork tracking and cost analysis
- [x] Tool call cost tracking (minion sub-agent costs flow into chat totals)
- [x] Minion chat view (overlay, accessible via "View Chat" button in tool result; main chat continues streaming underneath; per-message delete for manual restoration)

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
- [x] Chat components tested (MessageBubble, UserMessageBubble, AssistantMessageBubble, MessageList, BackstageView, ErrorBlockView, TextGroupView, ToolResultView, ToolResultBubble, StopReasonBadge, StreamingMessage, CacheWarning, MinionChatView)
- [x] Error components tested (ErrorView, ErrorFloatingButton)
- [x] OOBE components tested (OOBEScreen, OOBEComplete)
- [x] Integration tests (import/export roundtrip with 210+ records, duplicate handling, CSV special characters)
- [x] Cross-adapter export/import tests (IndexedDB ↔ Remote, bidirectional sync, pagination, re-encryption)
- [x] Cross-adapter E2E roundtrip tests (fake-indexeddb + live storage-backend, real encryption)
- [x] DUMMY System tests (dummyHookRuntime, dummyTool)
- [x] Remote storage E2E tests (RemoteStorageAdapter against real storage-backend)
- [x] Worker mode safety net (bridged integration test: WorkerTransport ↔ workerHandler ↔ GremlinServer ↔ fake-IndexedDB, shared STREAM_METHODS with compile-time exhaustiveness check, createVfsAdapter unit test)
- [ ] E2E tests (full app)

## Data Model

### API Definitions

- Multiple API definitions per provider type (APIType: `responses_api`, `chatgpt`, `anthropic`, `bedrock`, `google`, `ds01-dummy-system`)
- Each definition: name, icon (optional emoji), baseUrl (optional), apiKey (not required when `isLocal` is true)
- `isLocal` flag marks providers that don't need API keys (e.g., local LLM servers like Ollama, LM Studio)
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
- **Anthropic reasoning**: enable toggle + budget tokens (default: 1024) + keep thinking turns + adaptive mode (budget = 0 on Opus 4.6/Sonnet 4.6)
- **Reasoning effort**: shared control across providers — maps to OpenAI/Nova effort directly, Anthropic adaptive `output_config` when budget = 0
- **OpenAI/Responses reasoning**: summary (`undefined` = auto)
- **Web search** toggle
- **Message format**: three modes (user message / with metadata / use template)
- **Tools**: Memory (Anthropic only), JavaScript Execution, Filesystem, Sketchbook, Checkpoint, Metadata, DUMMY
- **Advanced** (collapsed): temperature, max output tokens (default: 1536), disable streaming, extended context (1M)
- **Tool option `visibleWhen`**: conditional visibility — options can depend on sibling option values (e.g., deferred return settings only shown when deferReturn is on)

### Chats

- Organized under projects, inherit project settings
- Can override API definition/model per chat
- Store message history with metadata (tokens, model, timestamps)
- Track cumulative token totals
- `summary?: string` — AI-settable chat summary (via metadata tool)
- `activeHook?: string` — DUMMY System hook name active for this chat

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
├── shared/         # Pure layer — runs in worker, jsdom, and the future Node server
│   ├── protocol/   # Phase 1.7 split into focused files:
│   │   ├── wire.ts        # Envelopes, identifiers, helper types
│   │   ├── errors.ts      # ProtocolErrorCode union
│   │   ├── events.ts      # LoopEvent / ActiveLoopsChange / Export / Import / VFS compact
│   │   ├── methods.ts     # GremlinMethods registry + per-method param/result
│   │   ├── protocol.ts    # Barrel re-exporting from the four files above
│   │   ├── protocolError.ts  # ProtocolError carrier exception
│   │   └── types/         # Application data models (Chat, Project, Message,
│   │                      # content blocks, ToolContext, VfsAdapter, …)
│   ├── engine/     # GremlinServer, ChatRunner, LoopRegistry, backendDeps,
│   │               # buildLoopOptions, dataExport/Import, exportRunner/importRunner,
│   │               # messageMetadata, messageWire, projectBundle, transports/inProcess.ts
│   │   └── lib/    # Backend-only pure helpers (Phase 1.8 relocated from src/lib/ + src/utils/):
│   │               # apiHelpers, assertNoLoopsRunning, incompleteTail, vfsPaths,
│   │               # cekFormat, csvHelper, formatFileContent, reasoningEffort, tokenTotals,
│   │               # api/{mergeExtraModels, modelMetadata, model_metadatas/*}
│   └── services/   # Business logic subdirectories:
│       ├── agentic/    # Agentic loop generator + dummy hook runtime
│       ├── api/        # API clients, pricing modules, stream mappers
│       ├── compression/# Gzip compression using Compression Streams API
│       ├── encryption/ # EncryptionCore — pure crypto primitives
│       ├── storage/    # UnifiedStorage + StorageAdapter + CachedStorageAdapter (1.65 hoisted IndexedDB / Remote inner adapters to worker/adapters/)
│       ├── streaming/  # StreamingContentAssembler for real-time rendering
│       ├── tools/      # Tool implementations (fs, memory, sketchbook, minion, etc.)
│       └── vfs/        # VfsService + LocalVfsAdapter (1.65 hoisted RemoteVfsAdapter + adapter dispatch to worker/adapters/)
├── frontend/       # Browser main-thread UI layer
│   ├── App.tsx, main.tsx
│   ├── client/     # GremlinClient + transports (worker + WebSocket)
│   ├── components/ # Sidebar, Modals, project/, chat/, ui/, activeLoops/
│   ├── contexts/   # React Context providers (App, Alert, Error)
│   ├── hooks/      # Custom hooks (useChat, useProject, useVirtualScroll, etc.)
│   └── lib/        # Frontend-only helpers (Phase 1.8 relocated from src/utils/ + src/constants/):
│                   # alerts, apiTypeUtils, emojis, formatBytes, imageProcessor,
│                   # lcsDiff, localStorageBoot, markdownRenderer, mathRenderer,
│                   # messageFormatters, projectExport, stackTraceMapper
├── worker/         # Web Worker entry point + browser-only adapters
│   ├── gremlinWorker.ts
│   └── adapters/   # IndexedDBAdapter, RemoteStorageAdapter, RemoteVfsAdapter,
│                   # createStorageAdapter, createVfsAdapter (factories injected
│                   # into BackendDeps via setBootstrapAdapterFactories)
├── server/         # Phase 2 Node WebSocket backend
│   ├── nodeEntry.ts           # Server entry — loads config, GremlinServer, WebSocket listener
│   ├── config.ts              # Env-based config (PORT, STORAGE_PATH, VFS_MODE, etc.)
│   ├── websocketTransport.ts  # Server-side ws handler — dispatches to GremlinServer
│   └── adapters/              # SqliteStorageAdapter, FilesystemVfsAdapter, factories
├── test/           # Test configuration (Vitest setup)
├── index.css
└── vite-env.d.ts
public/             # Static assets and PWA icons
```

Path aliases (`vite.config.ts` + `tsconfig.app.json`): `@shared/*`,
`@frontend/*`, `@worker/*`, `@server/*`. Existing relative imports were
left untouched in the Phase 1.6 reshuffle (and the Phase 1.7 types move
preserved relative paths via a one-shot Node script rather than switching
to the alias).

#### Frontend / Backend Split (Phase 1 complete; Phase 2.0 in progress)

The codebase is split into four runtime layers — `shared/` (pure), `frontend/` (browser main thread), `worker/` (Web Worker entry), and `server/` (Phase 2 Node placeholder). The RPC contract lives in `src/shared/protocol/` (TypeScript types only, split into focused files) and is shared by both sides. The agentic loop, storage, encryption, API clients, and tools run inside a Web Worker today and will hop into a Node WebSocket process in Phase 2 — both deployments share the same `src/shared/engine/GremlinServer` dispatcher.

- **`src/shared/protocol/`** — Phase 1.7 split the original 967-line `protocol.ts` into focused files: `wire.ts` (envelopes, identifiers, helper types), `errors.ts` (`ProtocolErrorCode` union), `events.ts` (LoopEvent, ActiveLoopsChange, Export/Import progress, project bundle, VFS compact stream payloads), `methods.ts` (the `GremlinMethods` registry plus per-method param/result types), and `protocol.ts` (now a barrel re-exporting from the four files for backward-compatible imports). `protocolError.ts` carries the `ProtocolError` exception class so destructive-op guards can construct it without a circular import on the dispatcher. `types/` holds the application data models (Chat, Project, Message, content blocks, ToolContext, VfsAdapter, etc.) that Phase 1.7 hoisted out of the top-level `src/types/` — every layer now imports them from `@shared/protocol/types` (or relative equivalents).
- **`src/shared/engine/`** — `GremlinServer` (method dispatcher; supports deferred mode where `_deps` is `null` until `init({cek})` arrives), `ChatRunner` (per-loop wrapper around `runAgenticLoop`, fires `message_created` for synthesized user messages, enforces incomplete-tail lock + soft-stop via `LoopRegistry.isSoftStopRequested`), `LoopRegistry` (also caches per-chat replay state for `attachChat` mid-stream reattach: in-flight `pending_tool_result` + merged `tool_block_update` state, replayed as the in-progress tool UI; and the latest `streaming_chunk` groups, replayed as a `streaming_snapshot` so the partially-streamed assistant bubble rehydrates immediately instead of going blank until the next token — matters most for claude-agent, whose single `sendMessageStream` spans a whole multi-tool SDK turn with long no-token gaps. Streaming groups cleared on the assistant `message_created` that supersedes them; pending-tool entries on their matching `message_created`; both as a safety net on `loop_ended`), `buildLoopOptions.ts` + `messageMetadata.ts`, `exportRunner.ts` + `importRunner.ts`, `dataExport.ts` + `dataImport.ts` + `projectBundle.ts`, `transports/inProcess.ts` (the in-process `Transport` interface + `InProcessTransport` implementation). Streaming methods wired: `runLoop`, `subscribeActiveLoops`, `attachChat`, `exportData`, `importData`, `vfsCompactProject`.
- **`src/shared/services/`** — agentic loop, API clients + stream mappers, compression, encryption (`EncryptionCore`, the only encryption flavor that exists), storage (`UnifiedStorage` + `CachedStorageAdapter` decorator + the `StorageAdapter` interface — the browser-only inner adapters now live under `src/worker/adapters/`), streaming assembler, tools, VFS (`LocalVfsAdapter` + `treeLock` + `vfsService` — `RemoteVfsAdapter` and the per-project dispatch live under `src/worker/adapters/`).
- **`src/frontend/`** — `App.tsx`, `main.tsx`, `components/`, `hooks/`, `contexts/`, `client/` (GremlinClient + GremlinSession + ActiveLoopsStore + bootstrapClient + worker transport), `lib/` (frontend-only helpers). The main thread no longer constructs an encryption instance — OOBE / Data Manager use `src/frontend/lib/localStorageBoot.ts` to read/write the CEK string and the dormant-callable RPCs (`generateNewCEK`, `normalizeCEK`, `deriveUserIdFromCEK`) on `gremlinClient` for format conversions, then post the string through `gremlinClient.init({cek})`.
- **`src/worker/gremlinWorker.ts`** + **`src/worker/workerHandler.ts`** — Web Worker entry is a two-line bootstrap passing `self` to `createWorkerHandler(scope)`. The handler (extracted for testability) boots dormant, calls `setBootstrapAdapterFactories` (registers `createStorageAdapter` and `createVfsAdapter` from `src/worker/adapters/`), then accepts a non-protocol `worker_config` envelope for the storage config and handles a typed `init({cek})` to bring up encryption + storage + the rest of the engine. Stream vs one-shot dispatch uses the shared `STREAM_METHODS` set from `src/shared/protocol/streamMethods.ts` (compile-time exhaustiveness check against `GremlinMethods`).
- **`src/worker/adapters/`** — browser-only adapter implementations + worker-side factories. Files: `IndexedDBAdapter.ts`, `RemoteStorageAdapter.ts`, `RemoteVfsAdapter.ts`, `createStorageAdapter.ts` (config → `CachedStorageAdapter`-wrapped inner adapter), `createVfsAdapter.ts` (project → `LocalVfsAdapter` or `RemoteVfsAdapter`). Phase 1.65 hoisted these out of `src/shared/` so the shared layer's lint rules can ban `indexedDB` / `navigator`.
- **`src/frontend/client/`** — `GremlinClient` (typed RPC facade exposing every protocol method, plus `exportToBlob` / `importFromBytes` / `vfsCompactProject` / `configureWorker` / `onReconnect` helpers), `GremlinSession` (per-chat session adapter; registers `onReconnect` to re-attach the `attachChat` stream after WebSocket reconnect), `ActiveLoopsStore`, `bootstrapClient.ts` (reads CEK + storage config from localStorage, derives userId for remote configs, calls `gremlinClient.configureWorker(storageConfig)` — skipped for `server` mode — then `gremlinClient.init({cek})` before React mounts), `transports/worker.ts` (`WorkerTransport` — waits for `worker_ready`, posts `worker_config` ahead of `init`, queues every non-`init` request until `init` succeeds, sends `stream_cancel` on consumer-side `break`), `transports/websocket.ts` (`WebSocketTransport` — see **WebSocket Anti-Zombie System** section below for heartbeat, stale detection, visibility probe, and `ConnectionStatusBanner`). Singleton transport selected by `getStorageConfig()` at construction time: `{ type: 'server' }` → `WebSocketTransport`, otherwise `WorkerTransport`. Constructed lazily via a `Proxy` so jsdom-only component tests don't trigger worker spawn unless they actually call a method.

#### WebSocket Anti-Zombie System

Detects and recovers from dead/zombie WebSocket connections — the kind that look `OPEN` but silently swallow messages. Applies only to server-mode (`WebSocketTransport`); worker transport is unaffected.

**Problem:** When the user backgrounds the tab (app switch, laptop sleep), the OS may suspend the socket. On return the socket's `readyState` still reads `OPEN`, but it's dead — messages sent into it vanish. The user sees nothing wrong, clicks send, and the message goes to void.

**Detection layers** (all in `src/frontend/client/transports/websocket.ts`):

| Layer               | Timing                                               | What it does                                                                                                                                                     |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat ping/pong | every 2s (`HEARTBEAT_INTERVAL_MS`)                   | Sends `{ kind: 'ping' }`, server replies `{ kind: 'pong' }`. Any incoming message resets the timeout via `onPong()`.                                             |
| Stale detection     | 4s without any server message (`STALE_THRESHOLD_MS`) | Checked inside the heartbeat interval. Sets `ConnectionState` to `'stale'` — banner warns user before they click send. Clears automatically when a pong arrives. |
| Dead detection      | 5s pong timeout (`HEARTBEAT_TIMEOUT_MS`)             | If the stale warning didn't clear, socket is closed → triggers reconnect.                                                                                        |
| Visibility probe    | on `document.visibilitychange` → `'visible'`         | Sends an immediate ping + arms the 5s timeout. Catches zombie sockets within seconds of tab-resume instead of waiting for the next 2s heartbeat tick.            |

**State machine** (`ConnectionState` in `src/shared/protocol/transport.ts`):

```
connecting → connected ⇄ stale → disconnected → reconnecting → connected
                                                      ↑              │
                                                      └──────────────┘
```

- `connecting` — initial WebSocket handshake (first connection only)
- `connected` — socket open, pongs arriving
- `stale` — no pong for >4s, banner warns user (may self-heal if pong arrives)
- `disconnected` — socket closed, in-flight streams terminated, one-shot requests queued for retry
- `reconnecting` — backoff timer scheduled or `new WebSocket()` in progress

**Reconnect resilience:**

- Exponential backoff: 1s → 30s (`INITIAL_BACKOFF_MS` / `MAX_BACKOFF_MS`)
- **Init replay on reconnect:** transport saves `lastInitParams` on first successful `init`, replays it as the first message after reconnect. Without this, the `initPromise` gate blocks all non-init RPCs forever → blank page. Server-side `init` is idempotent with the same CEK.
- One-shot requests survive disconnect: `inflightEnvelopes` → `retryQueue`, replayed on reconnect (after init) with same `requestId` so the caller's promise eventually resolves
- Streams don't survive: terminated with `status: 'error', detail: 'transport disconnected'`
- `GremlinSession.onReconnect` re-attaches `attachChat` stream, replaying the chat snapshot. **Partial reconsolidation:** session sends the last 20 message IDs via `knownMessageIds`; server walks them against persisted messages, yields `partial_reconsolidate` with the last matched ID, then only the tail. Falls back to full snapshot when the first ID isn't found.
- **Snapshot loading phase (`snapshotLoading`):** `useChat` tracks a `snapshotLoading` boolean that is `true` during initial snapshot replay and reconnect snapshot replay (from `reconnect_start` until `snapshot_complete`). During this phase: auto-scroll is suppressed in `MessageList`, the input bar is disabled, and derived states (`showContinueBanner`, `unresolvedToolCalls`, incomplete-tail banner) are gated to prevent flicker. On completion, `MessageList` scrolls to bottom once via `requestAnimationFrame`.

**UI (banner):**

- `src/frontend/components/ConnectionStatusBanner.tsx` — placed above `<Routes>` in `App.tsx`
- `src/frontend/hooks/useConnectionState.ts` — subscribes to `gremlinClient.onConnectionStateChange`
- `stale`: amber "Checking connection..." (shown immediately, no debounce — whole point is to warn before send)
- `disconnected`: red "Connection lost — reconnecting..." (500ms debounce to avoid flicker)
- `reconnecting`: amber "Reconnecting..."
- Recovery: green "Reconnected" flash (1.5s) then hidden

**Files:**

| File                                                 | Role                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/frontend/client/transports/websocket.ts`        | Transport: heartbeat, stale/dead detection, visibility probe, state observable, reconnect |
| `src/shared/protocol/transport.ts`                   | `ConnectionState` type + optional `Transport` interface members                           |
| `src/frontend/client/GremlinClient.ts`               | Pass-through: `connectionState` getter + `onConnectionStateChange`                        |
| `src/frontend/hooks/useConnectionState.ts`           | React hook subscribing to connection state                                                |
| `src/frontend/components/ConnectionStatusBanner.tsx` | App-wide banner rendering connection state                                                |
| `src/frontend/App.tsx`                               | Banner placement (above `<Routes>` in `AppContent`)                                       |

**Tuning knobs** (constants at top of `websocket.ts`):

- `HEARTBEAT_INTERVAL_MS` (2s) — ping frequency. Lower = faster detection, more traffic.
- `HEARTBEAT_TIMEOUT_MS` (5s) — pong deadline before socket is closed.
- `STALE_THRESHOLD_MS` (4s) — show warning banner before full disconnect.
- `INITIAL_BACKOFF_MS` (1s) / `MAX_BACKOFF_MS` (30s) — reconnect backoff range.

**Possible follow-up approaches to try:**

- [ ] Queue outbound messages during `stale` state instead of letting them hit the maybe-dead socket (currently `send()` still fires if `readyState === OPEN`)
- [ ] Disable the send button / show inline warning in ChatInput when stale or disconnected
- [ ] Server-side dead-client detection (server pings client, closes if no pong — currently server is passive)
- [ ] Adaptive heartbeat interval (slower when tab is hidden to save battery, faster on resume)

- **`src/frontend/components/activeLoops/`** — `RunningLoopsSection.tsx` + `ActiveLoopRow.tsx`. Mounted in `Sidebar.tsx`, project-agnostic. The chat view's soft-stop stays; hard abort lives only in the sidebar. Minion sub-loops register themselves on the per-server `LoopRegistry` from inside `executeMinion` (parent chat id, parent loopId, persona/displayName label) so they appear as indented child rows under the parent and the STOP button can hard-abort one without touching its siblings. Each child has its own `AbortController`; aborting the parent cascades to every child via a one-shot `addEventListener('abort', ...)` listener wired in the minion tool, but child → parent abort is intentionally unidirectional. `BackendDeps.loopRegistry` is the same instance held by `GremlinServer.registry` — threaded through `ToolContext.loopRegistry` so tools never reach for the server directly.
- **`useChat`** is a thin React adapter (~660 lines) that subscribes to a `GremlinSession` and translates `LoopEvent`s into React state with the same 200ms throttle. Tool-use block detection reads the backend-pre-extracted `message.content.toolUseBlocks` field (Phase 1.8 leak fix) — the frontend never imports the provider-specific parser. `isLockedByIncompleteTail` is now pushed by the backend via the `lock_state_changed` LoopEvent (Phase 1.7) — `useChat` stores the latest value and surfaces it as the `Delete Message` / `Roll Back to Checkpoint` banner predicate. The frontend no longer imports `isChatLockedByIncompleteTail` from `src/lib/`; the backend computes it in `GremlinServer.broadcastChatLockState` (called from `deleteMessageAndAfter` / `saveMessage` / `attachChat` snapshot) and from `ChatRunner.run`'s teardown so the abort path's incomplete tail flips the lock as soon as the loop unwinds.
- **VFS facade** — Phase 1.7 deleted `useVfsAdapter`. Components that want a project-bound `VfsAdapter` call `gremlinClient.getVfsAdapter(projectId)` (typically wrapped in `useMemo`). The method returns a plain object whose every operation delegates back into the per-call `vfs*` RPCs on `GremlinClient`. The actual local/remote adapter is constructed and cached server-side in `GremlinServer.getProjectVfsAdapter`.
- **Four-layer boundary lint rules (Phase 1.6)** (`eslint.config.js`):
  1. `src/shared/**` cannot import from `src/{frontend,worker,server}/**`
  2. `src/frontend/**` cannot import from `src/{worker,server}/**`
  3. `src/worker/**` cannot import from `src/{frontend,server}/**`
  4. `src/server/**` cannot import from `src/{frontend,worker}/**`
  - `no-restricted-globals` on `src/shared/**`: bans `localStorage`, `sessionStorage`, `document`, `window`, plus `indexedDB` and `navigator` (added in 1.65, after the adapter move). `crypto` and `fetch` stay allowed because they exist in workers and modern Node.
  - **Frontend service boundary (Phase 1.8 tightened)**: all `src/frontend/**` code may only import from `src/shared/protocol/**` or `src/frontend/**`. `src/shared/{engine,services}/**` are off-limits — route through `gremlinClient` RPCs or consume `LoopEvent`s. The top-level `src/lib/`, `src/utils/`, `src/constants/` directories are gone — Phase 1.8 relocated every file into `shared/engine/lib/` (backend-only helpers) or `frontend/lib/` (frontend-only helpers).
  - Tests under `**/__tests__/**` are excluded from all rules so test stubs that touch internal types stay simple.
- **Pragmatic deviations from the plan** — all resolved: (a) Browser storage adapters → `src/worker/adapters/` (Phase 1.65). (b) `src/types/` → `src/shared/protocol/types/` (Phase 1.7). (c) `src/lib/`, `src/utils/`, `src/constants/` → two-bucket split into `shared/engine/lib/` (backend-only) and `frontend/lib/` (frontend-only) with type splits into `shared/protocol/types/` (Phase 1.8). Only `src/test/`, `src/index.css`, `src/vite-env.d.ts` remain at the top level.
- **Encryption split (Phase 1.5 + 1.65 + 1.8)**: `EncryptionCore` (`src/shared/services/encryption/encryptionCore.ts`) holds the runtime-agnostic crypto primitives — `derivedKey`, `initializeWithCEK`, `forget`, `encrypt`/`decrypt`, `encryptWithCompression`/`decryptWithDecompression`, `deriveUserId`, `hasSameKeyAs`. Zero `localStorage` coupling. The only path now is the worker constructing an `EncryptionCore` directly inside `GremlinServer.init` from the CEK string posted via `gremlinClient.init({cek})` — Phase 1.8 changed the wire format from `Uint8Array` to `string` so the frontend posts the localStorage CEK directly without decoding. CEK format helpers (`cekFormat.ts`) live under `shared/engine/lib/` — the frontend never imports them. Main-thread CEK lifecycle (read / write / clear) lives in `src/frontend/lib/localStorageBoot.ts`.
- **CEK init-over-RPC**: the worker boots dormant. `src/frontend/main.tsx` awaits `bootstrap()` (in `src/frontend/client/bootstrapClient.ts`) which reads the CEK string + storage config from localStorage, derives userId for remote configs via the dormant-callable `gremlinClient.deriveUserIdFromCEK(cekString)` RPC, then calls `gremlinClient.configureWorker(storageConfig)` followed by `gremlinClient.init({cek: cekString})`. The worker stashes the storage config via `setBootstrapStorageConfig` (driven by the non-protocol `worker_config` envelope) and constructs `EncryptionCore` + `UnifiedStorage` from `params.cek` and the stashed config. OOBE writes localStorage on its own and calls `configureWorker` + `init` directly. Data Manager uses `gremlinClient.clearCek()` + `clearCachedCEK()` for detach. CEK rotation uses `gremlinClient.rotateCek({newCek})` which spins up a temp `EncryptionCore` for the new key, walks every table via `exportPaginated`, decrypts with the active core + re-encrypts under the temp core + `batchSave`s the rotated rows, then transitions the server to dormant (forgets the active core, drops the deps bundle) so the frontend reconnects with a fresh `init` carrying the new CEK.
- **Init contract (locked Phase 1.5)**: `init` accepts only `{cek, subscriberId?}`. Posting any other field (notably the legacy `storageConfig`) is rejected with `INVALID_PARAMS`. Re-init with the same CEK is idempotent; re-init with a different CEK is rejected with `CEK_MISMATCH` — to change identity the caller must `purgeAllData` (or `clearCek`) first. Calling `init({})` (no CEK) on an already-initialized server with a CEK oracle in metadata is rejected with `CEK_REQUIRED`. The WebSocket transport drops the connection (close code 4001) on `CEK_MISMATCH` or `CEK_REQUIRED`. **Per-connection auth gate**: `WebSocketTransportServer` tracks `authenticated` per socket and rejects every non-`INIT_EXEMPT_METHODS` request with `NOT_INITIALIZED` (then close 4001) until that socket has completed its own successful `init`. This stops a second connection from riding the server's instance-global `initialized` flag — proving knowledge of the CEK is per-connection. Worker mode needs no gate (single trusted MessageChannel peer). TLS is still the operator's responsibility (reverse proxy); the gate is app-layer defense, not a substitute. OOBE defers `setCachedCEKString` to after `init` succeeds so a failed init never leaves a bad CEK in localStorage. `AppProvider.initializeApp` passes the cached CEK through `init({cek})` so `lastInitParams` always carries the CEK for reconnect replay.
- **Destructive-op guards (Phase 1.5)**: `rotateCek`, `purgeAllData`, `importData`, and `clearCek` all run `assertNoLoopsRunning` (`src/lib/assertNoLoopsRunning.ts`) before touching storage. Refusal returns the new `LOOPS_RUNNING` protocol error code. The Data Manager UI subscribes to `activeLoopsStore` and disables the destructive buttons (Import Data, Detach Remote Storage, Delete All Data) when the snapshot count is non-zero, with an inline "stop all running loops first" hint.
- **Worker localStorage shim deleted**: `src/backend/worker/workerLocalStorageShim.ts` is gone. After the encryption split + storage config out-of-band channel, no backend code touches `globalThis.localStorage` at module load time. `grep localStorage` in `src/shared/**` and `src/worker/**` returns zero hits outside comments.
- **`messageCount` backfill** runs server-side in `GremlinServer.listChatsWithMessageCounts`. The frontend's `useProject` is a pure read-then-display effect — it never writes back.
- **Migration status (Phase 1.8)**: complete. Phase 1.8 delivered: (1) CEK wire format changed from `Uint8Array` to `string` — three dormant-callable RPCs (`generateNewCEK`, `normalizeCEK`, `deriveUserIdFromCEK`) let the frontend operate on CEK strings without importing any format helpers; (2) `extractToolUseBlocks` pre-extracted backend-side via `prepareMessageForWire` at every message-yield boundary — the frontend reads the field instead of re-running the provider-specific parser; (3) `mergeExtraModels` absorbed into the backend's `discoverModels` dispatch arm (no-key fallback + error fallback + cache write); (4) `vfsPaths` inlined on the frontend (5 sites `getBasename`, 1 site `getPathSegments`); (5) every file under `src/lib/`, `src/utils/`, `src/constants/` relocated into `shared/engine/lib/` (backend-only) or `frontend/lib/` (frontend-only), with `StorageConfig` and `BundleFileEntry`/`ProjectBundle` types hoisted to `shared/protocol/types/`, `idGenerator` moved to `shared/protocol/`; (6) `attachLoop` method + dispatch stub deleted, `subscriber_joined`/`subscriber_left` event types deleted; (7) frontend lint rule tightened to "may only import from `shared/protocol/**` or `frontend/**`". Phase 2.0 Session 1 landed: `src/server/` skeleton with `nodeEntry.ts`, `config.ts` (env-based config), `SqliteStorageAdapter` (`better-sqlite3`), `FilesystemVfsAdapter` (real files + `.ver/` versioning mirroring `vfs-backend/`), adapter factories, `tsconfig.server.json`, `build:server` script (`esbuild`). The `GremlinServer` dispatcher is shared unchanged — the server entry calls `setBootstrapStorageConfig({type: 'local'})` and the SQLite factory ignores the config arg (captures `ServerConfig` via closure). Phase 2.0 Session 2 landed: `WebSocketTransportServer` (`src/server/websocketTransport.ts`) — `ws`-based server handler dispatching to `GremlinServer`, per-connection stream tracking, cancel + disconnect cleanup; `WebSocketTransport` (`src/frontend/client/transports/websocket.ts`) — browser-side client with auto-reconnect (exponential backoff 1s→30s), heartbeat ping/pong (30s interval, 10s timeout), `onReconnect` callback; `Transport` interface extended with optional `onReconnect`; `GremlinSession` registers reconnect handler to re-attach `attachChat` stream; `GremlinClient` exposes `onReconnect` passthrough. Phase 2.0 Session 3 landed: `StorageConfig` expanded with `{ type: 'server'; wsUrl: string }` variant; `createDefaultTransport()` in `client/index.ts` branches on storage config — `server` → `WebSocketTransport`, else `WorkerTransport`; `bootstrapClient.ts` skips `configureWorker` for server mode; OOBE wizard adds "Remote Backend" storage option with WS URL input; `OOBEScreen` persists server config early (before first `gremlinClient` method) so the lazy singleton creates the right transport; `DataManagerPage` shows server mode indicator + "Disconnect Backend" button; `OOBEComplete` renders server storage info. Phase 2.0 is complete.

### Storage & Encryption

**Storage Adapter Pattern:**

- `StorageAdapter.ts` interface defines adapter contract
- Adapters: `IndexedDBAdapter.ts` (browser, local), `RemoteStorageAdapter.ts` (browser, remote API), `SqliteStorageAdapter.ts` (server, `better-sqlite3`)
- `unifiedStorage.ts` high-level API wraps adapter operations. `initialize()` requires the encryption core to already hold a CEK (it asserts via `isInitialized()` and throws otherwise — no implicit localStorage fallback).
- `StorageConfig` type lives in `src/shared/protocol/types/storageConfig.ts` (Phase 1.8 split from the runtime helpers; Phase 2.0 Session 3 added `{ type: 'server'; wsUrl: string }` variant for WebSocket backend). Runtime helpers (read/write/clear/hash) live in `src/frontend/lib/localStorageBoot.ts`.
- Factory functions: `createStorage(config, encryption)` and `createStorageAdapter(config)` always require an explicit config — no localStorage fallback.
- Tables: `api_definitions`, `models_cache`, `projects`, `chats`, `messages`, `attachments`, `memories`, `memory_journals`, `app_metadata`, `vfs_meta`, `vfs_files`, `vfs_versions`
- All tables have the same columns

**Surgical record updates (chats / projects / minion chats):**

- `saveChat` / `saveProject` / `saveMinionChat` are **create / full-overwrite** only. Updates go through `patchChat` / `patchProject` / `patchMinionChat` (the first two are also protocol methods + `gremlinClient` pass-throughs; `patchMinionChat` is backend-internal).
- A patch is a **read-merge-write**: read the latest record, overlay only the given `fields`, clear any `unset` keys, optionally bump the timestamp (`touch`), write back, return the merged record. Throws `*_NOT_FOUND` rather than creating.
- **Why:** the agentic loop and the user both used to write the whole `Chat`/`Project` back, so a rename / settings edit made while a loop ran (and two loops in one project) clobbered each other. Patches touch disjoint fields (loop owns token totals / `lastUsedAt`; user owns name / model override / settings), so they stop colliding. `ChatRunner` patches loop-owned fields and uses the merged return as both `currentChat` and the `chat_updated` payload.
- **`unset`, not `fields: { x: undefined }`:** the JSON wire (and `JSON.stringify` on encrypt) drops undefined-valued keys, so a clear must be an explicit `unset` list to survive. Frontend edit/rollback split the claude-agent rewind into `fields` + `unset` via `splitRewindPatch`.
- **Serialization:** every patch (and `deleteChat` / `deleteProject` / `moveChat`) runs under a per-record promise-chain lock keyed `${table}:${id}` (`recordLock.ts`, generalized from VFS's `withTreeLock`). Without it, two concurrent patches each read the same base and the second write drops the first's fields. The lock is **not reentrant** — patches write via private unlocked `write*Record` helpers; never call the locked public `save*` while holding the lock. Reads use the cached `get*` (invalidated on every write), never the uncached `query`.

**Remote Storage:**

- `RemoteStorageAdapter` connects to `storage-backend/` via REST API
- Auth: Basic authentication with userId + optional password
- userId derived from CEK via `EncryptionCore.deriveUserId()` (PBKDF2-SHA256, 600k iterations, 64-char hex)
- userId is computed once during OOBE and stored in `StorageConfig` (avoids async derivation at runtime)
- Password hashing: User-entered password is hashed via `hashPassword()` (SHA-512 with `|gremlinofa` salt) before storage/transmission, preventing plaintext password leakage if users reuse common passwords
- Config type: `StorageConfig = { type: 'local' } | { type: 'remote'; baseUrl; password; userId }`

**Storage Entry Point (`index.ts`):**

- `createStorageAdapter(config)` factory creates the appropriate adapter from an explicit config — no longer reads localStorage on its own.
- `createStorage(config, encryption)` factory creates a new `UnifiedStorage` instance with explicit config + a pre-keyed `EncryptionCore`.
- No module-level singleton: every consumer (worker `init`, `createGremlinServer`, OOBE) builds its own instance with the right encryption + config pair.

**Encryption:**

- `EncryptionCore` (`src/services/encryption/encryptionCore.ts`): pure crypto primitives, zero `localStorage` coupling. Constructed directly by the worker / future Node server / unit tests.
- `BrowserEncryptionService` (`src/services/encryption/encryptionService.ts`, exported under the legacy `EncryptionService` alias): extends `EncryptionCore` with the `localStorage` cache lifecycle (`initialize`, `getCEK`, `clearCEK`, `importCEK`, `convertCEKToBase32`, `isCEKBase32`). Used by the in-process / jsdom factory through the `bootstrapEncryption` hook on `BackendDeps`.
- CEK (Content Encryption Key): 32-byte random key, auto-generated on first run
- CEK storage: localStorage (`chatbot_cek`) in base32 format (52 characters) — only the main thread (via `BrowserEncryptionService` or `localStorageBoot`) ever touches it.
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

- `APIType` = protocol/client template (ChatGPT, Anthropic, Google, Bedrock, etc.)
- `APIDefinition` = configured instance (e.g., "xAI", "OpenRouter")

**StreamOptions** (in `baseClient.ts`):

- `temperature?: number` - Model temperature
- `maxTokens: number` - Max output tokens
- `enableReasoning: boolean` - Anthropic: enable thinking blocks
- `reasoningBudgetTokens: number` - Anthropic: budget for thinking. 0 + `supportsAdaptiveReasoning` = adaptive mode. Models with `onlyAdaptiveReasoning` (Opus 4.7+) force adaptive regardless of this value.
- `thinkingKeepTurns?: number` - Anthropic: thinking block preservation (`undefined` = model default, `-1` = keep all, `0+` = keep N turns). Opus 4.5 keeps all by default; others keep 1 turn.
- `reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` - OpenAI/Responses: reasoning effort level (`undefined` = auto). For Anthropic adaptive mode, `xhigh` maps to API `xhigh` on Opus 4.7 (distinct level) and to API `max` elsewhere; `max` always maps to API `max`.
- `reasoningSummary?: 'auto' | 'concise' | 'detailed'` - OpenAI/Responses: summary mode (`undefined` = auto). On Anthropic/Bedrock Claude, any non-`undefined` value opts into `thinking.display: 'summarized'` (needed on Opus 4.7, which defaults to `'omitted'`).
- `systemPrompt?: string` - System prompt
- `preFillResponse?: string` - Pre-fill assistant response (Anthropic only)
- `webSearchEnabled?: boolean` - Enable web search
- `enabledTools?: string[]` - Enabled client-side tools
- `extendedContext?: boolean` - Anthropic: opt into 1M context window beta (`context-1m-2025-08-07` header). Models with `supportsExtendedContext` in metadata: Opus 4.6, Sonnet 4.5, Sonnet 4. Above 200K input tokens, all tokens charged at premium rates (2x input, 1.5x output). Toggle is always visible in project settings; the beta header is only sent at runtime when the effective model supports it (gated in `agenticLoopGenerator`).
- `useAnthropicOneHourCache?: boolean` - Anthropic: emit `cache_control: { type: 'ephemeral', ttl: '1h' }` on all breakpoints (system prompt, sliding tail, stable anchor). Default off → omits `ttl` and Anthropic uses its 5m default. Honored only when `apiDef.apiType === 'anthropic'`. Cost accounting multiplies `cacheWritePrice` by 1.6× (2/1.25) when on, since stored prices assume the 5m write multiplier; cache-read prices are unchanged.
- `checkpointMessageId?: string` - Context tidy: computed tidy boundary ID (triggers pre-checkpoint trimming)
- `tidyToolNames?: Set<string>` - Context tidy: tool names whose blocks should be removed from pre-checkpoint messages

**API Clients:**

- Base client with shared streaming logic
- `ResponsesClient` (OpenAI Responses API with reasoning, vision, web search)
- `OpenAIClient` (Chat Completions with o-series/GPT-5 support)
- `AnthropicClient` (thinking blocks, prompt caching, web search/fetch, citations, Bedrock via `@anthropic-ai/bedrock-sdk` - see below)
- `BedrockClient` (AWS Bedrock Converse API for non-Claude models - see Bedrock Client section below)
- `ClaudeAgentClient` (`@anthropic-ai/claude-agent-sdk`, server-mode only — see Claude Agent Provider section below)

### Claude Agent Provider

Bills Claude Max subscription credit by going through `@anthropic-ai/claude-agent-sdk`, which spawns the host `claude` CLI subprocess. Reverse-engineering the OAuth header is banned; the SDK is the sanctioned path.

- **Server-mode only.** Worker mode registers `ClaudeAgentStubClient` which throws "requires server mode". `nodeEntry.ts` injects the real `ClaudeAgentClient` via `GremlinServer.setBootstrapClaudeAgentClientFactory` so the SDK stays out of the worker bundle. The host `claude` CLI must be on PATH; server startup probes `claude --version` and warns if missing.
- **Session-per-chat.** Each chat owns one SDK session (UUID v4) stored on disk at `<sessionDir>/<sessionId>.jsonl`. `Chat.claudeAgentSessionId` is set on first turn; presence locks the chat to claude-agent. Session dir defaults to `./data/claude-agent-sessions/` (override via `CLAUDE_AGENT_SESSION_DIR`).
- **Rollback as metadata.** The UI rollback button (and minion `verifyHook` failures) just set `chat.claudeAgentResumeAt` to the assistant message UUID stored on the rollback target's `MessageMetadata.claudeAgentMessageUuid`. The next user send passes it as `resumeSessionAt` to `query()`. No SDK call happens at rollback time.
- **Auth.** Empty `apiKey` → SDK uses host CLI credentials (`apiKeySource: 'none'`). Tokens starting with `sk-ant-oat01-` → `CLAUDE_CODE_OAUTH_TOKEN` env (subscription billing). Other keys → `ANTHROPIC_API_KEY` (API billing — defeats the purpose).
- **Supported knobs:** `enableReasoning` + `reasoningBudgetTokens` → SDK `thinking`; `reasoningEffort` → SDK `effort`; `injectFiles` with `inline`/`separate-block` modes (prepended to user prompt). `verifyHook` runs in our app after the SDK returns; rejection sets `claudeAgentResumeAt` for the next retry.
- **Tool bridging (in-process MCP).** Tools flagged `claudeAgentBridgeable` (`filesystem`, `memory`, `javascript`, `sketchbook`, `minion`) are exposed to the SDK as an in-process MCP server (`src/server/claudeAgentToolBridge.ts`, server name `gremlin`; tools surface to the model as `mcp__gremlin__<name>`). The exposed set is `run.enabledTools ∩ bridgeable`; with none enabled, `mcpServers` stays `{}` (no behavior change). Since the SDK owns the loop, calls are dispatched through `executeToolSimple` with the agentic loop's prebuilt `ToolContext` (threaded via `streamOptions.toolContext`), not `executeToolsParallel`. The MCP handler is the sole emitter of `tool_use`/`tool_result` StreamChunks — pushed onto a side-channel queue the client merges with the SDK message stream (`Promise.race`), so bridged tools render like other providers. Sub-agent (minion) costs return on `StreamResult.toolTokenTotals`; the loop folds them into chat totals _after_ the subscription cost-zeroing so non-subscription minion costs survive. Schema fidelity: we drive the low-level MCP `Server` (`tools/list` + `tools/call`) with our exact JSON Schema (minion's dynamic `anyOf` intact) — `McpServer.registerTool` is bypassed because it forces a Zod shape. **Built-in host tools (Read/Write/Edit/Bash) stay OFF** and `allowedTools` whitelists exactly the `mcp__gremlin__*` set (plus the web tools when web search is on — see next bullet), so the model never gets host-fs/Bash access; our tools are VFS-scoped. Hidden (not bridged): `return`/`checkpoint`/`dummy` (loop-control signals meaningful only to the bypassed loop) and `metadata` (its `chatMetadata` side-effect is owned by ChatRunner — a follow-up can route it via `providerExtra`).
- **Web search / fetch.** The project `webSearchEnabled` toggle now applies to claude-agent: when on, the SDK's built-in `WebSearch` + `WebFetch` are added to the `tools` allowlist and `allowedTools` (alongside any `mcp__gremlin__*`). The `tools` allowlist only ever lists those two web tools — `Read`/`Write`/`Edit`/`Bash` are never added — so host-fs/Bash stay off (parity with the Anthropic direct client, which pairs `web_search` + `web_fetch` under the same flag). The CLI's `server_tool_use` + `web_search_tool_result`/`web_fetch_tool_result` blocks are mapped onto the shared `web_search.*`/`web_fetch.*` StreamChunks in `handleSdkMessage`, so queries and source links render like other providers. `webSearchCount` is surfaced for display only — cost is subscription-zeroed.
- **Unsupported knobs** (silently logged via `console.debug`): `temperature`, `maxOutputTokens`, `nudgeThinking`, `thinkingKeepTurns`, `pruneThinkingBeforeApiCall`, `fileInjectionMode: 'as-file' | 'mock-tool-call'`. Provider-level advanced settings (`pruneThinking`, `enforceGenuineAnthropic`, etc.) are hidden in the SettingsPage UI for this apiType. Model discovery returns a hard-coded list (`claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`); the Models Endpoint / Extra Model IDs UI is hidden too.
- **UI gating** (`isClaudeAgentChat` prop): hides Edit/Fork buttons on user messages; Rollback remains and re-purposes to `resumeSessionAt`. Subscription chats are not convertible to ordinary chats — start a fresh chat to switch providers.
- **Minion integration.** A claude-agent _parent_ chat can call the `minion` tool via the tool bridge (above). A minion whose _own_ apiDef is `claude-agent` still forces `returnMode = 'no-return'` and `enabledTools = []` (that sub-agent's SDK turn has no tool plumbing of its own). Inline file injection still works. `MinionChat.claudeAgentSessionId` / `claudeAgentResumeAt` mirror the parent-chat fields.
- **Event plumbing.** `agenticLoopGenerator` emits `claude_agent_turn` after each successful claude-agent stream. `ChatRunner` and `minionTool` both consume it to persist the session ID and clear any pending `resumeAt` flag.
- **Live streaming (`includePartialMessages`).** The SDK is asked for raw token-by-token `stream_event`s (`SDKPartialAssistantMessage` = a `BetaRawMessageStreamEvent`) so claude-agent turns render live like every other provider. The partial events are routed through the shared `mapAnthropicEventToStreamChunks` (`src/shared/services/api/anthropicStreamMapper.ts`, reused unchanged) — the partial stream is the **sole live emitter** for text / thinking / web-search-intent. Three chunk types are filtered out of the mapper output: `tool_use` (the MCP side-channel owns bridged tool calls), `token_usage` (the `result` message is the authoritative subscription-usage source), and `web_search.result`/`web_fetch.result` (the `assistant` branch is the single results emitter — the assembler's result handler appends, so it must run once). **The SDK's actual message shape:** for one model turn it emits a `message_start`/`message_stop` pair of `stream_event`s wrapping the token deltas, PLUS a separate coalesced `assistant` message **per finished content block** (thinking, text, tool*use each arrive as their own `assistant`, interleaved with that block's partial deltas) — \_not* one batched `assistant` per Beta message. So the partial stream and the per-block `assistant` messages describe the same content twice. Reconciliation is a single per-turn flag, `partialsActive`, set on the first `stream_event`: once partials are streaming, every per-block `assistant` is **`fullContent` + metadata only** (no re-emit → no double-render or block-boundary corruption); the partial stream alone renders text/thinking live. The lone exception is `*_tool_result` blocks, which the partial stream never emits (filtered) — the `assistant` branch is their sole emitter, always. When the CLI never streams partials (older SDK / not honored), `partialsActive` stays false and the per-block `assistant` messages emit the old way (graceful degradation). `result.textContent` (`textBuf`) comes from the partial deltas when streaming, else from the coalesced blocks — one source, so it matches what the assembler rendered (incl. recovered partial text on a cut-off turn). _History note:_ an earlier per-message / per-content-kind FIFO "coverage queue" was wrong for this shape — `message_stop` lands after all the per-block `assistant` messages, so the queue was always empty when each `assistant` was processed (→ double-render) and the one entry it did push was consumed by the next Beta message's first block (off-by-one). The per-turn flag replaced it.
- **Empty-turn surfacing.** A claude-agent turn can close `subtype=success` / `stop=end_turn` while rendering nothing — the SDK swallows the real signal in places the result message doesn't echo. The client captures, per turn: the assistant `BetaMessage.stop_reason` (`pause_turn` / `refusal` / `max_tokens` / `model_context_window_exceeded`) — also read from the partial `message_delta.delta.stop_reason`; the assistant-level `error` (`rate_limit` / `max_output_tokens` / `server_error` / `billing_error` / `overloaded`); the latest `rate_limit_event.status` (`rejected` means the subscription quota was actually hit); and refusal `stop_details` (`{ category, explanation }`, from either the coalesced `BetaMessage` or the partial `message_delta`). **Refusals always error** — whenever `stop_reason === 'refusal'`, `result.error` is set to `claude-agent: refused — <explanation> (category: <cat>)` even if partial text streamed first (`finalizeWithError` keeps the streamed blocks + appends the error). The other triggers fire only when the turn produced no text and no thinking — one of `hardAssistantError` / `badStop` / `rate_limit rejected`, or it burned its budget on omitted thinking with no text, no tool call, and no distinguishing signal (`thinkingOnly`). This refusal-first → empty-turn decision is the pure, independently unit-tested `classifyTurnError(...)` helper (the caller applies it only when no `resultError` is already set, so a non-success `result` subtype still wins). A milder fallback runs first: when no text block was produced at all but the result message carried a `result` string, that text is adopted — guarded on `sawTextBlock` (not just an empty `textBuf`) so a turn with real text blocks never collapses into the flat result string. `rateLimitStatus` rides out on `providerExtra`. **Logging:** once-per-turn lifecycle lines plus the failure-explaining `rate_limit` / `api_retry` / `assistant stop_reason` / `assistant error` diagnostics use `console.debug` (always on); the chatty per-SDK-message / per-partial-event / coalesced-block traces and the prompt/options dumps route through a `dbg()` helper gated on `CLAUDE_AGENT_DEBUG=1`.

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
- Config built via `buildReasoningConfig(modelType, options)` — adaptive mode when `supportsAdaptiveReasoning && (onlyAdaptiveReasoning || !reasoningBudgetTokens)`
- Budget controlled via `reasoningBudgetTokens` (Claude), effort via `reasoningEffort` (Nova 2), adaptive via budget=0 on Claude 4.6+, always-adaptive on Claude 4.7+ (`onlyAdaptiveReasoning`)

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

| Component                | Per-API?    | Purpose                                                                               |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| `APIClient`              | Yes         | `anthropicClient`, `openaiClient`, `responsesClient`, `googleClient`, `bedrockClient` |
| `StreamMapper`           | Yes         | Converts SDK stream events to unified `StreamChunk` types                             |
| `FullContentAccumulator` | When needed | Builds `fullContent` from streaming chunks when SDK doesn't provide `finalMessage()`  |

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
- Static registration at startup: `registerAllTools()` called in `main.tsx` (main thread) and `src/backend/worker/gremlinWorker.ts` (worker thread). Both contexts have their own `toolRegistry` singleton, so both must register or the agentic loop sends an empty tools list to the model.
- Available tools: `memory`, `javascript`, `filesystem`, `sketchbook`, `checkpoint`
- Tool definitions sent to API via `getToolDefinitionsForAPI(apiType, enabledToolNames, toolOptions)`
- Execution via `executeClientSideTool(toolName, input, enabledToolNames, toolOptions, context)`
- `ClientSideTool` interface:
  - `displayName?: string` - Display name for UI (falls back to `name`)
  - `displaySubtitle?: string` - Description shown below toggle in ProjectSettings
  - `internal?: boolean` - Internal tools not shown in ProjectSettings UI (e.g., `return` for minions)
  - `complex?: boolean` - Complex tools run in a later phase after simple tools (e.g., `minion`)
  - `parallelThrottleMs?: number` - Stagger parallel launches of this tool; the Nth call in a throttle group starts N×throttleMs later (`minion`: 2000ms)
  - `getParallelThrottleGroup?(input, toolOptions, context)` - Resolve the throttle group for one call; same group → staggered, different groups → concurrent. Defaults to the tool name. `minion` returns `minion:<apiDefinitionId>` so parallel minions on different API definitions don't delay each other
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
  - `ToolOptionDefinition` is a discriminated union:
    - `BooleanToolOption`: `{ type: 'boolean'; id; label; subtitle?; default: boolean }`
    - `NumberToolOption`: `{ type: 'number'; id; label; subtitle?; default: number; min?; max? }`
    - `TextToolOption`: `{ type: 'text'; id; label; subtitle?; default: string; placeholder? }`
    - `LongtextToolOption`: `{ type: 'longtext'; id; label; subtitle?; default: string; placeholder? }`
    - `SelectToolOption`: `{ type: 'select'; id; label; subtitle?; default: string; choices; migrateFrom? }`
    - `ModelToolOption`: `{ type: 'model'; id; label; subtitle? }` (no default, prepopulated from project)
    - `ModelListToolOption`: `{ type: 'modellist'; id; label; subtitle? }` (initialized to `[]`)
  - All option types support `visibleWhen?: { optionId: string; value: ToolOptionValue | ToolOptionValue[] }` — conditional visibility based on sibling option value
  - Type guards: `isBooleanOption()`, `isNumberOption()`, `isTextOption()`, `isLongtextOption()`, `isSelectOption()`, `isModelOption()`, `isModelListOption()`, `isModelReference()`, `isModelReferenceArray()`
  - `initializeToolOptions(existing, optionDefs, projectContext)` - Initializes options with defaults, preserves existing values
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
  - **No Hand Holding option**: Skips the usage manual from system prompt injection, only emits file listing + README (for capable models that already know the tool)
- Agentic loop in `useChat.ts` handles `stop_reason: 'tool_use'`:
  1. Extract `tool_use` blocks from `fullContent`
  2. Execute client-side tools locally
  3. Build `tool_result` messages
  4. Save intermediate messages to storage + update UI state
  5. Send continuation request
  6. Loop until `stop_reason !== 'tool_use'` or max iterations (50)
- **Unresolved tool call recovery**: When a response ends with unresolved `tool_use` blocks (e.g., token limit reached mid-agentic-loop):
  1. `unresolvedToolCalls` detected via `getUnresolvedToolCalls()` in `useChat.ts`
  2. `PendingToolCallsBanner` shows in MessageList with Reject/Accept buttons
  3. User actions:
     - **Reject button**: Sends error "User rejected the tool call"
     - **Accept button**: Delegates tool execution to the agentic loop (`pendingToolUseBlocks`) for streamed execution with live status updates
     - **User sends message**: Sends reject response along with user's message
  4. ChatInput send button enabled even with empty input when pending tools exist
- Intermediate messages persisted with `renderingContent`:
  - Assistant messages with `tool_use` render in `BackstageView` as expandable "Calling [tool_name]" blocks
  - User messages with `tool_result` render via `ToolResultBubble` (detected by `content.toolResults` being set)

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
- Block types: `ThinkingRenderBlock`, `TextRenderBlock`, `WebSearchRenderBlock`, `WebFetchRenderBlock`, `ToolUseRenderBlock`, `ToolResultRenderBlock`, `ToolInfoRenderBlock` (with `displayName`, `apiDefinitionId`, `modelId`), `InjectedFileRenderBlock` (path, content, error flag), `ErrorRenderBlock`
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
- Old messages without `renderingContent` are rendered via `AssistantMessageBubble` which falls back to markdown rendering of the `content` field

**Component Structure:**

```
MessageList.tsx                    # Container with virtual scrolling
├── MessageBubble.tsx              # Container with virtual scrolling logic, delegates rendering
│   ├── UserMessageBubble.tsx      # User messages (blue bubble, attachments, edit/fork/copy/dump JSON)
│   ├── ToolResultBubble.tsx       # Tool result messages (role: USER with tool_result blocks, delete action)
│   ├── AssistantMessageBubble.tsx # Assistant messages (renderingContent or markdown fallback)
│   │   ├── BackstageView          # Collapsible thinking/search/fetch/tool_use/tool_result
│   │   ├── ErrorBlockView         # Collapsible error with stack trace
│   │   ├── TextGroupView          # Text with citations
│   │   └── StopReasonBadge        # Stop reason display
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

- `useVirtualScroll` hook with two IntersectionObservers (hysteresis bounce protection)
- **Two-observer hysteresis**: Outer observer (5 screens) virtualizes on exit, inner observer (4 screens) re-renders on entry. Messages between 4–5 screens keep their current state, preventing rapid toggling at the boundary. `initializedIdsRef` tracks first-detection to distinguish initial mount from re-entry.
- **Scroll container as root**: Observers use the scroll container element as `root` instead of viewport, ensuring accurate intersection detection in nested scroll contexts
- **Buffer calculation**: Uses pixel-based `rootMargin` (`containerHeight * bufferScreens`px) instead of percentages for reliable cross-browser behavior
- **Minimum buffer**: 600px minimum container height ensures reasonable buffer on small screens
- **Pending registration queue**: Handles race condition where ref callbacks fire before observers are ready
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
├── useVfsAdapter(projectId) → adapter (RemoteVfsAdapter or LocalVfsAdapter)
├── Header (back to project settings, title)
├── Desktop Layout (side-by-side via flex)
│   ├── VfsDirectoryTree (left panel ~40%, receives adapter)
│   └── Content panel (right ~60%): VfsFileViewer / VfsFileEditor / VfsDiffViewer (receive adapter)
└── Mobile Layout
    ├── VfsDirectoryTree (full width, receives adapter)
    └── VfsFileModal → VfsFileViewer / VfsFileEditor / VfsDiffViewer (receive adapter)
```

Features:

- **Directory tree**: Expand/collapse directories, lazy loading, file sizes
- **File viewer**: Read-only content display with version badge, binary file preview (images rendered, others show download button), MIME type badge
- **File editor**: Edit with draft persistence (`vfs-editor` place), auto-versioning on save (text files only)
- **Diff viewer**: Compare versions with LCS diff algorithm, rollback support, revision timestamps from `listVersions()`, context-only mode (±10 lines toggle via `filterDiffContext`)
- **Delete**: Soft-delete files and directories (recursive)
- **Download**: UTF-8 text files download as `.txt`, binary files download with original MIME type
- **Create**: Create empty text files and directories from directory panel
- **Upload**: Upload files with auto-detection (valid UTF-8 → text, otherwise → binary via magic bytes)
- **Download ZIP**: Download entire directory as ZIP archive (uses `fflate` library)
- **Upload ZIP**: Extract a ZIP archive into the selected directory (auto-strips common root prefix, handles text/binary detection per file)
- **Drop old versions**: For files with >10 versions, drop historical versions keeping last 10. After dropping, badge shows "v15 (10 stored)" to indicate actual stored version count differs from version number. Diff viewer respects minStoredVersion and shows "Oldest stored:" label when viewing the earliest available version.

**Unified Reasoning Section:**

The Reasoning section in Project Settings uses a unified design with a global "Enable Reasoning" toggle in the header. When enabled, all provider-specific reasoning options are shown in organized subsections:

- **Reasoning Effort** (shared): Applies to OpenAI/Nova directly; maps to Anthropic adaptive `output_config` when budget = 0
- **Anthropic / Bedrock Claude**: Budget Tokens (0 = adaptive on Opus 4.6/Sonnet 4.6) + Keep Thinking Turns + Prune thinking blocks before API call (client-side strip, gated by an explicit Keep Thinking Turns)
- **OpenAI / Bedrock Nova / DeepSeek**: Reasoning Summary

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
- `src/services/vfs/index.ts` - Barrel re-export (all callers import from here)
- `src/services/vfs/vfsFacade.ts` - Locked wrappers + compound operations (`appendFile`, `copyFile`, `deletePath`, `createFileGuarded`, `ensureDirAndWrite`)
- `src/services/vfs/vfsService.ts` - Unlocked VFS internals with tree structure and versioning

**Commands (Anthropic spec compliant):**

| Command       | Parameters                           | Description                                                                         |
| ------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `view`        | `path`, `view_range?`                | View directory listing (with file sizes) or file contents (with line numbers)       |
| `create`      | `path`, `file_text`, `overwrite?`    | Create new file (error if exists). `overwrite` replaces existing                    |
| `str_replace` | `path`, `old_str`, `new_str?`        | Replace unique string. Omitting `new_str` deletes matched text                      |
| `insert`      | `path`, `insert_line`, `insert_text` | Insert text at specific line (0-indexed)                                            |
| `delete`      | `path`                               | Delete file or directory (soft delete)                                              |
| `rename`      | `old_path`, `new_path`, `overwrite?` | Rename/move file. Errors if destination exists unless `overwrite: true`             |
| `mkdir`       | `path`                               | Create a new directory                                                              |
| `append`      | `path`, `file_text`                  | Append text (auto-adds trailing newline), or create file if not exists              |
| `append_raw`  | `path`, `file_text`                  | Append text verbatim (no trailing newline), or create file if not exists            |
| `view-all`    | `paths`                              | Batch read multiple files, returns concatenated content with `=== path ===` headers |

**VFS Architecture:**

- Root path: `/memories` (all paths normalized to this)
- Tree-structured filesystem stored in `vfs_meta` table (JSON tree per project)
- Files stored in `vfs_files` table with stable UUID (`fileId`) that survives renames
- Per-file versioning in `vfs_versions` table (auto-versioned on every update)
- Soft-delete with orphan tracking for displaced files during renames
- 999,999 line limit per file (returns error if exceeded)
- **Namespace isolation**: `VfsAdapter` instances are bound to a namespace at creation time. `LocalVfsAdapter(projectId, namespace)` resolves paths through the namespace (e.g., `/minions/coder` + `/memories/note.md` → `/minions/coder/memories/note.md`). `resolveNamespacedPath()` handles resolution with path traversal mitigation. Tool handlers receive a pre-bound adapter via `ToolContext.vfsAdapter`.
- **Cross-namespace mounts**: Two shared paths bypass namespace prefixing:
  - `/share` — read-only for namespaced callers (main agent has write access). Enforced via `assertWritable()` in VFS core, throws `VfsError('READONLY')`.
  - `/sharerw` — read-write for all, including namespaced callers. Enables minion-to-minion collaboration.
- **Mount root protection**: `/share` directory root cannot be deleted or renamed (throws `INVALID_PATH`). `/sharerw` has no root protection — the main agent can delete it if needed.
- **Concurrency control**: Facade layer (`vfsFacade.ts`) acquires a per-project promise chain (`treeLock.ts`) once per operation, including compound multi-step operations like `appendFile`, `copyFile`, `deletePath`. All callers import from `vfs/index.ts` barrel (never `vfsService` directly). `vfsService.ts` contains unlocked internal functions. Prevents lost-update race conditions and TOCTOU bugs.

**Storage Tables:**

- `vfs_meta`: Tree structure + orphans per project
- `vfs_files`: Current file content (parentId = projectId)
- `vfs_versions`: Historical snapshots (parentId = fileId)
- VFS data cleaned up automatically when project is deleted
- **Compact Project**: Accessible from project gear dropdown (🗜️). Purges soft-deleted nodes and orphans older than 1 week, then prunes historical revisions using tiered retention: all <24h, hourly 24h–3d, daily 3d–30d, weekly 30d–1yr, discard >1yr. Renumbers remaining revisions sequentially. Done screen shows cleanup results plus post-compact summary (tree nodes, files, revisions).

**Instance Management:**

- `memoryTool` - Static tool definition exported from `memoryTool.ts`
- Tools registered via `registerAllTools()` at app startup — once in `main.tsx` (main thread) and once in `src/backend/worker/gremlinWorker.ts` (worker thread)
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

| Command       | Parameters                           | Description                                                                         |
| ------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `view`        | `path`, `view_range?`                | View directory listing, text file (with line numbers), or dataUrl                   |
| `create`      | `path`, `file_text`, `overwrite?`    | Create new file (accepts text or dataUrl for binary). `overwrite` replaces existing |
| `str_replace` | `path`, `old_str`, `new_str?`        | Replace unique string (text files only). Omitting `new_str` deletes matched text    |
| `insert`      | `path`, `insert_line`, `insert_text` | Insert text at specific line (text files only)                                      |
| `delete`      | `path`                               | Delete file or directory (soft delete)                                              |
| `rename`      | `old_path`, `new_path`, `overwrite?` | Rename/move file. Errors if destination exists unless `overwrite: true`             |
| `mkdir`       | `path`                               | Create a new directory                                                              |
| `append`      | `path`, `file_text`                  | Append text (auto-adds trailing newline), or create file if not exists              |
| `append_raw`  | `path`, `file_text`                  | Append text verbatim (no trailing newline), or create file if not exists            |
| `view-all`    | `paths`                              | Batch read multiple files, returns concatenated content with `=== path ===` headers |

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

- **Event Loop**: microtasks drained via `executePendingJobs(1)` per tick (with host yields), then host-scheduled timers fired
- **Timeout**: 300s execution limit via `setInterruptHandler()` (kills infinite loops mid-execution); also caps total real timer sleep
- **Console Capture**: All console methods (log, warn, error, info, debug) captured

**Event Loop Semantics:**

1. User code evaluates synchronously
2. While there are pending jobs, fs ops, or scheduled timers:
   - Check 300s timeout deadline
   - Drain pending fs operations
   - If a microtask is pending: yield to host (`setTimeout(0)`), run one with `executePendingJobs(1)`, loop
   - Else sleep (via the host's real `setTimeout`) until the earliest timer is due, then fire every due timer in `(wakeAt, insertion)` order
3. Microtasks always fully drain before any timer fires (real event-loop ordering)
4. `setTimeout`/`setInterval` register host-side timers honoring the real delay; the drain loop owns the registry (`clearTimeout`/`clearInterval` remove entries)

**Polyfills (injected into every context):**

| API                       | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `self`                    | Points to `globalThis` (UMD/IIFE library compatibility) |
| `setTimeout(cb, delay?)`  | Schedules a host-side timer honoring the real delay     |
| `clearTimeout(id)`        | Cancels a pending timer                                 |
| `setInterval(cb, delay?)` | Fires once (no repeat) but honors the delay, returns ID |
| `clearInterval(id)`       | Same as clearTimeout                                    |
| `TextEncoder`             | UTF-8 string to bytes                                   |
| `TextDecoder`             | UTF-8 bytes to string                                   |
| `btoa(str)`               | Base64 encode                                           |
| `atob(str)`               | Base64 decode                                           |
| `halt(message)`           | Immediately stop execution, preserve logs before halt   |
| `fs` / `__fs`             | VFS filesystem API (see below)                          |

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

**Library Preloading (`/share/lib` and `/lib`):**

Each tool call loads `.js` files from two directories (when enabled):

1. `/share/lib` — shared across VFS namespaces, loaded first (controlled by `loadShareLib` option)
2. `/lib` — per-project, loaded second (controlled by `loadLib` option)

Both follow the same loading behavior:

- Lists all `.js` files, sorts alphabetically for deterministic order
- Executes each script with the filename parameter for proper stack traces
- Headers like `=== Output of library X.js ===` are omitted for libraries with no output
- Use for: loading utility libraries (lodash, date-fns UMD builds), custom helpers, polyfills
- Errors logged to console but don't prevent tool execution

Library output is always shown (no first-call tracking).

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

| Parameter               | Type               | Required             | Description                                                                                                              |
| ----------------------- | ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `action`                | string             | No                   | `'message'` (default) or `'retry'`. Retry rolls back to savepoint and re-executes.                                       |
| `message`               | string             | For `message` action | Task to send to minion. For `retry`: omit to re-send original, or provide replacement.                                   |
| `minionChatId`          | string             | For `retry` action   | Existing minion chat ID to continue or retry                                                                             |
| `enableWeb`             | boolean            | No                   | Enable web search for minion (only exposed when `allowWebSearch` option is true)                                         |
| `enabledTools`          | string[]           | No                   | Tools for minion (validated against project tools, defaults to none)                                                     |
| `persona`               | string             | No                   | Persona name (matches `/minions/<name>.md`). Only when `namespacedMinion` is not `off`.                                  |
| `model`                 | string             | No                   | Model to use (`apiDefId:modelId`). Only when `namespacedMinion` is not `off` + `models` configured.                      |
| `displayName`           | string             | No                   | Display name shown in the UI for this minion call. If omitted, persona name is used.                                     |
| `injectFiles`           | string[]           | No                   | VFS file paths to inject as context. Injection method controlled by `fileInjectionMode` option.                          |
| `verifyHook`            | string             | No                   | Hook file name (without `.js`) in `/hooks/` to verify minion output before savepoint advances.                           |
| `enableReasoning`       | boolean            | No                   | Override reasoning on/off for this call                                                                                  |
| `reasoningBudgetTokens` | number             | No                   | Override reasoning budget. 0 = adaptive on supported models.                                                             |
| `reasoningEffort`       | string             | No                   | Override reasoning effort (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`)                                               |
| `temperature`           | number             | No                   | Override temperature for this call                                                                                       |
| `maxOutputTokens`       | number             | No                   | Override max output tokens for this call (default: project setting). Persists on the minion chat for follow-up calls.    |
| `fileInjectionMode`     | string             | No                   | Override file injection mode (`inline`/`separate-block`/`as-file`/`mock-tool-call`)                                      |
| `systemPrompt`          | string             | No                   | Additional system prompt text, appended after persona/configured prompt                                                  |
| `systemPromptFile`      | string \| string[] | No                   | VFS file path(s) to system prompt file(s). Single string or array; contents appended after `systemPrompt` in order.      |
| `nudgeThinking`         | string             | No                   | Text appended to last user message to nudge CoT. Empty string disables. Persists on the minion chat for follow-up calls. |

**Adding a new minion override parameter — checklist:**

Use this when adding another per-call override that the LLM can set on a minion (the `nudgeThinking` PR followed this exact path). Parameters on `MinionInput` should persist across calls (so the LLM can set once and continue without re-passing) and follow a 3-layer precedence: **current-call input → persisted `MinionChat` value → provider/project default**.

1. **`src/shared/services/agentic/agenticLoopGenerator.ts`** — add the field to `AgenticLoopOptions` (the flat loop config), and forward it into the `streamOptions` object at the `sendMessageStream` call site.
2. **`src/shared/services/api/apiService.ts`** — add the field to the `sendMessageStream` options parameter type and consume it where needed.
3. **`src/shared/engine/buildLoopOptions.ts`** — resolve the provider/project default into the returned `AgenticLoopOptions` inside `buildAgenticLoopOptionsForContext`.
4. **`src/shared/protocol/types/index.ts`** — add the field to `MinionChat` (optional) so the value persists across calls for continuation.
5. **`src/shared/services/tools/minionTool.ts`** — five touchpoints in this file:
   - `MinionInput` interface — add the typed field with a short JSDoc.
   - `getMinionInputSchema()` — add the JSON Schema property and description surfaced to the LLM.
   - Continuation merge block (`if (minionInput.minionChatId) { ... }`) — persist `minionInput.X` onto the existing `minionChat.X` when the caller supplies it.
   - New-chat creation block (`minionChat = { ... }`) — seed `minionChat.X` from `minionInput.X`.
   - Loop-options builder — use 3-layer precedence (`input ?? minionChat ?? providerDefault`). For `string`-typed fields, use `typeof x === 'string'` so `""` explicitly disables instead of cascading down.
   - `renderMinionInput()` — emit a line so the tool call display shows the override (users need to see what the LLM asked for).
6. **Tests** — add unit test coverage for the loop-options resolution and, if the field has non-trivial semantics (e.g., empty-string-as-off), add a case for that. Update any `MinionChat` fixtures if needed (the field is optional so most should be unaffected).
7. **`development.md`** — add a row to the Input Parameters table above.

**Tool Options:**

- `systemPrompt` (longtext) - Instructions for minion sub-agents
- `model` (ModelReference) - Model for delegated tasks (can use cheaper model)
- `models` (ModelReference[]) - Models the LLM can choose from when calling minions. When non-empty and `namespacedMinion` is not `off`, adds `model` input parameter with enum of `apiDefId:modelId` strings. LLM omitting `model` falls back to default `model` option.
- `allowWebSearch` (boolean, default: false) - Project-level gate for minion web search. Must be enabled for `enableWeb` to work. When disabled, `enableWeb` parameter and web search mention are omitted from the schema/description sent to the LLM.
- `returnMode` (select: `no-return`/`both`/`return-only`/`enforced`/`auto-enforced`, default: `both`) - Controls return tool behavior and output format. Migrates from legacy `noReturnTool` and `returnOnly` booleans.
  - `no-return` — Remove return tool from minion toolset
  - `both` — Return tool available + text capture. Result as JSON `{ text, stopReason, hasCoT, minionChatId, result? }`
  - `return-only` — Only return value captured; text suppressed when return tool used. Falls back to text if return not called.
  - `enforced` — Return must be called; warning if not
  - `auto-enforced` — Like `enforced` but auto-retries up to `AUTO_ENFORCE_MAX_RETRIES` (2) times with a reminder message before giving up
  - Non-`both` modes use simplified format: `<minionChatId>id</minionChatId>\n[<hasCoT />]\ncontent` (`<hasCoT />` self-closing tag present only when true)
- `disableReasoning` (boolean, default: false) - Turn off reasoning/thinking for minion calls regardless of project settings
- `deferReturn` (boolean, default: false, visibleWhen returnMode != no-return) - Return tool stores result without breaking the agentic loop. The loop continues until natural completion, then returns the stored value. Multiple calls overwrite (last wins). Sets `deferReturn` on `AgenticLoopOptions` and injects it into the return tool's options so its description reflects the mode.
- `deferredSoftStopRounds` (number, default: 5, visibleWhen deferReturn) - Rounds after deferred return before injecting stop messages
- `deferredForceStopRounds` (number, default: 10, visibleWhen deferReturn) - Rounds after deferred return before force-stopping the loop
- `returnAckMessage` (text, visibleWhen deferReturn) - Message sent when deferred return stores a result
- `returnDuplicateMessage` (text, visibleWhen deferReturn) - Error sent when return is called again after a result is stored
- `returnEnforceMessage` (text, visibleWhen returnMode=auto-enforced) - Message sent when auto-enforced mode retries because return was not called
- `fileInjectionMode` (select: `inline`/`separate-block`/`as-file`/`mock-tool-call`, default: `inline`) - How injected files are sent to the minion LLM. `inline` prepends file text into the message string. `separate-block` sends each file as a separate text content block. `as-file` uses native document/file blocks. `mock-tool-call` inserts synthetic assistant tool_use + user tool_result message pairs (filesystem readFile) — works with all API types.
- `namespacedMinion` (select: `off`/`persona`/`all`, default: `off`) - Controls persona and VFS namespace behavior. Migrates from legacy boolean (`true` → `all`).
  - `off` — No persona parameter, no namespace. Minions use configured system prompt.
  - `persona` — Persona parameter available. Only minions called with an explicit non-default persona get VFS namespace (`/minions/<persona>/`) and persona prompts. Default/no-persona minions behave like `off` (root VFS, configured system prompt, no `_global.md`).
  - `all` — Everyone namespaced. Default persona maps to `/minions/default/`, reads `_global.md`.

**Persona System (namespacedMinion `persona` or `all`):**

When `namespacedMinion` is not `off`, `persona` input parameter and system prompt injection are enabled:

- Persona files stored at `/minions/<name>.md` in root VFS. Content becomes the minion's system prompt.
- `/minions/_global.md` (optional) — content prepended to the system prompt for namespaced personas. Read from root VFS before persona-specific prompt.
- `persona` input parameter selects a persona (omit for `default`). Namespaced personas map to namespace `/minions/<persona>`.
- In `persona` mode, default/no-persona minions stay in root VFS with no namespace and no `_global.md`.
- Namespace flows through the agentic loop: `AgenticLoopOptions.namespace` → `ToolContext.vfsAdapter` (pre-bound adapter) → all VFS calls in memory, filesystem, JavaScript, sketchbook, and DUMMY tools. `ToolContext.createVfsAdapter` factory lets minion tool create adapters for other namespaces.
- A persona's `/memories/README.md` resolves to `/minions/<persona>/memories/README.md` in VFS storage.
- `/share` paths bypass namespace prefixing — read-only for namespaced minions (main agent writes, minions read).
- `/sharerw` paths bypass namespace prefixing — read-write for all, enables minion-to-minion collaboration.
- System prompt injection lists available personas from `/minions/*.md` with their first lines.

**Tool Scoping:**

Minion's available tools are computed as: `(requestedTools ∩ projectTools) - minion + return`

- Defaults to `['return']` when `enabledTools` is omitted on first call (caller must explicitly grant tools). On continuation, stored `enabledTools` are used as fallback when not re-specified.
- Can't spawn nested minions (self-exclusion)
- `return` tool available unless `returnMode` is `no-return`
- Requested tools validated against project tools — error returned if any tool is not available
- Uses intersection with project tools (can't access tools not enabled for project)

**MinionChat Storage:**

Minion conversations stored separately for debugging visibility:

- `getMinionChat(id)` / `getMinionChats(parentChatId)` / `saveMinionChat()`
- `getMinionMessages(minionChatId)` / `saveMinionMessage()` / `deleteSingleMessage(messageId)`
- Cascade deletion when parent chat is deleted
- `savepoint?: string` field stores last message ID of the last successful run (for rollback). New chats start with `SAVEPOINT_START` sentinel (`'_start'`). Savepoint advances only after successful execution, never before. On retry, `rollbackToSavepoint()` helper handles message slicing, content stashing (including `renderingContent` for file bars), token subtraction, and message deletion. Three-state semantics: `undefined` = legacy chat (no rollback), `SAVEPOINT_START` = new chat (rollback = delete all), `'msg_xxx'` = normal (rollback = delete after).
- `autoRollback` tool option: when enabled, `action` is hidden from schema and on continuation the system auto-detects messages after savepoint and rolls them back before proceeding. When disabled (default), explicit `action: 'retry'` is available.
- Persisted settings: `displayName`, `persona`, `apiDefinitionId`, `modelId`, `enabledTools`, `verifyHook` — stored on creation and updated on continuation. Enables stored-model and stored-tools fallback when continuing without re-specifying them.

**Result Handling:**

- Result content depends on return mode:
  - `both` mode: JSON `{ text, stopReason, minionChatId, result? }` — `text` is concatenated assistant text, `result` only present when return tool was used
  - All other modes: simplified `<minionChatId>id</minionChatId>\ncontent` — content is return value, warning, or text depending on mode
  - `renderMinionOutput()` handles both formats for UI display (backward-compatible with legacy JSON)
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

1. **Phase 1** (load + savepoint): Validate inputs, load/create chat, retry rollback. Errors append "Resend to reattempt." — no meaningful state change occurred.
2. **Phase 2** (validation): Check web search, model, project, API def, tools. Errors append "Resend to reattempt." — savepoint is unchanged, no user message yet.
3. **Phase 3** (execution): Check pendingReturnToolUse, build/save user message, run agentic loop. Errors here can be retried via `action: 'retry'`.

All error `content` is passed through `truncateError()` (200 char limit + `...`) to avoid wasting parent LLM context tokens on long error messages (model lists, stack traces, etc.).

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
- Injected files shown as collapsible bars below user message bubble in minion chat (via `InjectedFileRenderBlock` blocks) and between blue input box and activity groups in tool result view (via `ToolInfoRenderBlock.injectedFiles`)
- Activity groups (backstage/text) rendered with `isToolGenerated` styling
- "View Chat" button opens overlay over ChatView and closes the tool result modal (when `chatId` present and `MinionChatOverlayContext` provided), "Copy JSON" for debugging
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
- **Mode-aware description**: Description sent to the model varies by `returnMode` (injected by minionTool). `enforced`/`auto-enforced` → "MUST call", `return-only` → "preferred way", `both` → standard. `deferReturn` takes priority.
- **Deferred mode** (`deferReturn` option on minion tool): Return tool stores the value without breaking the loop. The agentic loop replies with configurable ack message and continues until natural completion. Works both solo and in parallel with other tools. Duplicate deferred calls are rejected with configurable error. Two-phase wind-down with configurable thresholds (all via minion tool options).

### Checkpoint Tool

Client-side tool that marks progress during long agentic loops. When the AI calls checkpoint, a flag propagates through the agentic loop. After the turn ends naturally (end_turn/max_tokens), the consumer auto-sends a continue message, starting a fresh API call where old thinking blocks get trimmed by `thinkingKeepTurns`.

- `checkpointTool` in `src/services/tools/checkpointTool.ts`
- `internal: false` — visible in ProjectSettings, must be explicitly enabled
- Input: `{ note: string }` — progress summary that stays in conversation history
- Returns `{ content, checkpoint: true }` — no `breakLoop`, loop continues normally
- Tool options:
  - `keepSegments` (number, default: `0`) — how many previous checkpoint segments to preserve (-1 = keep all / disable tidy, 0 = tidy all before latest)
  - `continueMessage` (longtext, default: `"please continue"`)
  - `tidyFilesystem` / `tidyMemory` / `tidyJavascript` / `tidyMinion` / `tidySketchbook` / `tidyCheckpoint` (boolean, all default `true`) — which tool blocks to remove from pre-checkpoint context
- `iconInput: '📍'`, `iconOutput: '✅'`
- **Gating**: Context tidy only runs when the checkpoint tool is enabled. `useChat.ts` passes `checkpointMessageIds` only if `enabledTools.includes('checkpoint')`. Old persisted `chat.checkpointMessageId` won't cause unintended trimming when the tool is disabled.

**Checkpoint flow:**

```
AI calls checkpoint(note) → tool returns with checkpoint: true → flag propagates
    → loop continues → AI finishes turn naturally (end_turn/max_tokens)
    → main loop detects checkpointSet → yields checkpoint_set event with assistant message ID
    → creates user message with continueMessage → re-enters while loop for fresh API call
    → context tidy trims old thinking + tool blocks → AI sees note and continues
```

**Flag propagation** (`agenticLoopGenerator.ts`):

- `executeToolsParallel` → `executeToolUseBlocks` → main loop's `checkpointSet` variable
- `checkpoint_set` event yielded immediately when checkpoint is recorded (not deferred to auto-continue), ensuring IDs are persisted regardless of how the loop exits (DUMMY user-stop, soft stop, etc.)
- Auto-continue handled inside `runAgenticLoop`: when `checkpointSet && stopReason !== 'tool_use'`, creates a continue user message, yields it, resets flag, and `continue`s the loop
- Continue text read from `toolOptions.checkpoint?.continueMessage` (falls back to `'please continue'`)
- Local `checkpointMessageIds` array tracks all checkpoint IDs within the generator loop — pushed when `checkpointSet = true` (points to assistant messages containing checkpoint tool_use). The tidy boundary is computed from this array using `keepSegments`
- Consumer (`useChat.ts`) handles `checkpoint_set` event by accumulating IDs to `checkpointMessageIds` on the `Chat` object

**Checkpoint segments & keepSegments:**

- `Chat.checkpointMessageIds: string[]` — accumulated array of all checkpoint assistant message IDs
- `Chat.checkpointMessageId?: string` — legacy single-ID field, migrated to array on read
- Tidy boundary computed as `checkpointMessageIds[max(0, length - 1 - keepSegments)]`
- `keepSegments=-1`: disable tidy entirely (keep all segments, auto-continue still works)
- `keepSegments=0` (default): tidy boundary = latest checkpoint (original behavior)
- `keepSegments=1`: preserve one previous segment as reference
- `keepSegments > count`: boundary clamps to first checkpoint

**Message Tidy** (`src/services/api/contextTidy.ts` + per-client `tidyMessages()`):

Each API client owns a `tidyMessages()` function that combines three concerns in a single forward pass:

1. **Checkpoint filtering**: when `checkpointMessageId` is set, messages older than the checkpoint get thinking blocks removed and tool blocks (`tool_use` + matching `tool_result`) stripped per tidy option toggles. The checkpoint message itself: only thinking removed, tool blocks preserved.
2. **Thinking pruning** (two paths, OR-combined):
   - Per-definition `advancedSettings.pruneThinking`: strips thinking/reasoning blocks from messages before the last text user message (effectively keep 1 turn).
   - Per-project `pruneThinkingBeforeApiCall` (requires an explicit `thinkingKeepTurns` ≥ 0): strips thinking blocks before the N-th-from-last user text message, where N = `thinkingKeepTurns`. Generalizes the legacy single-turn behavior. Overridable per minion call via `thinkingKeepTurns` + `pruneThinkingBeforeApiCall` input args, with three-level fallback (minion input → minion chat → project) and persisted on `MinionChat`. The boundary helper lives in `contextTidy.findThinkingBoundaryN`.
   - Messages in the current agentic loop (after the boundary) keep their thinking. Google: also strips `thoughtSignature` from remaining parts.
3. **Empty text pruning** (per-definition `advancedSettings.pruneEmptyText`): removes empty/whitespace text blocks from messages before the last text user message.
4. **Genuine Anthropic enforcement** (per-definition `advancedSettings.enforceGenuineAnthropic`): post-response validation in `anthropicClient.ts` via `validateAnthropicResponse()`. Checks: (a) if input_tokens > 4096 and both cache_creation/read are zero → not genuine Anthropic; (b) if thinking blocks exist but lack cryptographic `signature` field → not genuine Anthropic. Both checks throw, caught by existing error handler.
5. **Nudge thinking**: the provider-level toggle `advancedSettings.nudgeThinking` (boolean) is resolved into an `AgenticLoopOptions.nudgeThinking: string` at loop-build time (`buildLoopOptions.ts`) — on → `NUDGE_THINKING_DEFAULT`, off → `undefined`. The loop forwards it into `sendMessageStream()` which calls `applyNudgeThinking()` to shallow-clone the last user message and append `\n\n<nudge>` to its text content. Send-time only — stored messages are untouched. `minionTool` exposes a `nudgeThinking` input parameter that overrides the resolved text (empty string = explicitly off), so the parent LLM can experiment with different nudge phrasings without a UI.
6. **Mandate CoT** (per-definition `advancedSettings.mandateCoT`): per-run check in `agenticLoopGenerator.ts`. Tracks `loopHasCoT` across all iterations (unified: `hasCoT` or `reasoningTokens > 0`). At run completion, rejects if no iteration produced chain-of-thought. Allows runs where CoT appears in one response but not others. Returns an error status that triggers minion savepoint rollback on retry.
7. **Treat empty output as error** (per-definition `advancedSettings.treatEmptyOutputAsError`): rejects turns producing whitespace-only text and no tool calls — catches degenerate responses from unreliable providers.
8. **Stream accumulator** (per-definition `advancedSettings.useStreamAccumulator`, Responses API only): in `responsesClient.ts` streaming path, builds the `StreamResult` from `ResponsesStreamAccumulator` (`responsesStreamAccumulator.ts`) instead of `stream.finalResponse()`. Some third-party Responses API providers stream events but return an empty `Response.output` from the SDK's final response — text and tool blocks render to the user but `result.textContent` and `result.fullContent` are empty, breaking minion text capture and tool extraction. The accumulator consumes the same events the mapper does, keying items by `output_index` and replacing with the complete item on `response.output_item.done`. Tolerant to out-of-order events: deltas referencing unknown indices are silently dropped. Default off — enable per-provider in Settings → Advanced.

Messages with mismatched `modelFamily` or missing `fullContent` are handled via shared helpers in `contextTidy.ts` (`findCheckpointIndex`, `findThinkingBoundary`, `tidyAgnosticMessage`).

- Tool name derivation: `deriveTidyToolNames()` maps checkpoint option IDs to tool names, defaulting to true (tidy enabled). Also checks legacy `swipe*` keys for backward compatibility with persisted data
- **Cache breakpoint layout (4-slot budget)**: Anthropic allows 4 `cache_control` breakpoints per request. The client places them as follows: (1) system prompt; (2) **anchor** — message before the checkpoint boundary, only when `checkpointMessageId` is set; (3) **previous real user message** — via `findPreviousUserMessageIdx`, skips `tool_result`-bearing user messages so the marker lands on the user-turn before the latest one; (4) **conditional tail** — when `options.nudgeThinking` is truthy, the last assistant message (via `findLastAssistantMessageIdx`) because `applyNudgeThinking` mutates the latest user message; otherwise the standard sliding tail via `applyCacheBreakpoints`. All tail placements use `startIdx = anchorEndIdx` so the stable prefix stays free of shifting markers — Anthropic's cache hash is cumulative over `cache_control`, so markers moving between calls would cause hash mismatches.
- **thinkingKeepTurns interaction**: API-level `context_management` with `clear_thinking` / `thinking_turns` strips thinking server-side. Between consecutive calls, new assistant turns cause the server to strip more old thinking, changing the effective cached prefix. When using checkpoint, configure `thinkingKeepTurns = -1` (keep all) so thinking is fully managed client-side by `tidyMessages()`.

### Metadata Tool

Gives the LLM control over chat-level metadata via `src/services/tools/metadataTool.ts`.

- `set_chat_title(title)` — rename the current chat
- `set_chat_summary(summary)` — set/clear summary (stored as `Chat.summary`)
- `list_recent_chats(count?)` — list titles and summaries of recent chats in current project

**Signal flow**: `set_chat_title`/`set_chat_summary` return `chatMetadata` in `ToolResult` → `executeToolsParallel` accumulates → `executeToolsPhased` yields `chat_metadata_updated` event → `consumeAgenticLoop` merges into `currentChat`, saves, and updates React state.

### DUMMY System (Dynamic Un-inferencing Mock-Message Yielding System)

LLM-registered JS hooks that intercept the agentic loop before each model API call. A hook can short-circuit with a synthetic response, hand control to the user, or pass through to the real API.

**Tool (`src/services/tools/dummyTool.ts`):**

- `register(name)` — verifies `/hooks/<name>.js` on VFS, returns `activeHook` signal on `ToolResult` (propagates through agentic loop pipeline → `active_hook_changed` event → React state + storage)
- `unregister` — returns `activeHook: null` signal (same pipeline, disposes runtime mid-loop)
- `template` — generates `/hooks/example.js` and `/hooks/hook-chain.example.js`
- `optionDefinitions`: `hookContextDepth` (number, 0–50, default 0) — controls how many previous messages are included in hook input's `history` array
- System prompt documents hook signature, return types, and template command

**Hook Runtime (`src/services/agentic/dummyHookRuntime.ts`):**

- Loads hook from VFS `/hooks/<name>.js`, evaluates in QuickJS sandbox (no lib injection)
- Hook function signature: `function(lastMessage, iteration)` where `lastMessage` (`HookInput`) has `chatId?`, `messageId?`, `text?`, `toolResults?`, and `history?` fields
- `history` is a sliding window of condensed previous messages (`HookInputMessage[]`), controlled by the `hookContextDepth` tool option (default 0 = no history)
- Each `HookInputMessage` includes `id`, `role`, `text?`, `toolCalls?` (with `id`/`name`/`input`), `toolResults?` (with `tool_use_id`/`name`/`content`) — stripped of rendering/metadata/attachments
- Returns `undefined` (passthrough), `"user"` (stop loop), or `{ text, toolCalls?, brief? }` (synthetic response)
- Error in hook → synthetic error message, loop completes (shared no-tools path)

**Model-Agnostic Tool Call Storage:**

`MessageContent` carries `toolCalls?: ToolUseBlock[]` and `toolResults?: ToolResultBlock[]` alongside provider-specific `fullContent`. Tool result messages are built directly at call sites (no `buildToolResultMessage` on API clients) — they set `content.toolResults` as the primary payload with `modelFamily` for routing. Each API client's `convertMessages` reads `toolResults` for new messages and `fullContent` for legacy stored chats. `ToolResultBlock` includes `name?: string` so providers like Google can set `functionResponse.name` without lookups.

**Rendering:**

- Synthetic messages use `modelFamily: 'ds01-dummy-system'`, zero tokens
- Synthetic messages show a small green label line (`text-xs text-green-700`) with brief text. Green `●` dot (`text-green-600`) in info bar when hook active
- Status line in MessageList shows hook state during loading: "Hooked: <name>" (gray), "Intercepting (<name>)" (green), "Hook error: <msg>" (red)
- Events carry `hookName` and optional `error`; `useChat` tracks `DummyHookStatus` state

**Error handling:**

- Hook errors (runtime exceptions, unexpected return types) produce a synthetic error message; the shared no-tools path returns `complete`
- The error message surfaces in the status line so the user knows something went wrong

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
- `extractHookHistory(messages, depth)` - Build condensed history window for hook input
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
  | { status: 'max_iterations'; messages; tokens }
  | {
      status: 'soft_stopped';
      stopPoint: 'before_tools' | 'after_tools';
      messages;
      tokens;
      returnValue?;
    };
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

- Unified loop handles all cases (normal send, continue, stop, soft stop)
- Soft stop: `shouldStop` callback on `AgenticLoopOptions` checked at two tool boundaries (before execution, after execution). Returns `soft_stopped` with `stopPoint`. `before_tools` leaves tool_use blocks unexecuted (existing `unresolvedToolCalls` handles resumption). `after_tools` has tool results persisted — `continueAfterToolStop()` starts a new loop.
- Automatic tool execution and continuation
- JS tool configuration at loop start (project context, library log reset)
- Cost/token accumulation across iterations
- Read-only storage access (reads attachments, consumer handles persistence)
- Error handling with cleanup
- Empty response detection: API client returns `result.error` for empty choices (non-streaming) or empty stream (no content, no tool calls, no finish reason). The loop checks `result.error` → returns `status: 'error'`. Minion tool has a final guard: if zero assistant messages were produced, returns `isError: true`.

**Tool Execution Helper:**

`executeToolUseBlocks()` is an extracted async generator that handles tool execution with full streaming support (pending → running → streaming updates → complete). Used via `yield*` from two call sites:

1. Pre-loop: executing `pendingToolUseBlocks` before the first API call
2. In-loop: after `stop_reason === 'tool_use'`

**Phased tool execution:** Tools are classified as simple or complex via `ClientSideTool.complex` flag (currently only `minion` is complex). When both types appear in a single response, simple tools run first (phase 1), then complex tools (phase 2). Within each phase, tools run in parallel via `executeToolsParallel()` with `Promise.race` multiplexing. Results are merged in original tool order.

**Return tool error handling:** If the `return` tool appears alongside other tools (`length > 1`): in **deferred mode** (`deferReturn: true`), the return tool executes and stores its value while other tools also run normally — the loop continues with the stored value. In **non-deferred mode**, it receives an error result (`"ERROR: return cannot be called in parallel..."`) and the other tools execute normally; the loop continues so the LLM can retry. When `return` is the only tool, it executes normally — breakLoop (non-deferred) or store-and-continue (deferred) is honored.

**Pending Tool Resolution (`AgenticLoopOptions`):**

- `pendingToolUseBlocks?: ToolUseBlock[]` — pre-existing tool_use blocks to execute before the first API call (used by `resolvePendingToolCalls` continue mode)
- `pendingTrailingContext?: Message<unknown>[]` — already-saved messages injected after tool results (e.g., user follow-up message)
- `deferReturn?: boolean` — when true, the return tool stores its value without breaking the loop. The stored value is delivered as `returnValue` when the loop ends naturally. Duplicate deferred returns are rejected (first value wins). Works both solo and in parallel with other tools. Two-phase wind-down prevents runaway loops: soft stop messages injected at configurable rounds after capture, force stop at configurable round.
- `deferredSoftStopRounds?: number` — rounds after deferred return before injecting stop messages (default: 5). Configurable via project settings advanced section.
- `deferredForceStopRounds?: number` — rounds after deferred return before force-stopping the loop (default: 10). Set to 0 for immediate hard-stop at tool result boundary.
- `returnAckMessage?: string` — message sent to the model when deferred return stores a result (default: "Recorded. Stop and user will call you back."). Configurable via project settings advanced section.
- `returnDuplicateMessage?: string` — error sent when deferred return is called again after a result is already stored (default: "The previous return has been recorded already. Please stop and user will call back."). Configurable via project settings advanced section.
- `fallbackToolExtraction?: boolean` — when true, extract tool_use blocks from response content even when `stopReason !== 'tool_use'`. Handles third-party APIs that return wrong stopReason. Enabled by default in minion loops. Main loop left unchanged (user handles via "resolve pending tool call" UI).

**`breakLoop` and `storedReturnValue` priority:** When a deferred return has already been captured (`storedReturnValue` is set), any subsequent `breakLoop` exit uses `storedReturnValue` instead of `breakLoop.returnValue`. This prevents a duplicate return (bypassing the duplicate check due to API quirks) from overriding the first captured value.

**Integration with useChat.ts:**

Chat loop state is managed by a single `loopPhase` enum (`'idle' | 'pending' | 'streaming'`). `isLoading` and `showContinueBanner` are derived. `pending` = user action triggered, async prep in progress; `streaming` = receiving chunks. All entry points (`sendMessage`, `resolvePendingToolCalls`, `resendFromMessage`, `continueAfterToolStop`, pending state on load) set `pending` before async work and `idle` after `consumeAgenticLoop` returns (via `try/finally`). The `first_chunk` event transitions `pending → streaming`. The continue banner is derived: `loopPhase === 'idle' && lastMessage is tool_result`.

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
- **Server (WebSocket)**: Node backend over WebSocket, SQLite + filesystem VFS

**Initialization Modes:**

- **Start Fresh**: Generate new CEK via dormant-callable `generateNewCEK` RPC, initialize storage, create default API definitions
- **Import from Backup**: User provides CSV backup file + source CEK, validates via `normalizeCEK` RPC, performs migration import
- **Use Existing Data** (remote/server): Connect to storage with existing CEK, verifies by decrypting one record

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
- **Root container** (`App.tsx`) uses `safe-area-inset-x` for left/right padding plus `bg-white` as the always-on baseline for the notch area
- **Mobile sidebar overlay** (`App.tsx`) uses `pt-[env(safe-area-inset-top)]` on its fixed wrapper so the gray sidebar bg starts BELOW the notch (body white shows through). It also fully unmounts after the slide-out transition (`onTransitionEnd` checking `e.propertyName === 'transform'`) — not just `translateX` off-screen — because iOS Safari's notch tinting samples the top-edge color and can stick after transform-only changes.

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

### OOBE hang on IndexedDB fresh start (fixed)

`WorkerTransport.request()` blocked every non-`init` RPC on `initPromise`, but Phase 1's dormant-callable design means OOBE calls `generateNewCEK` / `normalizeCEK` / `deriveUserIdFromCEK` _before_ `init`. The transport's hardcoded `method !== 'init'` gate disagreed with `GremlinServer`'s `INIT_EXEMPT_METHODS` set, so the first OOBE RPC awaited a promise that was never resolved and the spinner spun forever.

Fix: promoted `INIT_EXEMPT_METHODS` to an exported const in `src/shared/protocol/methods.ts` (re-exported via the protocol barrel). Both `GremlinServer.handleRequest` and `WorkerTransport.request` now read the same set. Regression test added in `WorkerTransport.test.ts` (`'lets dormant-callable methods (generateNewCEK) post before init resolves'`).

### Backend singleton encapsulation refactor (Phase 4 partially done)

Worker-side code held module-level singletons (`storage`, `encryptionService`, `apiService`, `toolRegistry`) that depended on someone calling an init function at the right module-load moment. The first to bite was `toolRegistry` (commit `ba57e42`). The next was `storage` — at worker module load the in-memory `localStorage` shim is empty, so the singleton wrapped a never-initialized `IndexedDBAdapter`. The minion tool threw `Tool execution failed: IndexedDB not initialized` whenever the user was on remote storage, because it imported `{ storage }` directly and hit the broken instance instead of the one `GremlinServer.init()` built from the storage config it received.

**Fix shipped** (plan: `/workspaces/.claude/plans/starry-dancing-gadget.md`): build storage / encryption / api service / tool registry as instance fields on `GremlinServer` from `init()` params; thread them through `ChatRunner` → `AgenticLoopOptions` → `ToolContext` so tools call `ctx.storage` instead of importing a singleton.

- [x] Phase 0 — Bug B fix (synthetic `loop_started` in `attachChat` so re-entering a chat with a running loop shows the running indicator immediately, instead of waiting for the next streaming event)
- [x] Phase 1 — Wire `BackendDeps` scaffold through `GremlinServer` → `ChatRunner` → `AgenticLoopOptions` → `ToolContext`. New `src/backend/backendDeps.ts` defines the bundle. `GremlinServer.init()` deferred branch builds a fresh `EncryptionService`/`UnifiedStorage`/`APIService`/`ClientSideToolRegistry` from `InitParams`. `ChatRunner` constructor takes the bundle. `buildAgenticLoopOptionsForContext` reads `deps.encryption.deriveUserId()` + `deps.toolRegistry.getSystemPrompts()` instead of singletons. `agenticLoopGenerator` reads attachments via `options.deps.storage.getAttachments` (kills the latent worker-mode bug for the attachment path) and copies the bundle into `ToolContext`. `minionTool`'s child loop forwards `deps` from its parent's `ToolContext`. `ToolContext.{storage,encryption,apiService,toolRegistry}` are typed optional in Phase 1 only — Phase 2 promotes them to required when consumers migrate. `registerAllTools(target?)` accepts a registry parameter. `APIService` constructor accepts a (currently-unused) deps bundle. `UnifiedStorage` constructor accepts an `_encryption` param (Phase 3 stores it and migrates the singleton calls). `createGremlinServer` builds the default bundle from the still-alive module-level singletons. **Worker mode still has Bug A latent** — Phase 2 fixes it by migrating `minionTool` / `metadataTool` to read from `ctx.storage`.
- [x] Phase 2 — Migrate `minionTool` + `metadataTool` off the singletons. `ToolContext.{storage,encryption,apiService,toolRegistry}` are now required (no `?`); the agentic loop's `ToolContext` construction site is the single source of truth. `minionTool` deletes its `import { storage }`/`{ toolRegistry }`/`{ apiService }`, binds them locally from `context` at the top of `executeMinion`, and forwards them through the existing helper functions (`rollbackToSavepoint` and `executeRemoteMinion` gain a `storage` parameter). `metadataTool` reads `context.storage` directly. Tests construct stub backend deps via a small shared `testStubs.ts` helper and thread them through `ToolContext` literals (no more `vi.mock('../../storage')` patterns for `metadataTool` / `minionTool`). After Phase 2, **worker mode no longer has Bug A** for tools — when remote storage is in use, the minion tool runs against the same `UnifiedStorage` instance `GremlinServer.init()` built from `InitParams`. Phase 3 next migrates the API clients + `vfsService` + `unifiedStorage` itself off the remaining singleton hold-outs.
- [x] Phase 3 — Migrate API clients (`openaiClient`, `responsesClient`, `anthropicClient`, `googleClient`, `bedrockClient`) + `vfsService` + `unifiedStorage` off the singletons. `APIService` constructor takes a required `APIServiceDeps` (`storage` / `toolRegistry` / `encryption`) and threads it into each client constructor; clients drop their `import { storage }` / `import { toolRegistry }` and read from `this.deps.storage.getModel(...)` / `this.deps.toolRegistry.getToolDefinitions(...)`. `UnifiedStorage` constructor stores the `EncryptionService` parameter and replaces every `encryptionService.X` with `this.encryption.X` (11 sites); `initialize()` keeps initializing the per-instance encryption. `vfsService` wraps its impure functions in an `export function createVfsService(storage, encryption)` factory whose closure captures the injected pair — the function bodies don't change, only the wrapping. Pure helpers (path utilities, type declarations, `VfsError`, binary helpers) stay at module level above the factory. A `defaultVfsService` built from the still-alive module-level singletons is exported for the fallback paths in `memoryTool.getMemorySystemPrompt` / `agenticLoopGenerator` (used by tests + standalone callers without a `createVfsAdapter` factory) and for the module-level wrappers re-exported as `createFile`, `readFile`, etc. (a follow-up deletes both). `RemoteVfsAdapter` constructor now takes an `EncryptionService` instance instead of importing the singleton. `LocalVfsAdapter` constructor takes a `VfsService` instance and delegates via `this.svc.X(...)`. `vfsFacade.getAdapter` takes a `BackendDeps` first parameter, builds a fresh `VfsService` per call, and constructs the right adapter. `GremlinServer.getProjectVfsAdapter` and `buildAgenticLoopOptionsForContext` pass `this.deps` / `deps` through. After Phase 3, **the worker bug A is functionally fixed end-to-end** — tools, agentic loop, API clients, VFS, and storage all receive deps via injection from `GremlinServer.init()`'s per-server bundle. The module-level singletons still exist but nothing inside the worker reaches for them.
- [x] Phase 4 — **Worker side is fully off the singletons.** New pure-function module `src/services/api/apiHelpers.ts` (`extractToolUseBlocks` / `mapStopReason` / `shouldPrependPrefill`) replaces the static-shaped `apiService.X(...)` calls; the frontend `src/utils/toolUseExtractor.ts` re-export switches to it (no more singleton instance reach in the render path). `agenticLoopGenerator` drops its `import { apiService, toolRegistry }` lines, reads `extractToolUseBlocks` / `mapStopReason` / `shouldPrependPrefill` from `apiHelpers`, and reads `apiService.sendMessageStream` / the tool registry off `options.deps.{apiService,toolRegistry}` and `toolContext.toolRegistry`. The render helpers (`createToolResultRenderBlock`, `populateToolRenderFields`, `buildDummyAssistantMessage`) accept an optional `ClientSideToolRegistry` parameter so the frontend's `useChat` cancel path keeps working without one. `GremlinServer.{getCekState,deriveUserId,rotateCek,rotateTable,clearCek}` route through `this.deps.encryption` instead of the module-level singleton; `tryDecryptSample` uses a disposable `new EncryptionService()` probe so the active per-server encryption is never disturbed. `runImport` / `runExport` accept the `EncryptionService` as a parameter from `GremlinServer.{importData,exportData}`. `App.tsx` no longer imports `encryptionService`; the OOBE/launched decision reads `getCachedCEKString()` from `localStorageBoot.ts` directly in the `useState` initializer, and the loading screen disappears. `main.tsx` and `gremlinWorker.ts` drop the module-load `registerAllTools()` calls — registration happens lazily inside `GremlinServer.init()` against the per-server registry. Two new RPCs (`exportProject` streaming, `importProject` one-shot) replace the singleton-using `utils/projectImport.ts` / `utils/projectExport.ts` runtime; `src/backend/projectBundle.ts` holds the new impure runtime, and the utils files are now pure helpers + the main-thread `triggerProjectDownload`. Dead `ChatSnapshot` / `LoopSnapshot` interfaces deleted from `protocol.ts`; the streaming `attachChat` / `attachLoop` results are now `{ ok: true }`. **Bug A and Bug B are fixed end-to-end in the worker.**
- [x] Phase 4 follow-up — Hoist pure helpers + tighten utils lint scope. New `src/lib/` directory holds the boundary-clean shared helpers: `incompleteTail.ts`, `vfsPaths.ts`, `apiHelpers.ts`, `api/modelMetadata.ts` + `api/model_metadatas/*` + `api/mergeExtraModels.ts`. `vfsService` re-exports the path helpers from `lib/vfsPaths.ts` so internal callers and the vfs barrel keep working. `dataExport.ts` / `dataImport.ts` runtime moved to `src/backend/`; the type-only progress callbacks live in `src/types/data.ts` and frontend imports re-point. The old `src/utils/{incompleteTail,vfsPaths,mergeExtraModels,toolUseExtractor}.ts` re-export shims are deleted; consumers (hooks, components, contexts) import from `src/lib/` directly. The boundary lint rule in `eslint.config.js` now covers `src/utils/**`, `src/App.tsx`, and `src/main.tsx` in addition to the previous `components/**`/`hooks/**`/`contexts/**` scope.
- [x] Phase 4 follow-up — Delete the four module-level singleton exports (`storage`, `encryptionService`, `apiService`, `toolRegistry`), the `defaultVfsService`, and the module-level wrappers in `vfsService` (`createFile`, `readFile`, etc.). The vfsFacade's locked passthrough/compound wrappers (which were dead code in production — only LocalVfsAdapter / RemoteVfsAdapter consume them via their own per-instance lock paths) are gone too; only `getAdapter` is still exported. `createGremlinServer` now mints its own fresh `EncryptionService` / `UnifiedStorage` / `APIService` / `ClientSideToolRegistry` per call instead of bundling singletons. `registerAllTools` lost its default-singleton param and now requires a target registry. `SystemPromptContext.createVfsAdapter` and `AgenticLoopOptions.createVfsAdapter` are now required (not optional); the agentic loop's fallback construction of a `VfsService` is gone, and `getMemorySystemPrompt` / `getMinionSystemPromptInjection` throw a clear error if the factory is missing. `createStorage(config, encryption)` now requires the encryption parameter (the singleton default is gone). Hook tests (`useChat`, `useProject`, `useAttachmentManager`, `useMinionChat`) mock `../client` (gremlinClient + GremlinSession) at the boundary instead of mocking `services/storage` and relying on the in-process backend to dispatch through the singleton. Tool tests (`checkpointTool`, `returnTool`, `metadataTool`, `minionTool`, `clientSideTools`, `minionIntegration`) construct local `ClientSideToolRegistry` instances or use `vi.hoisted` mock holders. VFS tests share an in-memory storage + encryption stub via `_vfsTestHelpers.ts` and construct `createVfsService(stubStorage, stubEncryption)` directly. `executeClientSideTool` reads from `context.toolRegistry.get(toolName)` instead of the (deleted) module-level singleton. **VFS access lives only in the worker** — `buildLoopOptions` is the single production constructor of `SystemPromptContext` and `AgenticLoopOptions`, and it always supplies `createVfsAdapter` from `BackendDeps`. Direct service-layer calls from outside the worker will throw a clear "VFS access is only available inside the worker" error rather than silently constructing a fallback adapter.

### iPhone Safari textarea event-lock (fix shipped, unverified on device)

Symptom: typing/pasting into a `<textarea>` on iPhone Safari can leave the entire page event-locked (no clicks, taps, or scroll fire). Belongs to the family of iOS quirks where the **layout viewport** and **visual viewport** drift apart after the on-screen keyboard pops up/down. This app was particularly prone because of three amplifiers stacked on the drift:

- `index.html` viewport meta included `height=device-height`, which is non-standard and decouples the layout-viewport from the visual-viewport during keyboard transitions.
- `Modal.tsx` repositioned its `fixed inset-0` overlay via inline `top`/`height` derived from `visualViewport.offsetTop`/`height` on every resize/scroll event — a transient interim viewport could leave a z-50 overlay covering the page with the outer `onClick={onClose}` still grabbing every tap.
- `App.tsx` mobile sidebar backdrop was always-mounted and toggled by opacity + `pointer-events-none`, leaving a `fixed inset-0` rectangle at stale layout-viewport coordinates after a keyboard close.

Smaller amplifiers fed the loop: `ChatInput.tsx`'s `setTimeout(100ms) + scrollIntoView` on focus fought iOS's own keyboard scroll, the safe-area spacer remounted on every `keyboardVisible` toggle, and `useIsKeyboardVisible` had no debounce on `visualViewport.resize`.

Fix: drop `height=device-height`; stop positioning `Modal.tsx` from `visualViewport` and move its close-on-click onto the dedicated backdrop element (not the outer `inset-0`); unmount the mobile sidebar overlay when closed; remove `ChatInput.tsx`'s `scrollIntoView` after focus; always render the safe-area spacer; coalesce `visualViewport.resize` onto an animation frame in `useIsKeyboardVisible`.

Diagnostic instrumentation (currently in place, removable as one commit): `[Modal]` mount/unmount, `[kbd]` per-frame viewport state, `[sidebar]` toggle, `[tap]` capture-phase `pointerdown` probe. Verification recipe: connect iPhone via macOS Safari → Develop → iPhone, reproduce on chat input + `SystemPromptModal`, watch the `[tap]` log when a tap "doesn't work" — its target tells you which overlay is still hostile. Remove diagnostic commit once stable.

### Anthropic Citation Document Index

When using web search + memory tool together, citations in assistant messages may contain `document_index` references that become invalid after client-side tool execution breaks the turn. Workaround: citations are stripped from text blocks when the previous message contains a `tool_result` (in `anthropicClient.ts`). This may cause some citation data loss in multi-tool-use conversations, but prevents API 400 errors.

**Root cause unclear** - could be:

1. Server tool (web_fetch) document counted separately from web_search results
2. Document indices invalidated when conversation turn is split by tool calls
3. Claude incorrectly counting search results

### TypeScript Warnings

- useEffect missing dependency: Case-by-case investigation needed

### Minion streaming wire amplification (fixed — delta encoded)

Symptom: minion tool yielded `{ type: 'groups_update', groups: [...] }` on every upstream SSE event, carrying the full assembled snapshot `[infoGroup, ...accumulatedGroups, ...streamingGroups]`. For a ~2 KB minion message with ~10 chars per SSE delta, that was ~200 frames × ~1 KB average → ~200 KB on the wire to deliver 2 KB. Multi-turn minion loops were worse because `accumulatedGroups` re-shipped on every frame.

Two-wave fix:

- **Wave 1** (shipped earlier): enabled `perMessageDeflate: { threshold: 256 }` on the WebSocket server (`src/server/websocketTransport.ts`). ~5–10x gzip savings on the repetitive JSON. Doesn't reduce JSON.stringify CPU cost server-side, doesn't help worker mode.
- **Wave 2** (this change): replaced the snapshot-per-frame protocol with delta encoding. New types:
  - `ToolGroupsDelta` (`src/shared/protocol/types/index.ts`) — discriminated union of `init` / `append` / `replace_streaming` / `message_finalized`.
  - `tool_groups_delta` and `tool_groups_snapshot` LoopEvent variants (`src/shared/protocol/events.ts`).
  - Helper module `src/shared/services/tools/toolGroupsDelta.ts` — `diffStreamingGroups` picks `append` whenever only the trailing text/thinking block grew, falls back to `replace_streaming` on structural changes; `applyGroupsDelta` is the inverse used by both server (`LoopRegistry`) and client (`useChat`) so wire state stays in sync.

Emission path: `minionTool` runs the diff at each yield site (lines ~488 touch-grass, ~1583 streaming_chunk, ~1599 message_created, ~1731 auto-enforce). `agenticLoopGenerator` forwards `groups_delta` as wire-level `tool_groups_delta`. `LoopRegistry.recordPendingToolResultEvent` applies the same delta to a per-`toolUseId` `groupsState`. `GremlinServer.attachChat` emits `tool_groups_snapshot` during replay so a reconnecting subscriber rehydrates without waiting for the next live delta.

**Value-stability invariant:** every emitted delta must carry a frozen snapshot, never a reference into `StreamingContentAssembler.getGroups()`. That helper returns a fresh outer array but keeps the inner block objects, growing `.text` in place. Deltas sit in `attachChat`'s broadcast queue while `GremlinServer.startLoop`'s background pump races ahead, so an aliased `init`/`replace_streaming` payload would serialize the grown text rather than the baseline its diff was computed against — the next `append` then re-ships the overlap and the receiver duplicates the early characters until `message_finalized` resets the streaming state. `nextStreamingDelta` snapshots once up front and emits from that snapshot; `append` is inherently safe (it carries an immutable string slice). The legacy `groups_update` → `tool_block_update` path (`agenticLoopGenerator.ts:957`) still aliases `event.groups` — latent, since no current tool streams via `groups_update`; freeze it there too if one ever does.

Consumption path: `useChat.ts` maintains a `toolGroupsRef: Map<toolUseId, ToolGroupsState>`, applies deltas, projects assembled `[info, ...accum, ...streaming]` into the placeholder message's `renderingContent` via the existing `applyToolBlockBatch` machinery (200 ms throttle, same channel as `tool_block_update`). `reconnect_start` cancels the projection timer but preserves the ref — `tool_groups_snapshot` from attach replay overwrites entries, `loop_ended` cleans up.

Regression tests:

- `src/shared/services/tools/__tests__/toolGroupsDelta.test.ts` — diff/apply round-trip, defensive paths, a bandwidth assertion that the delta stream is ≥10x smaller than equivalent snapshots, and value-stability cases proving `init`/`replace_streaming` payloads stay frozen when the producer mutates blocks in place after emit (no first-character duplication).
- `src/frontend/hooks/__tests__/useChat.test.ts` — `'rehydrates minion streaming UI from tool_groups_snapshot on reconnect'`, `'applies tool_groups_delta append events to placeholder rendering'`.
- Wave 1's `'preserves in-flight pending_tool_result placeholder past snapshot_complete trim'` is unaffected and still passes.

Plan reference: `/workspaces/.claude/plans/when-the-minion-run-giggly-corbato.md`.

### Streaming-vanishes-on-reconnect (fixed)

Symptom: while a minion was mid-stream, a WebSocket reconnect (e.g. mobile network switch) made the minion's progress vanish from the UI until the message completed — but switching chats away and back recovered it.

Root cause in `useChat.ts`: the snapshot replay's `pending_tool_result` event re-added the placeholder message at the end of `messages`, but the `reconnect_start` reconciliation flow tracks `reconPosRef` against the matched-prefix tail of _persisted_ messages. Snapshot_complete then sliced messages to `reconPosRef`, dropping the placeholder. The follow-up `tool_block_update` carrying the cached `renderingGroups` had no target to land on, so the minion's progress stayed invisible until a fresh `message_created` arrived (loop completion) or a new `GremlinSession` was constructed (chat-switch-and-back).

Fix: when `pending_tool_result` fires inside the reconciliation window, take the same truncate+append path that `message_created` uses on first mismatch — slice locals at `reconPosRef`, append the placeholder, set `reconTruncatedRef = true`. `snapshot_complete`'s trim becomes a no-op and the placeholder survives. Regression test: `useChat.test.ts` `'preserves in-flight pending_tool_result placeholder past snapshot_complete trim'`.

## Design: VFS Migration During Cross-Backend Import

Global CSV export now includes VFS_META, VFS_FILES, VFS_VERSIONS tables. This covers local VFS (IndexedDB, SQLite encrypted mode) automatically. Projects using **remote VFS** or **server filesystem VFS** need a separate migration step because their file data isn't in storage tables.

Remote VFS UI is hidden when connected to a server backend (`ProjectSettingsView` checks `getStorageConfig().type`). Server-side `createVfsAdapter` only supports `filesystem` and `encrypted` modes — no per-project remote VFS dispatch.

### Migration scenarios

**Scenario 2: webworker → webworker, different CEK.** [x] Implemented. Same remote VFS server, but `userId` (derived from CEK) differs between source and target instance. Post-import migration uses the old CEK to derive the old userId, connects to the remote VFS, copies files + versions to the new userId's space, then strips `remoteVfsUrl` from the project.

**Scenario 3: webworker → remote backend.** [x] Implemented. The server backend doesn't support per-project remote VFS. Post-import migration reads files from the remote VFS (using the old CEK for userId derivation and E2E decryption if enabled) and writes them to the server's local VFS (`filesystem` or `encrypted` depending on `VFS_MODE`). Then strips `remoteVfsUrl` from the project.

**Scenario 4: any source (local VFS) → server with filesystem VFS.** [x] Implemented. CSV import writes VFS_META/VFS_FILES/VFS_VERSIONS table records to SQLite, but `FilesystemVfsAdapter` reads from disk. Post-import migration reads table records via `LocalVfsAdapter`, writes to `FilesystemVfsAdapter`, then cleans up the orphaned table records.

**Scenario 5: remote backend (filesystem VFS) → anything.** `FilesystemVfsAdapter` stores files on disk at `${vfsBasePath}/${projectId}/...` — zero storage table usage. VFS tables are empty in the CSV export. Need a dedicated pre-export step that reads from the filesystem, serializes into VFS_META/VFS_FILES records, so they can be imported by the target. **Not yet implemented** — explore a pre-export materialization step on the server.

### Implementation (scenarios 2, 3, 4)

Post-import migration runs automatically after CSV import (skippable via checkbox in import modal):

- `RemoteVfsAdapter` moved to `src/shared/services/vfs/` so both worker and server can use it
- `vfsMigration.ts` — core recursive walk + copy between any two `VfsAdapter` instances (files + version history), plus `migrateProjectVfsBulk` for pre-read data with parallel writes
- `vfsMigrationDetector.ts` — scans projects for `remoteVfsUrl` or VFS table records needing migration
- `importRunner.ts` — extended with post-import VFS migration phase. Scenario 4 uses bulk path: `vfsService.readAllForMigration()` (single tree load, batch DB fetch, parallel decryption) → `migrateProjectVfsBulk()` (bounded 8-way parallel file writes)
- `BackendDeps` carries `buildMigrationSourceAdapter` factory and `vfsMode` for scenario dispatch
- `VfsAdapter.writeFileWithHistory()` — bulk write method on all adapters; optimized on `FilesystemVfsAdapter` (writes version files directly, single meta write), fallback (sequential `writeFile`) on `LocalVfsAdapter` and `RemoteVfsAdapter`
- Import modal hides "Migration Mode" on server backends, shows "Skip remote VFS file migration" checkbox in non-migration mode
- Same-CEK optimization: when source and target CEKs match **and the target is a worker** (no `vfsMode`), remote VFS migration is skipped (files already accessible via `RemoteVfsAdapter`). Server backends always use local adapters so migration must run regardless of CEK match.

## Technical Debt

- Hardcoded pricing needs maintenance mechanism
- Accessibility audit needed
- **claude-agent debug logs**: `[useChat] claude-agent` and `[minionTool] claude-agent` `console.debug` calls were added for live-debugging the rollback/resume flow — strip the verbose ones (keep the lifecycle one-liners) before opening a PR. `src/server/claudeAgentClient.ts` is done: its verbose per-SDK-message / per-partial-event / coalesced-block traces and the prompt/options dumps are gated behind `CLAUDE_AGENT_DEBUG=1`, leaving only once-per-turn lifecycle + failure-diagnostic lines on by default. Remaining files: `src/frontend/hooks/useChat.ts`, `src/shared/services/tools/minionTool.ts`.

## Future Considerations

1. [x] **OpenAI/xAI Thinking** - Streaming thinking support for providers that expose thinking tokens
2. [x] **Code Execution** - Add `CodeExecutionRenderBlock` for agentic features
3. [x] **Custom Tools** - Extend block types beyond web search/fetch
4. **Citation Tooltips** - Hover tooltips for `data-cited` content
5. **Streaming Abort** - Handle abort signal mid-stream
6. **Move ID generation backend-side** — `idGenerator.ts` is currently called from ~5 frontend files (project/chat/error/UI key creation) so it has to live in `shared/`. After Phase 1.8's leak audit, every other "shared helper" turned out to be reducible to single-side ownership. ID generation could likely follow the same pattern: have `gremlinClient.createProject(name)` etc. return the saved entity with a server-assigned ID, so the FE never mints IDs locally. Error IDs and React render keys would stay frontend-local with a tiny inline helper. Worth investigating — if it works, `shared/protocol/helpers/` becomes empty and the directory disappears entirely. If the FE-locally-mints-then-saves pattern turns out to be load-bearing somewhere, leave it as is.

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
- [x] Project settings (system prompt, pre-fill, model, temperature, reasoning, verbosity, web search, message format)
- [x] Chat-level agent config (`⋯ → Chat Settings`): per-chat overrides for persona / prompt files / VFS namespace / tools / reasoning knobs, resolved between the project and the loop options, with a server-resolved prompt preview
- [x] Clone a minion chat into a real chat (`⧉` in the minion overlay) — carries the minion's persona, namespace, tools, model and claude-agent SDK session
- [x] Chat with streaming responses, message editing, forking, rollback, and cost tracking (separate minion token/cost tracking in info bar)
- [x] Message rendering (Markdown, syntax highlighting, LaTeX math with disable-math toggle, thinking blocks, citations, code block copy, word-break on non-code containers)
- [x] Per-message info bar (`MessageInfoBar`, shared by assistant / user / tool-result bubbles): collapsed trigger row shows date+time | model (served id only, truncated to 16 chars, red when it differs from the requested id, `-` when the provider reported none or the message predates capture — never falls back to the requested id) | ctx fill + cost | stop-reason badge; clicking expands a second row with the action buttons and the `↑/↓` token breakdown
- [x] Image attachments (resize, compress, multi-select, preview, lightbox)
- [x] Virtual scrolling for long message histories with scroll-to-bottom button and hysteresis bounce protection
- [x] API clients (OpenAI Responses, OpenAI Chat Completions, Anthropic, Google Gemini, Bedrock) with streaming and cross-model tool call reconstruction
- [x] Served-model capture: `StreamResult.servedModel` carries the model id the provider reports in its response (Anthropic `message.model`, OpenAI `model`, Gemini `modelVersion`, claude-agent coalesced assistant message); persisted as `metadata.servedModel` beside the requested `metadata.model`. Bedrock Converse has no such field, so it stays undefined there
- [x] Cache-routing key (`prompt_cache_key` for OpenAI/Responses, `metadata.user_id` for Anthropic) — defaults to sha256(projectId); per-project Advanced toggle switches to sha256(chatId). The scope is threaded into minion sub-loops too, and since a minion loop's `chatId` is its own minion chat, `chat` scope gives every minion its own bucket. Gemini and claude-agent have no equivalent field and are unaffected.
- [x] Flex / batch tier (≈50% discount, lower priority). Per-provider `flexTierSupported` toggle gates the per-project `flexTierEnabled` opt-in; OpenAI clients inject `service_tier: 'flex'`, Google Gemini injects `serviceTier: 'flex'`. The gate is re-evaluated per call against whichever provider is actually running, so a minion pointed at a flex-supporting provider gets the discount even when the parent chat's provider doesn't support it. Cost calc applies a 0.5× multiplier to token-priced lines (per-request fees not discounted). Doubao Seed 2.0/1.8 + gemini-3.5-flash metadata added at the same time.
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
- [x] Multi-instance server mode: `--instance-env <path>` loads a specific env file; relative data paths resolve against the file's directory; `gremlinofa-server@.service` systemd template + OpenRC symlink convention for per-user instances
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
- [x] Admin record editor (Data Manager → Record Editor): decrypt/edit/re-encrypt any raw storage row by table + id via `adminGetRecord` / `adminSaveRecord` (`UnifiedStorage`). Compression sniffed per-row from the "GZ" marker and preserved on save; `app_metadata` rows edit their plaintext `unencryptedData`; non-JSON payloads (binary `vfs_files`) refused with `RECORD_NOT_EDITABLE`. The previous blob (ciphertext — never decrypted content) is backed up under `admin_edit_backup:<table>:<id>` in `app_metadata`. Saves run under the per-record keyed lock and the `LOOPS_RUNNING` guard.
- [x] Storage quota display (local IndexedDB only, shows usage/quota with warning at >100MB or >50%)
- [ ] Data migration between localStorage and remote storage
- [x] Server: CEK oracle verification on init — encrypted oracle in metadata table, verified before any data writes; wrong-CEK init returns `CEK_MISMATCH` and server stays dormant
- [x] VFS migration during cross-backend import (see design below)
- [x] VFS performance pass (see "Encrypted-mode hot paths" under the Memory Tool's VFS Architecture): decrypted-tree cache, `VfsNode.size`, single-pass `appendFile`, batch `deletePaths` (+ `/api/rm-many`), `mkdir({ recursive })`, fast base64 + cached AES key, reflink version snapshots on CoW filesystems, JS `fs.appendFile` / `fs.rm`, batched QuickJS microtasks
- [ ] VFS: writing a file / dir over a soft-deleted node (`createFile`, `writeFile`, `appendFile`, `mkdir` in `vfsService`) replaces the node without orphaning its `fileId`s, so that content and its versions stay in storage with nothing pointing at them. `rename` already orphans a displaced destination; the same should happen here (recursively for a deleted directory)
- [ ] VFS: `restoreOrphan` recreates the node without `isBinary` / `mime` (the orphan record doesn't carry them), so a restored binary file reads back as base64 text
- [ ] VFS server: `/rmdir` ignores `recursive` and always `rm -rf`s with `force`, so `RemoteVfsAdapter.rmdir(path, false)` deletes non-empty directories and never reports a missing one
- [ ] VFS: still multi-load on the encrypted path — `LocalVfsAdapter.copyFile` (4 tree loads), `writeFileWithHistory` (one locked write per version), the VFS Manager ZIP upload (`mkdir` per parent per file). `/lib` scripts are re-decrypted on every JS tool call; a ciphertext-keyed content cache like the tree's would fix that if it shows up in measurements
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
- [x] Soft stop for agentic loop (stop button halts at next tool boundary). The request lives on the backend `LoopRegistry` and is surfaced on `ActiveLoop.softStopRequested` (broadcast as an `updated` delta + carried in the snapshot), so the "Stopping…" indicator is backend-canonical — it survives a chat switch / re-attach instead of resetting to the plain stop button
- [x] Abort ongoing API calls (hard abort via `gremlinClient.abortLoop` → `LoopRegistry.abort` → `AbortController` → API client `signal:` option)
- [x] Focus mode (⋯ menu: hides backstage, tool results, metadata; shows only user text/images + assistant text)
- [x] Expand minions (⋯ menu: inline minion name/model/input/output without collapsed bar)
- [x] Disable Math toggle (⋯ menu: renders `$...$` as literal text instead of KaTeX)
- [x] Always Auto Scroll (⋯ menu: keeps auto-scroll active regardless of scroll position)
- [x] DUMMY System (LLM-registered JS hooks intercept the agentic loop before API calls — synthetic responses, user handoff, or passthrough; async hooks and top-level await supported)
- [x] `memoriesWritable` option on the filesystem and JavaScript tools (off by default) — lets each tool write, rename and delete under `/memories`. Same pass fixed `fs.stat().readonly` ignoring `/share` for namespaced JS tool / DUMMY hook callers (`FsBridge` never got the namespace)
- [x] Remote human minion ("Touch Grass") — delegates minion tasks to a human via `touch-grass-backend/`. Minion tool gains `remote` parameter + `remoteEndpoint`/`remotePassword` options. Backend provides web UI for human operators with session list, chat view, and long-poll delivery.
- [x] Nested minions (`allowNesting` minion option, off by default; `maxNestingDepth` hard cap, default 3) — a minion can spawn sub-minions. Depth threaded via `ToolContext.minionDepth`; sidebar loop tree + minion-chat overlay stack render arbitrary depth. Final rendering recursive; live streaming at depth ≥ 2 is a Phase 2 follow-up (see Minion Tool → Nested minions).
- [x] Attach-file support for claude-agent — image attachments and `injectFiles` / `injectFilesAfter` ride the SDK's streaming-input prompt as content blocks (see Claude Agent Provider → Supported knobs); `as-file` and `mock-tool-call` downgrade to `separate-block`
- [x] Parallel bridged tool calls for claude-agent — every `mcp__gremlin__*` tool advertises `readOnlyHint: true`, the CLI's only switch for running MCP calls concurrently; the bridge re-applies the minion launch stagger itself (see Claude Agent Provider → Tool bridging)
- [x] Ambient CLI config off for claude-agent — `strictMcpConfig: true` + `settings: { disableClaudeAiConnectors: true, disableBundledSkills: true }` (see Claude Agent Provider → Host-config isolation). Audit over `claudeAgentClient.ts` done at the same time: `cwd` is our session dir, `plugins` unset, `settingSources: []`, `mcpServers` is only the `gremlin` bridge; the `process.env` copy is deliberate (auth + output cap). Worker mode has no counterpart — the stub throws
- [ ] Phased tool execution for claude-agent — the bridge runs simple and `complex` (minion) tools as one flat parallel batch, unlike the loop's simple-then-complex phases, so a same-turn file write and a minion that reads it can race. Fix sketch: track in-flight simple calls in the bridge and make `complex` calls await their settlement, with one re-snapshot grace round since MCP exposes no batch boundary (the CLI fans a batch out in block order within milliseconds)
- [x] Pre-push review fixes — mock-tool-call injection fields stored for retry-restore (see Minion Tool → savepoint/stash); claude-agent surfaces bad assistant stop reasons (`max_tokens` mid-text truncation → minion rewind + Truncated badge, see Claude Agent Provider → Empty-turn surfacing); Invalid Date serializes as `null` on the wire instead of throwing; conversation-derived content (CoT, refusal explanations, tool-error strings, raw Bedrock stream events, SSE fragments) removed from default-level logs — gated behind `CLAUDE_AGENT_DEBUG=1` or reduced to lengths

**API & Pricing**

- [ ] API key validation
- [x] ChatGPT subscription provider (`chatgpt-subscription`): Codex-login OAuth (device code + manual-paste PKCE), backend-owned rotating tokens, ChatGPT backend Responses endpoint, both modes (worker via cors-proxy), API-list pricing by default with the Subscription-service toggle for $0 — see ChatGPT Subscription Provider
- [ ] Audit the remaining API clients (`openaiClient.ts`, `anthropicClient.ts`, `googleClient.ts`, `bedrockClient.ts`) for the bug class behind the `web_search_preview` 400: a wire-shape literal hardcoded in a shared client that a subclass or a newer model cannot override, and provider keys passed as string literals where `ownFamily` belongs
  - [x] `effectiveInjectionMode` call sites swept: `responsesClient.ts` was passing `'responses_api'` instead of `this.ownFamily` (fixed — `as-file` was reaching the Codex backend). The other five call sites live in clients with no family-overriding subclass, so the literal is correct there; re-check if any of them ever gains one
  - [ ] Same sweep for backend requirements a subclass has no hook to express — the missing `session_id` header was exactly this shape, and `requestHeaders()` only exists on `ResponsesClient`
- [x] ChatGPT subscription prompt caching — `session_id` / `conversation_id` headers (the backend's actual cache-affinity key); zero cache reads before, see ChatGPT Subscription Provider
- [ ] `nudgeThinking` breaks the prompt-cache prefix on every client except Anthropic — it is appended to the last user message at send time and never persisted, so a message already sent with the nudge goes out without it on the next tool round-trip. Anthropic compensates by shifting its breakpoint; the OpenAI-family clients don't. Fix is to make the nudge a trailing item rather than an edit to an existing message. See Prompt-cache diagnostics
- [ ] ChatGPT subscription quota chip — read the `x-codex-*` rate-limit headers off the response (`client.responses.create(...).withResponse()`) into `StreamResult.providerExtra` and show used-percent / reset time; the cors-proxy already exposes the headers
- [x] Abnormal stream termination surfaced on every client — truncations keep the turn with a real stop reason, cut-off streams and failures become turn errors (see Stream termination)
- [ ] Replay sanitizing for unfinished items: a truncated turn keeps its `fullContent`, so an `in_progress` Responses reasoning item without `encrypted_content`, or a `max_tokens`-truncated tool call with no result (Responses `function_call`, Gemini `functionCall`, Bedrock `toolUse`), goes back verbatim on the next request and may 400. Cut-off streams already drop their calls; truncations don't
- [ ] Chat Completions `refusal` is never rendered — `CompletionChunk.delta` has no `refusal` field and the non-streaming path stores `message.refusal` without emitting it, so a refusal reads as an empty `end_turn`
- [ ] Anthropic `pause_turn` is stored as a badge instead of continuing the turn; mid-stream errors report 0 usage although the SDK snapshot holds partial usage
- [x] Advanced settings per API definition (collapsible section in Settings)
  - [x] Prune previous thinking blocks (strips thinking/reasoning from historical messages for providers that reject them)
  - [x] Prune empty text blocks (removes empty text blocks from historical messages)
  - [x] Enforce genuine Anthropic (rejects responses with zero cache activity or unsigned thinking blocks)
  - [x] Reasoning dialect (four-value enum picking the provider's reasoning wire shape — `openai` / `thinking-object` / `enable-thinking` / `openrouter`; settable per model metadata or per provider, with an override for gateways that normalize what they front). Supersedes the `deFactoThinking` boolean, which is still read. Fixed along the way: Qwen was getting `thinking: {type}` when it wants `enable_thinking`. Kimi K2.x takes `thinking: {type, keep}` per the current Kimi docs, not `enable_thinking` (unverified on the platform API)
  - [ ] Per-dialect reasoning budgets — Qwen's `thinking_budget` and Doubao's `thinking.budget_tokens` are never sent (only OpenRouter's `max_tokens` is). Adding one to `thinking-object` would silently change GLM/MiMo behaviour, which don't accept it, so it needs to be per-dialect
  - [x] Nudge model to think (appends a nudge phrase like `<<WITH THINKING STEPS>>` to last user message at send time — for models that skip chain-of-thought without a nudge; resolved as a loop option via `buildAgenticLoopOptionsForContext`, overridable per minion call via `minionTool` `nudgeThinking` input)
  - [x] Mandate chain-of-thought (requires at least one response with reasoning tokens/thinking blocks per agentic run — triggers minion savepoint rollback on retry)
- [x] Reasoning replay overhaul — live-probed (see Reasoning replay: vendor behaviour). Several vendors' docs contradict their own APIs, so the probe table wins over vendor docs
  - [x] Live probe per vendor (DeepSeek, Kimi coding plan, Z.ai coding plan, Alibaba token plan, MiniMax, MiMo, OpenAI, OpenRouter)
  - [x] Replay reasoning regardless of `enableReasoning`, and send the Responses `include` unless the cached model says `reasoningMode: 'none'` (unknown ids count as reasoning). Every probed endpoint accepted `include`, OpenAI's non-reasoning models included, so the `'none'` skip is caution for unprobed backends rather than a known 400
  - [x] Never send `thinking: {type: 'disabled'}` / `enable_thinking: false` / OpenRouter `reasoning: {enabled: false}` to an `'always'` model (Alibaba- and OpenRouter-hosted glm-5.3 400 on it). OpenRouter's `/models` `reasoning.mandatory` maps to `'always'`
  - [x] `mandatesReasoningReplay` metadata (every DeepSeek entry). Only first-party DeepSeek enforces it, and only on assistant turns that carry tool calls. Pruning and checkpoint tidy keep those turns' reasoning; tool-call turns with none get a placeholder: `reasoning_content: ""` on Chat Completions, a reasoning item with `reasoning_text: " "` on Responses (DeepSeek Responses treats `""` as missing when the call id isn't one it minted; re-probed 2026-10-01)
  - [x] `thinkingKeepTurns` → `reasoningHistoryParam` (see Reasoning dialects)
  - [x] Chat Completions echo: reasoning text goes back as `reasoning_content` whichever key it arrived on. OpenRouter stays on `reasoning_details`. Unprobed: vLLM ≥0.20 (reportedly reads only `reasoning`) and Ark's Chat Completions `encrypted_content` (Doubao seed-2.x)
  - [x] Responses replay: a missing `summary` goes out as `[]` (the only OpenAI 400 among the probed mutations). Stored items are copied, never mutated
  - [x] Similar-bug sweep: Anthropic, Bedrock and Google omit the thinking field when the toggle is off rather than sending a disable value, so none of them can 400 an always-reasoning model (superseded by the toggle-off fix below, which sends `disabled` only where the model accepts it)
  - [x] glm-5.3 / -flash / -flashx are `'always'`: Z.ai's general API (`/api/paas/v4`, code 1210), Alibaba and OpenRouter 400 on disabling them. Only the Z.ai coding plan accepts `disabled` (and still reasons a little), and with the toggle off it now gets `enabled` at the server-default effort `max`
  - [x] GLM-5.3 family effort (`low` / `high` / `max`, server default `max`) rides beside `thinking`; toggle off → `low` (see Reasoning dialects → Effort beside the toggle)
  - [ ] DeepSeek reads earlier turns' reasoning whenever the request carries `tools`. Its thinking-mode docs (2026-09-30) say so outright: "the reasoning_content of all previous turns should be passed back to the API and will be concatenated into the context". So with pruning on, `keepToolTurnReasoning` (tool-call turns only) under-keeps for DeepSeek. Unprobed live (the earlier-turn recall probe sent no `tools`)
  - [x] Effort ladders audited against vendor docs and OpenRouter's `/models` `supported_efforts` (2026-09-30): DeepSeek V4.x `low` / `high` / `max` (default `high`), GLM-5.2 `high` / `max` (default `max`), Qwen 3.8 `low` / `medium` / `xhigh` (Responses only), Kimi K3 and GLM-5.3 unchanged. None on Kimi K2.x, MiMo, Qwen ≤3.7 or GLM ≤5.1. DeepSeek's `thinking` + `reasoning_effort` pair is its own documented example; not live-probed (the key had expired)
  - [x] Responses thinking switch: `reasoning.effort: none` beside `thinking: disabled` (see Reasoning dialects → Responses thinking switch)
  - [x] Added the current ids the metadata lacked: `deepseek-flash` (V4.1 Flash, which also serves the retired `deepseek-v4-flash` name), `mimo-v2.6-flash` / `mimo-v2.5`, `qwen3.8-flash`. Repriced deepseek-v4-pro (peak list rate) and mimo-v2.5-pro (now billed as v2.6-pro)
  - [x] Similar-bug sweep after the `mimo-v2.5` collision: a match ranks by its longest prefix, so a short catch-all prefix sharing a match with a long one outranks unrelated entries. The only other case was `gpt-4` beside `gpt-4.1`, which priced dated `gpt-4o-*` snapshots as GPT-4.1; split into its own match
  - [x] `mapReasoningEffort` rounds an in-between pick **up**, as every vendor with a gapped ladder does itself (DeepSeek, Z.ai and Alibaba map `medium` → `high`, Alibaba maps Qwen 3.8 `high` → `xhigh`). Rounding down sent a project effort of `medium` to Kimi K3, GLM-5.3 and DeepSeek as `low`, and could turn `minimal` into `none` (off) on a ladder that starts at `none`. `mapAnthropicEffort`'s `xhigh` → `max` special case is now just the general rule. Also changes grok-3-mini (`medium` → `high`) and Gemini 3 Pro (`medium` → HIGH)
  - [ ] Ark (Doubao) on Responses now gets `reasoning.effort: none` beside `thinking: disabled` when the toggle is off. Ark documents both fields, but the pair is unprobed, and so is whether Doubao models without an effort ladder accept `none`
  - [x] Dated `-mini` / `-nano` snapshots (`gpt-4o-mini-2024-07-18`, `gpt-4.1-mini-2025-04-14`, `gpt-5-mini-2025-08-07`) missed their entries, which match on a postfix, and billed at the parent model's rate. Each now also has a plain prefix match, and the `gpt-4` + `-mini` / `-nano` catch-alls sit in their own matches so they rank below `gpt-4o-mini`
  - [ ] No metadata for Kimi's coding-plan alias `kimi-for-coding`; it resolves through the definition's dialect
  - [x] Opus 5 was missing `onlyAdaptiveReasoning`, so a project with a thinking budget sent `thinking.type: enabled`, which Opus 5 rejects with a 400 (Anthropic's thinking troubleshooting table, 2026-09-30)
  - [x] Effort-ladder audit of the other vendors (2026-09-30, official model pages first, OpenRouter's `supported_efforts` as the cross-check; resolution checked against OpenAI's live `/models` list):
    - OpenAI: `minimal` dropped from every gpt-5.1+ ladder; `xhigh` added on gpt-5.2 / 5.2-codex / 5.1-codex-max; gpt-5-pro `high` only; gpt-5.2-pro `medium`–`xhigh`; gpt-5-codex and the 5.1 codex lines `low`–`high`; gpt-5-search-api and o1-mini take no effort; codex-mini-latest is `'always'`. Models whose ladder includes `none` are `'optional'`. Where Azure and OpenRouter disagree on `none` (gpt-5.1-codex-max) or the page contradicts OpenRouter (gpt-5.3-codex), the safe side won: no `none`
    - OpenAI entries added: gpt-6.1-sol (no `none` / `minimal`), gpt-5.5, gpt-5.5-pro, gpt-5.4-pro / -mini / -nano, gpt-5.3-codex, gpt-5.3-chat-latest. Each has an exact id, a `5.x` + postfix fuzz that outranks the `gpt-5` + postfix ones, and a prefix for dated snapshots. gpt-5.4 moved to its real 1.05M context with the >272K rates recorded
    - xAI: grok-4.7 `low`–`xhigh`; grok-4.5 `low`–`high` (cache read corrected to $0.30); grok-4.6 (`'always'`, `low`–`xhigh`) and grok-4.3 (`'optional'`, `none`–`xhigh`) added. Their >200K rates aren't on the model pages, so they aren't recorded
    - Anthropic: Opus 4.5 lists `low` / `medium` / `high`, and both `anthropicClient` and Bedrock now send effort beside `budget_tokens` on a model without adaptive. 4.6+ in budget mode (deprecated) still sends none
    - Google: Gemini 3.1 Pro `low`–`high`; Gemini 3.x and 2.5 Pro are `'always'`
    - Doubao: all six seed entries `low` / `medium` / `high`
  - [ ] Left from that audit: o3-deep-research / o4-mini-deep-research ladders unverified (a Codex issue says o3-deep-research rejects `high`); computer-use-preview still `'none'` (it reasons, but takes only `concise` summaries and needs the computer tool we don't offer); gpt-5.6-\*-pro and grok-4.20-multi-agent are on OpenRouter only, with no official page; BytePlus Doubao ids and doubao-seed-2-1-lite / -turbo / -evolving have no entries; claude-sonnet-5-5 falls to the Sonnet 5 entry
  - [ ] Chat Completions tool calling: gpt-6-sol / -luna allow function calling there only at `reasoning_effort: none`, and gpt-6.1-sol not at all ("Use the Responses API for tool calling")
  - [x] Toggle off means "no reasoning where the model allows it, else the least it allows", on every client. Before, most clients just omitted the field, and a model that reasons by default kept reasoning at its default effort (gpt-6-sol at `medium`, Kimi K3 at `max`, Gemini 2.5 Flash dynamic, Opus 5 / Sonnet 5 adaptive):
    - `openai` dialect and the Responses effort path: `effortWhenOff` (`shared/engine/lib/reasoningEffort.ts`) sends `none` where the ladder has it, else the lowest level; nothing without a ladder. OpenRouter keeps `{ enabled: false }`, and an `'always'` endpoint gets `{ effort: lowest }` instead of nothing
    - Anthropic: `thinkingOffType` metadata (`'disabled'` on Opus 5 and Sonnet 5, which think by default) sends `thinking: {type: 'disabled'}`, without `clear_thinking` context editing. Always-on models (Fable 5 / 5.1, Opus 5.5, and Sonnet 5.5 for now) are `reasoningMode: 'always'` and get `output_config.effort: low`. Default-off models still just omit `thinking`. Bedrock's Claude 4 config does the same, but see the metadata item below
    - Agent SDK: `disabled` is no longer sent to always-on models, which 400 on it; they get effort `low`. On Opus 5 / Sonnet 5 the effort beside `disabled` is capped at `high` (Opus 5 rejects the pair at `xhigh` / `max`)
    - Google: `resolveThinkingOff` sends `thinkingBudget: 0` to 2.5 Flash / Flash-Lite, 128 (the floor) to 2.5 Pro, and the lowest `thinkingLevel` to everything from Gemini 3 on; nothing for unknown or non-thinking models
  - [x] Gemini 4 Argon (`gemini-4-argon`, 2026-10-13): metadata added (`low`–`high`, `'always'`, 65,536 output). `usesThinkingLevel` in `googleClient.ts` used to match `gemini-3` and sent everything else a `thinkingBudget`, which Argon 400s on ("Thinking budget is not supported for this model"). It now matches the budget generations (`gemini-1.` / `gemini-2.`) instead, so new generations and aliases like `gemini-pro-latest` get a level by default
  - [ ] Gemini 4 Argon long decode (output past 65,536, up to 1M) needs background execution; `googleClient` only streams synchronously, so it's capped at 65,536
  - [ ] `supportsTemperature` is metadata only: no client reads it. Harmless on Argon (it ignores temperature, top_p and top_k), but a model that rejects temperature would still get it from `googleClient` whenever reasoning is off
  - [ ] Sonnet 5.5's off switch is `thinking: {type: 'between_tools'}`, not `disabled` (which it rejects). Not wired: the Agent SDK's `ThinkingConfig` has no such type until an SDK upgrade, so Sonnet 5.5 is `'always'` for now (toggle off → effort `low`). Wire it on the Anthropic client and Bedrock, and on the Agent SDK after the upgrade; it rejects `xhigh` / `max` effort beside it
  - [ ] Bedrock gets no model metadata at all: no knowledge entry lists the `bedrock` apiType, and Bedrock ids (`us.anthropic.claude-opus-4-7`, `anthropic.claude-opus-4-6-v1`) carry region prefixes and version suffixes the Claude prefixes don't expect. So adaptive-only, effort levels, the toggle-off rules and prices never reach Bedrock; a thinking budget on Opus 4.7+ there goes out as `enabled`, which those models reject. Fix: borrow the Anthropic entries for `bedrock` (as `chatgpt-subscription` borrows `responses_api`) and normalize the id first
  - [ ] Kimi K2.x `thinking: {type, keep}` is per the Kimi docs and unverified on the platform API (the coding plan serves only kimi-for-coding and K3). If the platform rejects it, set the definition's dialect to `enable-thinking` with the override on
- [ ] Reasoning provenance — `modelFamily` is the only discriminator at every replay site, so opaque reasoning crosses backends that share a wire format: Responses `encrypted_content` (OpenAI, xAI, OpenRouter, Ark, vLLM all stamp `responses_api`), OpenRouter `reasoning_details` signatures (see Known Issues), and Anthropic thinking signatures sent to Anthropic-compatible endpoints (DeepSeek, Kimi, GLM and MiniMax each serve one). Plan: stamp the producing endpoint on assistant messages (base URL or a hash of it, plus the model) and treat a mismatch as incompatible — strip the signed/encrypted parts. Applies to every client. Open: whether foreign plain-text reasoning goes out as `reasoning_text` or is dropped
- [x] Pricing display in Model Selector
- [x] Cache pricing fallback (cache tokens priced at inputPrice when no cache-specific price)
- [x] Cache pricing display
- [ ] Script to automatically parse pricing data from api provider's pricing page
- [ ] Time-boxed introductory pricing is recorded as the current rate with a comment, not modeled — `gemini-4-argon` is at 2 / 10 in-out (0.1 cache read) until 2026-11-30 and must be bumped to 4 / 20 (0.2) by hand on 2026-12-01; `gemini-3.7-flash` and `gemini-3.8-flash` are at 0.75 / 3.75 in-out (0.075 cache read) until 2026-12-31 and must be bumped to 1.5 / 7.5 (0.15) by hand on 2027-01-01
- [ ] Context-length-tiered pricing — higher tiers are recorded in `unsupportedHighContextPricing` (e.g. Qwen ≥256K) but `calculateCost` always bills the base (sub-threshold) tier
- [ ] Record the >272K tier for the gpt-5.6 family (2x input/cache, 1.5x output, as on gpt-6) — the gpt-6 entries have `unsupportedHighContextPricing`, the 5.6 ones don't
- [ ] Provider price cuts go unnoticed — the gpt-5.6 rows sat at launch prices through the 2026-07-30 cut (Luna was 5x over) until a check against OpenAI's pricing page caught it. Worth a periodic re-check of the whole `model_metadatas/` set, or the parse-pricing-page script below
- [ ] Sweep `model_metadatas/*` for prefix entries that shadow a family's newest-model catch-all. Adding `claude-opus-5` surfaced the shape: a bare version prefix (`claude-opus-5`) also matches every future `claude-opus-5-x`, pinning them to the older entry instead of letting the catch-all hand them the newest profile. Fixed there with an exact id + a year-scoped fuzz (`claude-opus-5-2026`, the idiom already used for `claude-opus-4-2025`). Same shape to check: `claude-sonnet-5`, `claude-haiku-5`, `gpt-6-astra`, `grok-4`, `mimo-v2.6-pro` (the last one already needs its `-ultraspeed` entry to avoid pricing 10x low)
- [ ] Anthropic 1M context is no longer a beta opt-in — Opus 5.5 / 5, Fable 5/5.1, Opus 4.6-4.8, Sonnet 4.6/5 all serve 1M by default with no `context-1m-2025-08-07` header. The new Opus 5.5 / 5 entries record `contextWindow: 1000000` with no `supportsExtendedContext`, but Opus 4.6-4.8 and Sonnet 4.6/5 still carry 200K + the flag. Flipping them changes what the per-project Extended Context toggle does, so it needs a deliberate pass over the toggle and `claudeAgentExtendedContext.ts` (whose `[1m]`-suffix list is a separate question: the Agent SDK still reports ids like `claude-opus-5[1m]`)
- [ ] `CLAUDE_AGENT_MODELS` in `claudeAgentClient.ts` is hand-maintained and drifts — `claude-sonnet-5` and `claude-haiku-5` have metadata entries but are still missing from the list
- [x] Minion loop-options parity — `minionTool.ts` builds its own `AgenticLoopOptions` literal rather than inheriting the parent's, so every project-level knob must be threaded explicitly there. Audited field-by-field against `buildLoopOptions.ts`. The remaining divergences are deliberate: `preFillResponse` (minions don't prefill), `webSearchEnabled` / `enabledTools` / `toolOptions` / `systemPrompt` (minion-scoped), and `checkpointMessageIds` / `activeHook` (chat-derived, no `MinionChat` equivalent).

**Statistics & Display**

- [x] Token display formatting (##.#k format, grouped by direction: `↑(123, C↑101, C↓202) ↓(456, R:789)`)
- [x] Reasoning/text output split — providers report reasoning inclusive in output (`output_tokens_details`: `reasoning_tokens` on OpenAI, `thinking_tokens` on Anthropic + claude-agent); every adapter subtracts it out so app-internal `outputTokens` is text-only and `reasoningTokens` is the disjoint sibling (priced separately, `reasoningPrice` fallback to `outputPrice`). Bedrock Converse exposes no breakdown — no split there.
- [x] Cost display precision (3 decimals)
- [x] Chat-level token totals (cumulative)
- [x] Context window usage (recalculated)
- [x] Real-time token usage in chat header
- [x] Incremental cost/token persistence during agent loop (crash-resilient)
- [x] Fork tracking and cost analysis
- [x] Tool call cost tracking (minion sub-agent costs flow into chat totals)
- [x] Minion chat view (overlay, accessible via "View Chat" button in tool result; main chat continues streaming underneath; per-message delete for manual restoration). For claude-agent minions the single-message delete + user-message rollback/fork are hidden, and rollback persists the SDK `{sessionId, resumeAt}` pair (see Claude Agent Provider → Minion integration)

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

- Multiple API definitions per provider type (APIType: `responses_api`, `chatgpt`, `anthropic`, `bedrock`, `google`, `claude-agent`, `chatgpt-subscription`, `ds01-dummy-system`)
- Each definition: name, icon (optional emoji), baseUrl (optional), apiKey (not required when `isLocal` is true, or for the subscription types — see `apiKeyOptional`)
- `oauth` (optional, `chatgpt-subscription` only) — Codex-login tokens `{ accessToken, refreshToken, idToken?, expiresAt, accountId, planType?, email? }`. Backend-owned: `saveAPIDefinition` always keeps the stored block over the caller's copy (see ChatGPT Subscription Provider)
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
- **Reasoning effort**: shared control across providers — Nova maps to its own 3-level scale, everything else clamps to the model's `supportedReasoningEfforts` (an unlisted level between two listed ones rounds up, as the vendors do); Anthropic sends it as adaptive `output_config.effort`. Gemini 3 onward maps the clamped effort to `thinkingConfig.thinkingLevel` (`resolveThinkingLevel` in `googleClient.ts`); with no effort picked the field is omitted so each model's own default applies (MEDIUM on 3.7 Flash, HIGH on 3 Pro). Clamping matters because Gemini rejects an out-of-range level outright — 3.7 Flash fails the request on `MINIMAL`
- **OpenAI/Responses reasoning**: summary (`undefined` = auto)
- **Web search** toggle
- **Message format**: three modes (user message / with metadata / use template)
- **Tools**: Memory (Anthropic only), JavaScript Execution, Filesystem, Sketchbook, Checkpoint, Metadata, DUMMY
- **Advanced** (collapsed): temperature, max output tokens (default: 1536), disable streaming, extended context (1M), verbosity (OpenAI only)
- **Tool option `visibleWhen`**: conditional visibility — options can depend on sibling option values (e.g., deferred return settings only shown when deferReturn is on)

### Chats

- Organized under projects, inherit project settings
- Can override API definition/model per chat
- Store message history with metadata (tokens, model, timestamps)
- Track cumulative token totals
- `summary?: string` — AI-settable chat summary (via metadata tool)
- `activeHook?: string` — DUMMY System hook name active for this chat
- `agentConfig?: ChatAgentConfig` — chat-level agent-identity overrides (below)

#### Chat-level agent config

`Chat.agentConfig` is an override layer resolved between the project defaults
and the runtime loop options by `resolveChatAgentSettings`
(`src/shared/engine/lib/resolveChatAgentConfig.ts`), consumed in
`buildAgenticLoopOptionsForContext`. Edited from **⋯ → Chat Settings**
(`ChatSettingsPanel`), and derived automatically when a minion chat is cloned.

| Field                                                                                                                         | Resolution                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `systemPromptMode`                                                                                                            | `'project'` (default) / `'replace'` / `'append'`                             |
| `persona`, `prePersonaSystemPromptFile`, `systemPromptFile`, `systemPrompt`                                                   | prompt sources, resolved per turn from the VFS by `resolveAgentSystemPrompt` |
| `namespace`                                                                                                                   | VFS namespace for every file-touching tool; `''`/absent = root               |
| `enabledTools`                                                                                                                | **intersected** with `project.enabledTools` — the project is the ceiling     |
| `temperature`, `maxOutputTokens`, `webSearchEnabled`, `fileLineNumbers`, `nudgeThinking`                                      | `agent ?? project`                                                           |
| `enableReasoning`, `reasoningBudgetTokens`, `reasoningEffort`, `verbosity`, `thinkingKeepTurns`, `pruneThinkingBeforeApiCall` | `agent ?? project`                                                           |

Three prompt modes: `'project'` skips the chat's prompt sources entirely and
reads no VFS file, so a chat with no `agentConfig` resolves to exactly the
option values it did before this feature (the two added keys, `namespace` and
`fileLineNumbers`, are `undefined` there — which is what the loop read anyway);
`'replace'` drops `project.systemPrompt`; `'append'` puts the project's first. Tool system prompts are appended after
whichever base wins.

Rules worth not rediscovering:

- **`''` is a value, not "inherit"** for `prePersonaSystemPromptFile` (disables
  the pre-persona read) and `nudgeThinking` (disables the nudge). `namespace` is
  the exception — projects have no namespace, so `''` and absent both mean root.
- **Do not teach `patchChat` to deep-merge.** The layer is one nested object
  precisely so `patchChat`'s shallow spread replaces it wholesale: the settings
  form submits the full bundle and omission means cleared, with no per-field
  `unset` bookkeeping. Deep-merging would make sub-field clears inexpressible.
  Clearing the layer is `unset: ['agentConfig']`.
- **Not overridable at chat level** (transport/provider knobs, not agent
  identity): `preFillResponse`, `disableStream`, `extendedContext`,
  `useAnthropicOneHourCache`, `noLineNumbers`, `cacheRoutingScope`,
  `reasoningSummary`, `flexTierEnabled`, `toolOptions`.
- **Tool options stay project-level.** `getSystemPrompts` and the definition
  builder both filter by the enabled-name list, so a narrowed `enabledTools`
  already narrows the injected prompts and the exposed schema. Per-tool option
  editing in the chat panel is deliberately out of scope.
- A missing persona file fails the turn with `CHAT_AGENT_PROMPT_UNRESOLVED`
  (raised before `loop_started`). Silently falling back to the project prompt
  would run the agent under the wrong identity with no visible signal.
- `previewChatSystemPrompt` resolves the prompt server-side for the panel's
  preview, including unsaved drafts via its `overrides` param. Do not
  reassemble it in React — the join order and error semantics keep evolving.

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
│   ├── nodeEntry.ts           # Server entry — CLI args (--instance-env), config, GremlinServer, WebSocket listener
│   ├── envFile.ts             # CLI parsing + env-file loading (multi-instance: one env file per instance; not --env-file — Node intercepts that flag even after the script path)
│   ├── config.ts              # Env-based config (PORT, STORAGE_PATH, VFS_MODE, etc.); baseDir resolves relative paths under --instance-env
│   ├── websocketTransport.ts  # Server-side ws handler — dispatches to GremlinServer
│   ├── installLogTimestamps.ts # Prefix every console.* line with an ISO timestamp (server only)
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

- **`src/shared/protocol/`** — Phase 1.7 split the original 967-line `protocol.ts` into focused files: `wire.ts` (envelopes, identifiers, helper types), `errors.ts` (`ProtocolErrorCode` union), `events.ts` (LoopEvent, ActiveLoopsChange, Export/Import progress, project bundle, VFS compact stream payloads), `methods.ts` (the `GremlinMethods` registry plus per-method param/result types), and `protocol.ts` (now a barrel re-exporting from the four files for backward-compatible imports). `protocolError.ts` carries the `ProtocolError` exception class so destructive-op guards can construct it without a circular import on the dispatcher. `types/` holds the application data models (Chat, Project, Message, content blocks, ToolContext, VfsAdapter, etc.) that Phase 1.7 hoisted out of the top-level `src/types/` — every layer now imports them from `@shared/protocol/types` (or relative equivalents). `binaryEncoding.ts` provides the JSON replacer/reviver pair used by both WebSocket transports: `Uint8Array`/`ArrayBuffer` encode as `{__b64}`, `Date` encodes as `{__date}` and revives only from that marker (plus a legacy fallback reviving bare ISO strings on the known Date-field keys `timestamp`/`chatTimestamp`/`createdAt`/`updatedAt`/`lastModifiedAt`/`lastUsedAt`) — string fields whose _value_ looks like a timestamp are never converted, since a revived `Date` in a string-typed render field crashes React (#31). An Invalid Date serializes as `null` (matching plain `Date.toJSON()`) instead of letting `toISOString()` throw and kill the whole envelope send. The worker transport uses structured clone and needs none of this.
- **`src/shared/engine/`** — `GremlinServer` (method dispatcher; supports deferred mode where `_deps` is `null` until `init({cek})` arrives), `ChatRunner` (per-loop wrapper around `runAgenticLoop`, fires `message_created` for synthesized user messages, enforces incomplete-tail lock + soft-stop via `LoopRegistry.isSoftStopRequested`), `LoopRegistry` (also caches per-chat replay state for `attachChat` mid-stream reattach: in-flight `pending_tool_result` + merged `tool_block_update` state, replayed as the in-progress tool UI; and the latest `streaming_chunk` groups, replayed as a `streaming_snapshot` so the partially-streamed assistant bubble rehydrates immediately instead of going blank until the next token — matters most for claude-agent, whose single `sendMessageStream` spans a whole multi-tool SDK turn with long no-token gaps. Streaming groups cleared on the assistant `message_created` that supersedes them; pending-tool entries on their matching `message_created`; both as a safety net on `loop_ended`), `buildLoopOptions.ts` + `messageMetadata.ts`, `cloneMinionChat.ts` (promote a minion transcript into a `Chat`), `exportRunner.ts` + `importRunner.ts`, `dataExport.ts` + `dataImport.ts` + `projectBundle.ts`, `transports/inProcess.ts` (the in-process `Transport` interface + `InProcessTransport` implementation). Streaming methods wired: `runLoop`, `subscribeActiveLoops`, `attachChat`, `exportData`, `importData`, `vfsCompactProject`.
- **`src/shared/services/`** — agentic loop, API clients + stream mappers, compression, encryption (`EncryptionCore`, the only encryption flavor that exists), storage (`UnifiedStorage` + `CachedStorageAdapter` decorator + the `StorageAdapter` interface — the browser-only inner adapters now live under `src/worker/adapters/`), streaming assembler, tools, VFS (`LocalVfsAdapter` + `treeLock` + `vfsService` — `RemoteVfsAdapter` and the per-project dispatch live under `src/worker/adapters/`).
- **`src/frontend/`** — `App.tsx`, `main.tsx`, `components/`, `hooks/`, `contexts/`, `client/` (GremlinClient + GremlinSession + ActiveLoopsStore + bootstrapClient + worker transport), `lib/` (frontend-only helpers). The main thread no longer constructs an encryption instance — OOBE / Data Manager use `src/frontend/lib/localStorageBoot.ts` to read/write the CEK string and the dormant-callable RPCs (`generateNewCEK`, `normalizeCEK`, `deriveUserIdFromCEK`) on `gremlinClient` for format conversions, then post the string through `gremlinClient.init({cek})`.
- **`src/worker/gremlinWorker.ts`** + **`src/worker/workerHandler.ts`** — Web Worker entry is a two-line bootstrap passing `self` to `createWorkerHandler(scope)`. The handler (extracted for testability) boots dormant, calls `setBootstrapAdapterFactories` (registers `createStorageAdapter` and `createVfsAdapter` from `src/worker/adapters/`), then accepts a non-protocol `worker_config` envelope for the storage config and handles a typed `init({cek})` to bring up encryption + storage + the rest of the engine. Stream vs one-shot dispatch uses the shared `STREAM_METHODS` set from `src/shared/protocol/streamMethods.ts` (compile-time exhaustiveness check against `GremlinMethods`).
- **`src/worker/adapters/`** — browser-only adapter implementations + worker-side factories. Files: `IndexedDBAdapter.ts`, `RemoteStorageAdapter.ts`, `RemoteVfsAdapter.ts`, `createStorageAdapter.ts` (config → `CachedStorageAdapter`-wrapped inner adapter), `createVfsAdapter.ts` (project → `LocalVfsAdapter` or `RemoteVfsAdapter`). Phase 1.65 hoisted these out of `src/shared/` so the shared layer's lint rules can ban `indexedDB` / `navigator`.
- **`src/frontend/client/`** — `GremlinClient` (typed RPC facade exposing every protocol method, plus `exportToBlob` / `importFromBytes` / `vfsCompactProject` / `configureWorker` / `onReconnect` helpers), `GremlinSession` (per-chat session adapter; registers `onReconnect` to re-attach the `attachChat` stream after WebSocket reconnect), `ActiveLoopsStore`, `bootstrapClient.ts` (reads CEK + storage config from localStorage, derives userId for remote configs, calls `gremlinClient.configureWorker(storageConfig)` — skipped for `server` mode — then `gremlinClient.init({cek})` before React mounts), `transports/worker.ts` (`WorkerTransport` — waits for `worker_ready`, posts `worker_config` ahead of `init`, queues every non-`init` request until `init` succeeds, sends `stream_cancel` on consumer-side `break`), `transports/websocket.ts` (`WebSocketTransport` — see **WebSocket Anti-Zombie System** section below for heartbeat, stale detection, visibility probe, and `ConnectionStatusBanner`). The singleton `gremlinClient` holds a lazy transport factory: `{ type: 'server' }` → `WebSocketTransport`, otherwise `WorkerTransport`, resolved from `getStorageConfig()` on the FIRST RPC (never at module eval — `onReconnect` / `onConnectionStateChange` register into client-owned registries that survive rebinds and construct nothing). Flows that change the storage config at runtime (OOBE) call `rebindGremlinTransport(config)` after persisting it: disposes the old transport, builds a fresh one, keeps subscribers wired. OOBE's server path validates + probes the wsUrl first (`src/frontend/lib/wsProbe.ts`: `normalizeWsUrl` + `probeGremlinServer` raw ping/pong, plus a Test Connection button) and restores the pre-attempt storage config on failure.

#### WebSocket Anti-Zombie System

Detects and recovers from dead/zombie WebSocket connections — the kind that look `OPEN` but silently swallow messages. Applies only to server-mode (`WebSocketTransport`); worker transport is unaffected.

**Problem:** When the user backgrounds the tab (app switch, laptop sleep), the OS may suspend the socket. On return the socket's `readyState` still reads `OPEN`, but it's dead — messages sent into it vanish. The user sees nothing wrong, clicks send, and the message goes to void.

**Detection layers** (all in `src/frontend/client/transports/websocket.ts`):

| Layer               | Timing                                               | What it does                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Heartbeat ping/pong | every 2s (`HEARTBEAT_INTERVAL_MS`)                   | Sends `{ kind: 'ping' }`, server replies `{ kind: 'pong' }`. Any incoming message resets the timeout via `onPong()`.                                                                       |
| Stale detection     | 8s without any server message (`STALE_THRESHOLD_MS`) | Checked inside the heartbeat interval. Sets `ConnectionState` to `'stale'` — banner warns user before they click send. Clears automatically when a pong arrives.                           |
| Dead detection      | 15s pong timeout (`HEARTBEAT_TIMEOUT_MS`)            | If the stale warning didn't clear, socket is closed → triggers reconnect. Generous on purpose — synchronous better-sqlite3 import phases can stall pongs well past 5s on a healthy socket. |
| Visibility probe    | on `document.visibilitychange` → `'visible'`         | Sends an immediate ping + arms the pong timeout. Catches zombie sockets within seconds of tab-resume instead of waiting for the next 2s heartbeat tick.                                    |

**State machine** (`ConnectionState` in `src/shared/protocol/transport.ts`):

```
connecting → connected ⇄ stale → disconnected → reconnecting → connected
                                                      ↑              │
                                                      └──────────────┘
any state → auth_failed (terminal)
```

- `connecting` — initial WebSocket handshake (first connection only)
- `connected` — socket open, pongs arriving
- `stale` — no pong for >4s, banner warns user (may self-heal if pong arrives)
- `disconnected` — socket closed, in-flight streams terminated, one-shot requests queued for retry
- `reconnecting` — backoff timer scheduled or `new WebSocket()` in progress
- `auth_failed` — terminal: the server rejected the replayed/initial `init` with `CEK_MISMATCH` / `CEK_REQUIRED`. All pendings rejected, reconnect loop stopped (retrying the same key can only 4001 again); recovery is a transport rebind or reload with corrected credentials. Banner: "The server rejected the stored encryption key — reload the page to re-authenticate"

**Reconnect resilience:**

- Exponential backoff: 1s → 30s (`INITIAL_BACKOFF_MS` / `MAX_BACKOFF_MS`)
- **Init replay on reconnect:** transport saves `lastInitParams` on first successful `init` and replays it as the first message after reconnect, then **awaits the ack** before firing reconnect callbacks or replaying anything else — the server's per-connection auth gate 4001s any non-exempt frame arriving before its socket's init resolves (ordering-contract test in `src/server/__tests__/websocketTransport.test.ts`). Server-side `init` is idempotent with the same CEK. A never-inited transport (mid-OOBE drop) replays its in-flight exempt envelopes directly.
- One-shot requests survive any number of disconnects: an envelope stays in `inflightEnvelopes` until its promise settles and `replayPending()` re-sends from there after each re-auth (no separate retry queue to fall out of)
- **Failed init doesn't wedge the gate**: both transports reject queued waiters, then re-arm a fresh init gate so a retried `init` in the same session works (the worker transport used to replay the stale rejection forever — the reason OOBE import mode could never recover without a reload). A malformed `wsUrl` rejects the connect gate instead of throwing in the constructor (no more blank page).
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
- `HEARTBEAT_TIMEOUT_MS` (15s) — pong deadline before socket is closed.
- `STALE_THRESHOLD_MS` (8s) — show warning banner before full disconnect.
- `INITIAL_BACKOFF_MS` (1s) / `MAX_BACKOFF_MS` (30s) — reconnect backoff range.

**Possible follow-up approaches to try:**

- [ ] Queue outbound messages during `stale` state instead of letting them hit the maybe-dead socket (currently `send()` still fires if `readyState === OPEN`)
- [ ] Disable the send button / show inline warning in ChatInput when stale or disconnected
- [ ] Server-side dead-client detection (server pings client, closes if no pong — currently server is passive)
- [ ] Periodic yields (`setImmediate`) inside the server's synchronous import / VFS-migration loops so pongs flow during long imports (the 15s timeout is generous headroom, not a root fix)
- [ ] Adaptive heartbeat interval (slower when tab is hidden to save battery, faster on resume)

- **`src/frontend/components/activeLoops/`** — `RunningLoopsSection.tsx` + `ActiveLoopRow.tsx`. Mounted in `Sidebar.tsx`, project-agnostic. The chat view's soft-stop stays; hard abort lives only in the sidebar (as a STOP button), while a soft-stop in progress renders as an amber "stopping…" pip/label on the row (read from `ActiveLoop.softStopRequested`) — no per-row soft-stop button. Minion sub-loops register themselves on the per-server `LoopRegistry` from inside `executeMinion` (parent chat id, parent loopId, persona/displayName label) so they appear as indented child rows under the parent and the STOP button can hard-abort one without touching its siblings. `RunningLoopsSection` renders the loops as a tree of arbitrary depth (recursive walk over `parentLoopId`, depth-based indent in `ActiveLoopRow`) so nested minions (minion-of-minion, see Minion Tool → Nested minions) nest correctly instead of being orphaned. Each child has its own `AbortController`; aborting the parent cascades to every child via a one-shot `addEventListener('abort', ...)` listener wired in the minion tool, but child → parent abort is intentionally unidirectional. `BackendDeps.loopRegistry` is the same instance held by `GremlinServer.registry` — threaded through `ToolContext.loopRegistry` so tools never reach for the server directly.
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
- **CEK init-over-RPC**: the worker boots dormant. `src/frontend/main.tsx` awaits `bootstrap()` (in `src/frontend/client/bootstrapClient.ts`) which reads the CEK string + storage config from localStorage, derives userId for remote configs via the dormant-callable `gremlinClient.deriveUserIdFromCEK(cekString)` RPC, then calls `gremlinClient.configureWorker(storageConfig)` followed by `gremlinClient.init({cek: cekString})`. The worker stashes the storage config via `setBootstrapStorageConfig` (driven by the non-protocol `worker_config` envelope) and constructs `EncryptionCore` + `UnifiedStorage` from `params.cek` and the stashed config. OOBE writes localStorage on its own and calls `configureWorker` + `init` directly. Data Manager uses `gremlinClient.clearCek()` + `clearCachedCEK()` for detach. CEK rotation uses `gremlinClient.rotateCek({newCek})` which spins up a temp `EncryptionCore` for the new key, runs a validation pass (every row must decrypt under the active core before anything is rewritten — a corrupt row aborts non-destructively), then walks every table via `exportPaginated`, re-encrypting each row byte-exactly (`decryptToBytes` → `encryptBytes`, so compressed rows stay compressed and plain rows stay plain), and `batchSave`s the rotated rows. Afterwards the server transitions to dormant (forgets the active core, drops the deps bundle) so the frontend reconnects with a fresh `init` carrying the new CEK. There is no rotation UI yet — a caller (console or future Data Manager flow) must persist the new CEK to localStorage itself before the next reload, or the oracle check fails with `CEK_MISMATCH`.
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
- Tables: `api_definitions`, `models_cache`, `projects`, `chats`, `minion_chats`, `messages`, `attachments`, `app_metadata`, `vfs_meta`, `vfs_files`, `vfs_versions` (memories live in VFS under `/memories`, not in their own tables)
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
- Re-encryption workflow: decrypt with source CEK → re-encrypt with app CEK. Raw-bytes round-trip (`decryptToBytes` → `encryptBytes`) so compressed rows (VFS, messages, models_cache) survive byte-exactly — a text round-trip would destroy their gzip payload
- Migration ("replace") mode wipes current data (tables AND VFS backends via `clearAllVfsBackends` — filesystem/remote VFS files live outside the tables) and re-encrypts the restored rows under the CURRENT app CEK; the source CEK only decrypts the backup and is never persisted
- Duplicate ID handling: skip existing records, except for unconfigured API definitions (overwrite allowed)
- Default API definitions: exported only if configured (`isConfiguredApiDefinition` in `shared/protocol/apiDefinition.ts` — any field beyond the factory template counts: apiKey, non-factory baseUrl, isLocal, proxy, models endpoint, extra model ids, CLI overrides, icon, advanced settings); imported with merge logic (overwrite when the local one is unconfigured, seeded factory baseUrls counting as unconfigured)
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
- `reasoningBudgetTokens: number` - Anthropic: budget for thinking. 0 + `supportsAdaptiveReasoning` = adaptive mode. Models with `onlyAdaptiveReasoning` (Opus 4.7+) force adaptive regardless of this value. Also read by the `openrouter` reasoning dialect, but only when no effort is picked — see Reasoning dialects.
- `thinkingKeepTurns?: number` - Anthropic: thinking block preservation (`undefined` = model default, `-1` = keep all, `0+` = keep N turns). Opus 4.5 keeps all by default; others keep 1 turn. Chat Completions / Responses: `-1` and `2+` turn on the model's `reasoningHistoryParam` (see Reasoning dialects).
- `reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` - reasoning effort level (`undefined` = auto). Clamped per model against `supportedReasoningEfforts` metadata: OpenAI/xAI via `mapReasoningEffort()`, Claude via `mapAnthropicEffort()` (both in `src/shared/engine/lib/reasoningEffort.ts`).
- `reasoningSummary?: 'auto' | 'concise' | 'detailed'` - OpenAI/Responses: summary mode (`undefined` = auto). On Anthropic/Bedrock Claude and claude-agent, any non-`undefined` value opts into `thinking.display: 'summarized'` (needed on Opus 4.7+ / Claude 5, which default to `'omitted'` — that default also strips mid-loop narration blocks, so claude-agent tool turns look textless without it).
- `verbosity?: 'low' | 'medium' | 'high'` - OpenAI: response-length control, independent of `maxTokens` and reasoning effort (`undefined` = model default). Responses API nests it as `text: { verbosity }`; Chat Completions takes it top-level. Both clients drop it unless the resolved model carries `supportsVerbosity` (GPT-5 family only — older models reject the param), so a project-wide default is safe on mixed model sets. Other providers ignore it.
- `systemPrompt?: string` - System prompt
- `preFillResponse?: string` - Pre-fill assistant response (Anthropic only)
- `webSearchEnabled?: boolean` - Enable web search
- `enabledTools?: string[]` - Enabled client-side tools
- `extendedContext?: boolean` - Anthropic: opt into 1M context window beta (`context-1m-2025-08-07` header). Models with `supportsExtendedContext` in metadata: Opus 4.6, Sonnet 4.5, Sonnet 4. Above 200K input tokens, all tokens charged at premium rates (2x input, 1.5x output). Toggle is always visible in project settings; the beta header is only sent at runtime when the effective model supports it (gated in `agenticLoopGenerator`). **claude-agent has no `betas` array** — it opts into 1M via a `[1m]` model-id suffix instead (see Claude Agent Provider → 1M context), routed through a separate gate (`supportsClaudeAgent1mContext`) with its own eligible set. `agenticLoopGenerator` forwards a pre-gated `claudeAgentExtendedContext?: boolean` and reports a 1M `contextWindow` when it (or `effectiveExtendedContext`) is set.
- `useAnthropicOneHourCache?: boolean` - Anthropic: emit `cache_control: { type: 'ephemeral', ttl: '1h' }` on all breakpoints (system prompt, sliding tail, stable anchor). Default off → omits `ttl` and Anthropic uses its 5m default. Honored only when `apiDef.apiType === 'anthropic'`. Cost accounting multiplies `cacheWritePrice` by 1.6× (2/1.25) when on, since stored prices assume the 5m write multiplier; cache-read prices are unchanged.
- `checkpointMessageId?: string` - Context tidy: computed tidy boundary ID (triggers pre-checkpoint trimming)
- `tidyToolNames?: Set<string>` - Context tidy: tool names whose blocks should be removed from pre-checkpoint messages

**API Clients:**

- Base client with shared streaming logic
- `ResponsesClient` (OpenAI Responses API with reasoning, vision, web search)
  - Hosted web search rides the `buildWebSearchTool` hook: `{ type: 'web_search' }` by default, or the legacy `web_search_preview` alias when a model's `webSearchTool` metadata asks for it. The alias is 400-rejected by the GPT-5 family and the ChatGPT/Codex backend, so it is opt-in per model/endpoint, not the default.
  - `supportsNonStreaming()` decides whether the project's disable-streaming toggle is honored; backends that only speak SSE override it to `false`.
  - Client-side tool overrides are looked up under `this.ownFamily`, so a subclass gets its own `APIToolOverrides` slot.
  - `requestHeaders()` supplies per-request headers on top of the SDK client's defaults. One options object feeds all three request paths (accumulator, `finalResponse`, non-streaming) so they cannot drift.
- `OpenAIClient` (Chat Completions with o-series/GPT-5 support — see Chat Completions reasoning round-trip)
- `AnthropicClient` (thinking blocks, prompt caching, web search/fetch, citations, Bedrock via `@anthropic-ai/bedrock-sdk` - see below)
- `BedrockClient` (AWS Bedrock Converse API for non-Claude models - see Bedrock Client section below)
- `ClaudeAgentClient` (`@anthropic-ai/claude-agent-sdk`, server-mode only — see Claude Agent Provider section below)
- `ChatgptSubscriptionClient` (extends `ResponsesClient`; ChatGPT backend + Codex-login OAuth, both modes — see ChatGPT Subscription Provider section below)

### Stream termination

`mapStopReason` (`shared/engine/lib/apiHelpers.ts`) turns a missing stop reason into `end_turn`, so every client has to report how its stream actually ended. Two outcomes, following the claude-agent convention:

- **Truncation keeps the turn.** The partial text stands and `stopReason` carries the reason (`max_tokens` → ⚠️ Truncated badge, `content_filter` → 🚫 Filtered, anything else as-is). Minions rewind through their abnormal-stop gate. An abnormal reason always wins over `tool_use`, so a truncated call never runs.
- **No terminal signal, or a failure, is a turn error** (`result.error`; the loop's `finalizeWithError` keeps the streamed blocks). Tool calls from a cut-off stream are dropped from `fullContent` — they never ran, and replaying them without results would 400.

Per client:

- **Responses** — `responsesStopReason` (`responsesStreamMapper.ts`) reads the terminal response: `completed` → `tool_use` / nothing; `incomplete` → `max_tokens` for `max_output_tokens`, else the reason (or `incomplete`); `cancelled` → `cancelled`; `failed`, a spec `error` event (`{ code, message }`, which the SDK doesn't throw on), no terminal event, or a status still `in_progress` / `queued` → throw, which the client's catch turns into an error result. A missing `status` counts as completed (some providers omit it). `terminalResponseOf` normalizes the four terminal events for both the mapper state and the accumulator; usage is read from all three `response.*` terminals, not just `completed`. On the default path the SDK's `ResponseStream` adopts the terminal response only on `response.completed` and never applies `output_item.done`, so after `response.incomplete` its `finalResponse()` is the stale `response.created` snapshot — the client lays the terminal response (status, `incomplete_details`, `error`, usage, and `output` when non-empty) over it before `processResponse`
- **Chat Completions** — no `finish_reason` → error, partial text kept, `tool_calls` dropped. `length` → `max_tokens`, `content_filter` → `error` badge (existing private `mapStopReason`)
- **Google** — `promptFeedback.blockReason` → `Prompt blocked: <reason>` error; no `finishReason` → error, `functionCall` parts dropped. `tool_use` applies only when the finish reason is `STOP`
- **Bedrock** — no `messageStop` → error, `toolUse` blocks dropped. The `messageStop` reason passes through raw
- **claude-agent** — an SDK iterator that ends without a `result` message → `resultError` (also no billing usage arrives). Runs before `classifyTurnError`, which stays gated on `!resultError`
- **Anthropic** — nothing extra: the SDK's `finalMessage()` throws when `message_stop` never arrived, and re-checks the abort signal itself

`extractToolUseBlocks` on Responses and Chat Completions parses arguments through `parseToolArguments` (`baseClient.ts`) and skips a call whose JSON doesn't parse, instead of throwing out of `buildAssistantMessage`.

**Minions** report every one of these as a failed tool result (no savepoint advance, so the next call can roll back): a turn error → `Minion error: <message>`, an abort → `Minion was aborted`, a truncation → `Minion ended unexpectedly (<reason>)`. For the truncation to reach that gate, neither `fallbackToolExtraction` nor the `auto-enforced` reminder retry runs on a turn whose stop reason is outside `NORMAL_STOP_REASONS` — either would carry the run past the truncation.

**Aborts the SDK swallows.** The OpenAI SDK's stream iterator returns quietly on `AbortError`, so a hard-abort that lands during the last `await stream.next()` used to come back as a finished turn (and would now read as a cut-off one). The agentic loop calls `options.signal.throwIfAborted()` right after the chunk loop too, so it takes the hard-abort path (`aborted` + `incomplete` partial) for every provider.

### Prompt-cache diagnostics

`src/shared/services/api/promptCacheDebug.ts` — provider-agnostic, no UI, no persisted setting.

- `logCacheUsage` runs unconditionally from `APIService.sendMessageStream`, the one choke point every provider passes through. One `console.debug('[promptCache] usage', …)` per API call with `input`, `cacheRead`, `cacheWrite` and `hitPct`. This is how you tell "this provider caches, that one doesn't" without instrumenting anything.
- `probePrefixDivergence` runs from `ResponsesClient` and is armed by setting `globalThis.__GREMLIN_CACHE_DEBUG__ = true` in the console. It hashes the outgoing request segment by segment (`instructions`, `tools`, then each `input` item), diffs it against the previous request under the same routing key, and names the first segment that moved — `prefix stable, appended: 2` or `PREFIX DIVERGED … segment: input[7]`. Providers cache on a stable prefix, so a collapsed hit rate is either the prefix moving (the probe says where) or the backend not caching for us (the probe says the prefix held). It is behind the flag because it stringifies the whole request, which is a few hundred KB per call on a large context.

Known prefix movers, none of them on by default: `nudgeThinking` (appended to the last user message at send time and never persisted, so an already-sent message changes retroactively on the next tool round-trip), `pruneThinking` / `pruneEmptyText` / `thinkingKeepTurns >= 0` (the boundary slides forward each user turn, editing the middle of the input array), and the memory tool's system prompt (it embeds the `/memories` listing plus `README.md` contents, so any memory write rewrites `instructions`).

### Chat Completions reasoning round-trip

DeepSeek-lineage models (DeepSeek, GLM, Kimi, MiniMax, Qwen) make better follow-up tool calls when their own reasoning comes back inside an agentic run, so `OpenAIClient` treats reasoning as part of the message rather than display-only:

- **Read**: streaming maps `delta.reasoning_content` (DeepSeek-style), `delta.reasoning` (OpenRouter's plain-text mirror), or `delta.reasoning_details` (OpenRouter's structured form) to thinking chunks, in that precedence — details are a **fallback, never additive**, since OpenRouter sends the mirror and the array together and rendering both would double every block. `reasoningTextFromDetails` skips `reasoning.encrypted` entries and never renders `data` (base64). The non-streaming path reads the same three keys off `choices[0].message`. `hasCoT` is true when reasoning text is present even if the provider reports no `reasoning_tokens`, and also when only `reasoning_details` arrived — an Anthropic-via-OpenRouter turn can be all-encrypted, real chain-of-thought with nothing renderable, and without the extra latch `mandateCoT` would reject every such run.
- **Store**: `CompletionFullContentAccumulator` keeps reasoning under the key the provider used — all three stay distinct on the stored `CompletionMessage`, and none appear for non-thinking models. `reasoning_details` entries merge keyed on `(index, type)`, falling back to array position when `index` is absent: `text`/`summary`/`data` concatenate, everything else is last-write-wins but only for non-null values (continuation fragments carry `id: null` and must not erase the opening fragment's id). Unknown fields ride through verbatim via an index signature. The `(index, type)` pair rather than `index` alone means an index reused across types opens a second block instead of fusing a text block into an encrypted one. `finalize()` emits in first-seen order and **never re-sorts by `index`** — SSE arrival order is generation order.
- **Send**: under the `openrouter` dialect the signed `reasoning_details` array is echoed back verbatim on the assistant message (with or without `tool_calls`), **displacing** the text rather than joining it — sending both hands the gateway two representations of the same reasoning, and an Anthropic upstream can translate the unsigned one into a second thinking block, the exact sequence mismatch the signature catches. Otherwise the reasoning text goes back as `reasoning_content` whichever key it arrived on (`reasoningTextOf`: `reasoning_content`, then `reasoning`, then the details' text) — every probed endpoint reads `reasoning_content`, while DeepSeek, GLM and MiniMax ignore a `reasoning` key. Never under its own `reasoning` key. Replay ignores the reasoning toggle: switching thinking off now doesn't undo the thinking earlier turns did. OpenAI itself emits none of these keys, so its requests are unchanged.
- **Mandated replay**: models with `mandatesReasoningReplay` (every DeepSeek entry) 400 when a tool-call turn arrives without reasoning. `tidyMessages` takes `keepToolTurnReasoning` and leaves reasoning on any turn whose tool calls survive the checkpoint filter, under every kind of pruning; a tool-call turn with no reasoning (another provider's, a legacy array, or thinking was off) goes out with `reasoning_content: ""`. `ResponsesClient` does the same with a leading `{type: 'reasoning', summary: [], content: [{type: 'reasoning_text', text: ' '}]}` item — DeepSeek's Responses endpoint treats an empty `text` as missing.
- **Verbatim constraint**: OpenRouter requires that "the entire sequence of consecutive reasoning blocks must match the outputs generated by the model during the original request" — no rearranging, no modifying. Pruning honors this by being **all-or-nothing per message**: the whole array is kept or the whole array is deleted, never subsetted. A message carrying no details is just a historical turn without reasoning, which every provider accepts; a subsetted array is an ordering violation.
- **Control**: the same two knobs as everywhere else — per-definition `advancedSettings.pruneThinking` and per-project `pruneThinkingBeforeApiCall` + `thinkingKeepTurns`. `pruneThinking` is the escape hatch if an endpoint rejects the echo. `thinkingKeepTurns = 0` behaves here exactly as it does on every other client — see the note below.

#### Reasoning dialects

Every OpenAI-compatible vendor invented its own reasoning parameter, and several reject a request carrying two of them, so the wire shape is a four-value enum (`ReasoningDialect`) rather than a stack of booleans. `resolveReasoningDialect` (`shared/engine/lib/reasoningDialect.ts`) picks one; both `OpenAIClient` and `ResponsesClient` switch on it.

| Dialect            | Wire shape                                                                        | Providers                                           |
| ------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| `openai` (default) | `reasoning_effort`                                                                | OpenAI, xAI, Kimi K3 / K3.1                         |
| `thinking-object`  | `thinking: { type: 'enabled' \| 'disabled' }`, plus effort for GLM-5.2+, DeepSeek | DeepSeek, GLM/Zhipu, MiMo, Doubao, Ernie, Kimi K2.x |
| `enable-thinking`  | `enable_thinking: boolean`                                                        | Qwen/DashScope                                      |
| `openrouter`       | `reasoning: { effort \| max_tokens, enabled }` + `reasoning_details` round-trip   | OpenRouter                                          |

- **Precedence**: model metadata wins, the API definition is the fallback for models discovery turns up unrecognized. Moonshot serves Kimi K2.x (`thinking`) and K3 (`reasoning_effort`, no `thinking` param) from one endpoint, so a definition-level choice could never be right for both. The dialect is read off the cached model list, so a metadata change reaches an existing definition at the next model refresh (daily, or on demand in Settings). An explicit `'openai'` on a model is an answer, not an absence — it stops a definition-level dialect from reaching a model that doesn't reason (`zhipu.ts`'s glm-4-32b entry).
- **Override**: `advancedSettings.reasoningDialectOverride` flips that precedence, for a gateway that normalizes every model it fronts. The `openrouter` dialect **implies** it: `deepseek/deepseek-chat` served through OpenRouter speaks OpenRouter's shape, not DeepSeek's, even though the metadata matching its id says `thinking-object`.
- **Legacy**: `deFactoThinking` (boolean, both levels) is deprecated but still read — `true` resolves to `thinking-object`, an explicit `false` to `openai`. Read-time only; nothing migrates storage, and saving a definition in Settings writes the enum and drops the boolean.
- **Always-reasoning models**: with the toggle off, a `reasoningMode: 'always'` model still gets `thinking: {type: 'enabled'}` (plus its lowest effort level, see below) / `enable_thinking: true`, and under `openrouter` its lowest effort, or no `reasoning` key when its levels are unknown. On the `openai` dialect, toggle off sends `none` where the ladder has it and the lowest level otherwise (`effortWhenOff`). Alibaba and OpenRouter 400 on disabling glm-5.3, Kimi on disabling K2.7 Code. OpenRouter's `/models` reports this as `reasoning.mandatory`, which `populateFromOpenRouterModel` maps to `'always'` over both the inferred and the hardcoded mode.
- **Effort beside the toggle**: `effortBesideToggle` (`shared/engine/lib/reasoningEffort.ts`) adds an effort only when the model's `supportedReasoningEfforts` is non-empty: GLM-5.2+, DeepSeek V4.x, and Qwen 3.8 on Responses only. Kimi K2.x rejects the pair; MiMo, Qwen ≤3.7 and GLM ≤5.1 have no ladder. Chat Completions sends a top-level `reasoning_effort` beside `thinking` (`max` included, via an untyped write) and never beside `enable_thinking`, since Alibaba's Chat Completions has no effort for Qwen (only `thinking_budget`). Responses sends `reasoning.effort` (Z.ai's `/api/v1/responses` ignores a top-level `reasoning_effort`). No effort picked → none sent, server default applies (`max` on GLM, `high` on DeepSeek, `xhigh` on Qwen 3.8). Toggle off on an always-reasoning model → its lowest level, Z.ai's documented replacement for `disabled`. Probed 2026-10-01 on the coding plan, both endpoints, glm-5.3 and -flash: `low` ≈ 40 vs `max` ≈ 155 reasoning tokens on the same prompt. The levels come from the cached model list, so an existing definition picks them up at the next model refresh.
- **Responses thinking switch**: on Responses, `reasoning.effort` is the native control and the dialect toggles are mostly not read. DeepSeek and MiMo document no `thinking` param there (`reasoning.effort: none` is the off switch), and Z.ai ignores `thinking: {type: 'disabled'}` on `/api/v1/responses` (probed 2026-09-30: glm-4.7 / 5.2 / 5.3-flash still reasoned 120–160 tokens). So a `thinking-object` request that switches thinking off also sends `reasoning.effort: 'none'`. `thinking` stays for Ark, which reads both. On Z.ai, `none` only shortens reasoning to ≈ 40 tokens, the same as `low`; no Responses setting turns GLM reasoning fully off. `enable-thinking` sends no `none`, because Alibaba still reads `enable_thinking` on Responses (deprecated in favour of `reasoning.effort`, which outranks it).
- **Reasoning history** (`reasoningHistoryParam`, read fresh via `getModelMetadataFor` because the cached model list predates it): most vendors drop reasoning from turns before the last user message even when it's replayed. `wantsReasoningHistory(thinkingKeepTurns)` is true for `-1` and `2+`, and only then, with thinking not being switched off, does the client send the model's switch: `clear_thinking` → `thinking.clear_thinking: false` (GLM 4.7+), `thinking_keep` → `thinking.keep: 'all'` (Kimi K2.6; K2.7 Code and K3 always keep), `preserve_thinking` → `preserve_thinking: true` (Qwen 3.6+), `reasoning_context` → Responses `reasoning.context: 'all_turns'` (gpt-5.4 and later, also sent when an always-reasoning model has the toggle off). `2+` is still trimmed client-side when `pruneThinkingBeforeApiCall` is on. Anthropic and Bedrock keep their own `context_management` mapping.
- **OpenRouter request mapping**, in order: `reasoningMode: 'none'` → no `reasoning` key at all (some upstreams reject it); `enableReasoning: false` → `{ enabled: false }`, or nothing for an `'always'` model; a resolved effort → `{ effort }`; else a positive `reasoningBudgetTokens` → `{ max_tokens }`; else `{ enabled: true }`. Effort and `max_tokens` are alternatives upstream and are never both sent. `xhigh`/`max` pass through unclamped — the `Exclude<ReasoningEffort, 'max'>` cast on the `openai` arm exists only because the SDK's `reasoning_effort` type rejects them. When the budget path fires and the budget would leave no room for an answer, `max_completion_tokens` is raised to `budget + 500` (mirrors `anthropicClient`), since Anthropic rejects that case and OpenRouter surfaces it as an opaque 400.
- **`reasoning.exclude` is deliberately unimplemented**: it suppresses `reasoning_details` along with `reasoning`, which would destroy the round-trip and force `hasCoT` false for every turn.
- The `openrouter` dialect is Chat-Completions-only. `ResponsesClient` honors `thinking-object` and `enable-thinking` but ignores `openrouter` — the Responses API has its own native `reasoning: {effort, summary}` field.
- **Responses `include`**: `['reasoning.encrypted_content']` goes out on every request whose cached model isn't `reasoningMode: 'none'`, toggle and dialect regardless (unknown models count as reasoning). Replayed reasoning items are copied, never mutated, and a missing `summary` goes out as `[]` — OpenAI 400s without it. Every probed vendor emits one, so this only guards unprobed backends.

### Reasoning replay: vendor behaviour

Live-probed 2026-10-01. "Read" means the model recalled a codeword that existed only in replayed reasoning (planted text, 3 samples per cell, against a no-reasoning control that never recalls), confirmed on OpenRouter and OpenAI with the model's own reasoning in a real tool loop. Earlier-turn recall is noisy everywhere (1–2 of 3 samples is typical), so "partial" still means the channel is read. Reasoning inside the current tool loop is read reliably on every endpoint that reads the key at all.

**Chat Completions**

| Endpoint                                                                                        | `reasoning_content` | `reasoning`              | Other channels                                                                                    | Tool-call turn sent without reasoning                                                                   | Earlier user turns                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek (`deepseek-flash`, `deepseek-v4-pro`)                                                  | read                | counts as missing        | —                                                                                                 | 400 `The reasoning_content in the thinking mode must be passed back to the API.`; `""` / `" "` accepted | ignored (probed without `tools`); read with `tools` per the docs, unprobed; turns without tool calls need no reasoning even with `tools` |
| Kimi coding plan (`k3`, `kimi-for-coding`)                                                      | read                | read (k3)                | —                                                                                                 | accepted                                                                                                | partial                                                                                                                                  |
| Z.ai coding plan (`glm-5.3`, `glm-4.7`)                                                         | read                | not read                 | —                                                                                                 | accepted                                                                                                | glm-4.7 only with `thinking.clear_thinking: false`; glm-5.3 partial with either value                                                    |
| Alibaba token plan (qwen3.8-flash, qwen3.7-plus, glm-5.3, deepseek-v4.1-flash, deepseek-v4-pro) | read                | not read (qwen3.8-flash) | —                                                                                                 | accepted, hosted DeepSeek included                                                                      | qwen3.7-plus only with `preserve_thinking: true`; qwen3.8-flash never; hosted DeepSeek ignored                                           |
| MiniMax (M3, M2.7)                                                                              | read (M3)           | not read                 | inline `<think>` in `content` read in the tool loop; `reasoning_details` read (M3)                | accepted                                                                                                | inline `<think>` stripped; M3 fields partial                                                                                             |
| MiMo (`mimo-v2.6-flash`, `-pro`)                                                                | read                | read                     | —                                                                                                 | accepted (docs say 400)                                                                                 | ignored                                                                                                                                  |
| OpenRouter → DeepSeek, Kimi, GLM, MiniMax, Qwen, MiMo                                           | read                | read                     | `reasoning_details` read                                                                          | accepted, DeepSeek included                                                                             | partial per upstream                                                                                                                     |
| OpenRouter → Claude Haiku 4.5                                                                   | not used            | not used                 | `reasoning_details` only; unmerged streaming fragments (all `index: 0`) echoed as-is are accepted | —                                                                                                       | —                                                                                                                                        |

**Responses**

| Endpoint                             | Output carries reasoning in                                 | Read on input           | Notes                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI                               | `summary` + `encrypted_content`, returned without `include` | the encrypted blob      | Accepted: item without `encrypted_content`, without `id`, with `content: null`, sent to gpt-4.1-nano or to another family. Rejected: missing `summary` (`Missing required parameter: 'input[N].summary'`). `include` on gpt-4.1-nano / gpt-4o-mini is accepted. gpt-5.5 uses earlier-turn reasoning only with `reasoning.context: "all_turns"`; the param is accepted on 5.4–6 |
| DeepSeek                             | `content` (+ a 38-char `encrypted_content`, UUID `id`)      | `content` only          | Tool loop without it 400s with `The reasoning_text in the thinking mode must be passed back to the API.`; a `summary`-only item and `reasoning_text: ""` count as missing, `" "` is accepted. Replaying the server's own `function_call` item (its `id` and minted `call_id`) went through with no reasoning at all                                                            |
| Kimi coding plan (`k3`)              | `summary` + `encrypted_content`                             | `content` and `summary` |                                                                                                                                                                                                                                                                                                                                                                                |
| Z.ai coding plan (`/api/v1`)         | `content` array                                             | `content` array         | A single-object `content` (as the docs show) is not read                                                                                                                                                                                                                                                                                                                       |
| Alibaba token plan (qwen3.8-flash)   | `summary`, with `content: null` and a `msg_` id             | `summary` only          |                                                                                                                                                                                                                                                                                                                                                                                |
| MiniMax M3                           | `content`                                                   | `content` and `summary` | Docs claim `summary` only                                                                                                                                                                                                                                                                                                                                                      |
| MiMo                                 | `content`                                                   | `content`               |                                                                                                                                                                                                                                                                                                                                                                                |
| OpenRouter → DeepSeek, Kimi, MiniMax | `content`, plus a `format` field                            | `content` only          | GLM-5.3 produced no reasoning items here                                                                                                                                                                                                                                                                                                                                       |

Every probed endpoint accepted `include: ["reasoning.encrypted_content"]` and a verbatim replay of its own output.

**Thinking disabled.** Rejected outright by Alibaba-hosted glm-5.3 (`The value of the enable_thinking parameter is restricted to True.`) and OpenRouter-hosted glm-5.3 (`Reasoning is mandatory for this endpoint and cannot be disabled.`). Z.ai's general API rejects it for glm-5.3 too (re-probed 2026-10-01: `This model always engages in thinking and cannot be disabled; please use low, high, or max`). Z.ai coding plan glm-5.3 and Kimi coding plan k3 honor `thinking: {type: 'disabled'}` on Chat Completions; glm-5.3-flash and glm-4.7 accept it and reason anyway. Z.ai's Responses endpoint ignores it for every GLM model (see Responses thinking switch). Reasoning in history with thinking off never errors, and GLM-4.7, MiniMax M3 and Qwen3.8 sometimes still read it.

Not probed: Ark/BytePlus, xAI, vLLM / Ollama / llama.cpp, Qianfan, Hunyuan, StepFun, cross-vendor blobs (unsupported by design).

### Claude Agent Provider

Bills Claude Max subscription credit by going through `@anthropic-ai/claude-agent-sdk`, which spawns the host `claude` CLI subprocess. Reverse-engineering the OAuth header is banned by Anthropic; the SDK is the sanctioned path. (OpenAI's posture differs — see ChatGPT Subscription Provider.)

- **Server-mode only.** Worker mode registers `ClaudeAgentStubClient` which throws "requires server mode". `nodeEntry.ts` injects the real `ClaudeAgentClient` via `GremlinServer.setBootstrapClaudeAgentClientFactory` so the SDK stays out of the worker bundle. The host `claude` CLI must be on PATH; server startup probes `claude --version` and warns if missing.
- **Session-per-chat.** Each chat owns one SDK session (UUID v4) stored on disk at `<sessionDir>/<sessionId>.jsonl`. `Chat.claudeAgentSessionId` is set on first turn; presence locks the chat to claude-agent. Session dir defaults to `./data/claude-agent-sessions/` (override via `CLAUDE_AGENT_SESSION_DIR`). One exception to "per-chat": a chat cloned from a claude-agent minion inherits the minion's session and forks off it on its first send, and both records list the shared ancestor in `claudeAgentProtectedSessionIds` so neither rewinds it (see Fork on branch, not on rollback).
- **Rollback as metadata.** The UI rollback button (and any failed minion turn — see Minion integration) sets the `{claudeAgentSessionId, claudeAgentResumeAt}` pair from the rollback target's `MessageMetadata`: every assistant message stamps both its SDK message UUID (`claudeAgentMessageUuid`) and its owning session (`claudeAgentSessionId`, from `providerExtra`, stamped in `buildAssistantMessage`). Setting the pair together matters because the anchor can predate a session drop/fork — pointing the current session at an old-lineage uuid is exactly the "No message found with message.uuid" hard-fail loop from the 2026-08-22 incident. Messages written before the stamp existed rewind only `resumeAt` (today's legacy behavior) and rely on the send-time resolution below. The next user send passes the pair as `resume` + `resumeSessionAt` to `query()`; no SDK call happens at rollback time.
- **Send-time resume resolution (best-effort fallback).** `resolveResumeTarget` in `claudeAgentClient.ts` verifies the resume target against the on-disk session JSONLs before every non-first turn and repairs stale targets instead of letting the CLI hard-fail. Fallback order with `resumeAt` set: anchor present in the stated session's file → unchanged; else scan every JSONL (newest mtime first) and repoint `resume` to the owning session; else downgrade to the newest earlier anchor recoverable from stored message metadata (stamp checked first, then scan); else plain `resume` without `resumeSessionAt` if the session file exists; else a fresh session. Without `resumeAt`: a missing session file recovers via message anchors the same way. The JSONL location is CLI-internal layout (`$HOME/.claude/projects/<dashified-cwd>/`, override via `ClaudeAgentClientOptions.sessionJsonlDir`), so the whole resolver is fail-open — a missing projects dir or any FS error passes the target through untouched. The persisted per-message pair is the primary mechanism; the resolver only heals legacy unstamped anchors and pre-change lineages, whose stamps a fork-then-GC invalidated back when rollbacks still forked (both self-repair on their next send). The anchor needle is `"uuid":"<uuid>"` — case-sensitive, so `parentUuid`/`leafUuid` never match.
- **SDK message inspector.** Every assistant message with a `claudeAgentMessageUuid` gets a 🔬 button in its metadata row (parent chats and the minion overlay both — same bubble component) that opens `ClaudeAgentDebugModal`: the `claudeAgentInspectMessage` RPC reads the raw JSONL entry behind the message via the stamped pair (`inspectProviderMessage` on the client, stated session first, scan fallback, `foundVia` badge when scanned). Server mode only — worker mode surfaces the stub's "requires server mode" error.
- **Fork on branch, not on rollback.** The SDK's two rewind options do separate jobs and we pass them separately. `resumeSessionAt` is the truncation — "only resume messages up to and including the message with this UUID" — and rides **every** continuation, anchored at the last stamped assistant uuid, not just rewound ones. `forkSession` is only the id: "fork to a new session ID rather than continuing the previous session". Conflating them (setting both on any rewound send) was a branch primitive used to obtain truncation, and it churned the session id on every rollback.

  The rule is `forkSession = isRewind && claudeAgentProtectedSessionIds.includes(anchorSessionId)` — fork exactly when a rewind would truncate a session another record also resumes through. `shouldForkSession` (`src/shared/engine/lib/claudeAgentSessionSharing.ts`) is the single implementation, called from both loop-option builders (`buildLoopOptions`, `minionTool`) and threaded to the client as `claudeAgentForkSession`. "Rewind" means `claudeAgentResumeAt` was set by a rollback / edit / minion retry, as distinct from the tip anchor the client synthesizes for a plain continuation. `anchorSessionId` is just the row's `claudeAgentSessionId`, because `rewindPatchFromAnchor` writes the session and the anchor together from one stamp.

  | Send                                   | Rewind?                    | Anchor's session shared? | Fork    |
  | -------------------------------------- | -------------------------- | ------------------------ | ------- |
  | Plain continuation (any chat)          | no                         | —                        | **no**  |
  | Plain chat rollback                    | yes                        | no (list empty)          | **no**  |
  | Clone's first send                     | yes (`resumeAt` inherited) | yes                      | **yes** |
  | Clone rolls back onto a copied message | yes                        | yes                      | **yes** |
  | Clone rolls back onto its own turn     | yes                        | no                       | **no**  |
  | Minion continues after a clone         | no                         | yes                      | **no**  |
  | Minion rolls back past the clone point | yes                        | yes                      | **yes** |

  Both halves are load-bearing. Without the sharing check every ordinary rollback forks — the old shortcut. Without the rewind check a minion continuing after a clone forks on every turn, since its own session is in its own protect list; that fork is pointless, because an append leaves the clone's anchor intact and only a rewind can truncate it away. The predicate must be the protect list and not `anchor.sessionId !== row.claudeAgentSessionId` — a clone that has not sent yet has those equal and would append into the minion's file. No owned-vs-borrowed distinction is needed: the only non-rewind write is an append at the tip, safe for owner and borrower alike.

  **Implementation trap:** derive `forkSession` from the rewind, never from `!!resumeSessionAt`. Every send carries an anchor now, so keying off anchor-presence silently restores the old behaviour — and no test catches it unless the matrix asserts the fork flag directly rather than inferring it from the resulting session id. That is why `shouldForkSession` runs engine-side and arrives at the client as a flag, and why the harness records `forkFlags`.

  The client adds one fork trigger of its own: if `resolveResumeTarget` repointed us to a session the row never named, we are not continuing our own session and must not append to it. The authoritative id arrives on `system:init` and flows back through `providerExtra`; `claude_agent_turn` persists it on the row (`ChatRunner` / `minionTool`) and clears `claudeAgentResumeAt`.

  **The tip anchor** is what makes an in-place rollback safe. A non-forked rewind may leave a dead branch in the file, so a bare `resume` would need the CLI to pick a path through it; anchoring at the stored tip removes the question. It is guarded: an anchor the stated session's own file does not contain is dropped rather than handed to `resolveResumeTarget`, whose `resumeAt` ladder scans and can repoint. Dropped, the send takes the anchorless path it always took — so the tip anchor can never make recovery worse, only more deterministic.

  **No GC.** A session id now changes only on a shared-session fork, whose predecessor is shared by definition, so `deleteProviderSession` never has a legitimate case and neither turn dispatcher calls it. `claudeAgentProtectedSessionIds` survives with its meaning broadened from "never delete" to "never mutate either" — one field gating both. `cloneMinionChat` seeds it on **both** sides, plus whatever the source already protects (which is how a clone-of-a-clone carries multiple live lineages forward), and it stays scoped by construction: a chat that was never cloned has no protected ids and keeps the baseline behaviour exactly.

  The history is worth keeping because it explains the field. GC was justified by a **single-chat** invariant: a fork copies all history up to the anchor and the rollback deleted everything after it, so every surviving message's uuid exists in the surviving file. That is a claim about the **uuid**, not the stated session — after a fork+GC a surviving message still named the deleted session and the resolver had to scan for it. Cloning a minion chat broke the invariant outright: the clone keeps messages the source's fork truncated away, so either side's GC silently destroyed the other's context, with no error, just a resolver quietly downgrading to an earlier anchor.

  **Pre-change lineages are the one place the old scheme's debris survives.** Their stamps name sessions their own forks collected, so `cloneMinionChat` still resolves the anchor before seeding: its dispatch arm passes a `resolveAnchorSession` callback backed by `APIService.inspectProviderMessage` ("which session holds this uuid now" — stated-first, scan fallback), and the clone's row and protect list both name the real holder. The callback is injected rather than imported so `src/shared/` keeps no server assumption; it throwing (worker mode, where inspection is unavailable) degrades to stamp-based seeding rather than failing the clone. Message stamps are never rewritten: they are the historical record of which session produced each turn, and only the resume pointer is forward-looking.

  Whether a non-forked `resumeSessionAt` truncates its JSONL or appends a branch is not correctness-relevant. Non-forked writes are either appends at the tip (destroy nothing, sharing irrelevant) or rewinds in unshared sessions, whose truncated messages our own rollback already deleted from storage. A rewind in a shared session always forks, so truncation can never reach another record's anchor. The difference is only how much a single file grows. The in-memory model deliberately assumes the **destructive** reading, because the appending one cannot fail: nothing is ever removed, so dangling references become impossible by construction.

  The whole surface is driven through an in-memory model of the SDK's session semantics in `src/shared/engine/__tests__/claudeAgentSessionLifecycle.test.ts` (fake + harness in `helpers/fakeClaudeAgentSessions.ts`), including a seeded randomized sweep; fs-backed bridge cases in `claudeAgentClient.test.ts` pin the join to the real resolver and the real option matrix.

  **Which resolver rung a send lands on is asserted, not assumed.** The harness records every outcome (`verified` / `recovered-by-scan` / `anchor-downgraded` / `fresh`) and `assertNeverScanned()` fails a scenario that needed a healing rung. It is now asserted nearly everywhere, including the randomized sweep — session ids are stable, so no stamp goes stale and nothing needs healing. Two scenarios are deliberate exceptions, both genuinely legacy: a message written before assistant turns stamped their session (the rung's original customer), and a seeded pre-change lineage, which heals by scan on its first send and never again. It is a test-only assertion — no production guard, warning or telemetry.

  The invariant check has two tiers for the same reason. _Resolvable_ (the uuid lives in some session) is what the old scheme could promise; _direct_ (the stated session still holds it) now holds for every live stamp, and is asserted as such. Only the pre-change scenario opts out.

  Accepted leaks: the drop paths (failed first turn) never delete files; a rollback onto a shared-era message mints a new session and abandons the one it was in; and a shared ancestor is retained for the life of the cloned lineage. Steady state: **one JSONL per lineage**, plus one per rollback onto a shared-era message. Bounded by how often the user rolls back a cloned transcript.

- **Chat forking is still gated off** (`ChatView` hides the Fork action for claude-agent chats, `UserMessageBubble` hides the button). That gate was added for exactly the hazard the fork rule now handles, so it describes unimplemented UI rather than a constraint: re-enabling it is the same protect-list seeding, from the forked-at message's stamp instead of the clone's anchor.
- **Rewind arithmetic is shared.** `computeClaudeAgentRewindBefore` / `computeClaudeAgentRewindKeeping` live in `src/shared/engine/lib/claudeAgentRewind.ts`; `useChat` imports them and the minion-side `applyClaudeAgentRewindOnFailure` / `…OnRollback` delegate to the same anchor scan and patch builder. They used to be two hand-mirrored implementations either side of the dual-mode boundary.
- **Auth.** Empty `apiKey` → SDK uses host CLI credentials (`apiKeySource: 'none'`). Tokens starting with `sk-ant-oat01-` → `CLAUDE_CODE_OAUTH_TOKEN` env (subscription billing). Other keys → `ANTHROPIC_API_KEY` (API billing — defeats the purpose). Keyless definitions count as configured everywhere via `apiKeyOptional()` (`src/shared/protocol/apiDefinition.ts`) — model discovery, selector warnings, and status badges (shown as `Host CLI`) all exempt claude-agent, no `isLocal` flag needed.
- **CLI overrides.** Per-definition `binaryPath` → SDK `pathToClaudeCodeExecutable` (empty = the SDK's bundled executable; the `claude --version` startup probe in `nodeEntry.ts` only checks PATH and ignores this). Per-definition `extraArgs` is a string parsed by `parseExtraArgs()` into the SDK's `extraArgs` record — `--flag`, `--key value`, `--key=value`, quotes group values with spaces; positional tokens are dropped with a debug note (the SDK record can't express them).
- **Host-config isolation.** The spawned CLI must see our config and nothing else. `settingSources: []` drops the filesystem settings layers (`~/.claude/settings.json`, project, local) — but it does **not** stop claude.ai cloud MCP connectors (Google Docs, Gmail, Drive), which the CLI auto-fetches from whatever claude.ai account the host credentials belong to. Those connectors can never be called (the `allowedTools` whitelist), so all they did was add startup latency and make the model ask the user to authenticate mid-chat. Same for the **skills and workflows bundled with the CLI** — omitting `Options.skills` is not "skills off", so they load by default and spend context describing Claude Code's own workflows rather than ours. Both are closed in the SDK's flag layer via one inline `Settings` object, `{ disableClaudeAiConnectors: true, disableBundledSkills: true }` (neither key has an env var; the connector key wins from any settings source), alongside `strictMcpConfig: true` (only the `mcpServers` we pass — no project `.mcp.json`, user settings, plugins or agent frontmatter). The inline object is **skipped** when `extraArgs` already carries `--settings`, because the SDK folds `Options.settings` into the extraArgs record under the same key and would silently replace the caller's file. Still inherited on purpose: the full `process.env` copy (auth, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`).
- **Supported knobs:** `enableReasoning` + `reasoningBudgetTokens` → SDK `thinking`; `reasoningSummary` → `thinking.display: 'summarized'` (same convention as the direct AnthropicClient — any non-`undefined` value opts in; on the adaptive path this switches from omitting `thinking` to the explicit `{ type: 'adaptive', display }` form since the opt-in needs somewhere to ride). Without it, Opus 4.7+ / Claude 5 default to `display: 'omitted'`, which strips thinking **and narration** content — the model's mid-loop prose between tool calls arrives as empty signed thinking blocks, so tool-heavy turns render only their final text segment; `reasoningEffort` → SDK `effort`, clamped via `mapAnthropicEffort()` (the SDK's `EffortLevel` has no `none`/`minimal`, and pre-4.6 models reject the field outright); `maxTokens` → `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env on the spawned CLI (hard per-call output ceiling, thinking included — the one working guardrail against runaway-thinking turns; `Options` has no field for it, and on adaptive models `maxThinkingTokens`/`thinking.budgetTokens` can't cap depth); `injectFiles` / `injectFilesAfter` in every mode, plus image attachments: `inline` splices into the prompt text as before; everything else rides the SDK's streaming-input form — `query()` accepts `AsyncIterable<SDKUserMessage>` whose `message` is a full `MessageParam`, and a plain string prompt is just SDK sugar for one text block over the same stream-json wire, so the client builds a `ContentBlockParam[]` (images → `injectedFiles` → text → `injectedFilesAfter`, mirroring the anthropic client) and yields it as a one-shot iterable; a single-text-block turn keeps the plain-string path (zero diff on the common case). `separate-block` maps to native text blocks; `as-file` downgrades to `separate-block` until the CLI's document-block passthrough is verified (the client's document branch is implemented and unit-tested — the flip is adding `claude-agent` to `effectiveInjectionMode`'s as-file allowlist); `mock-tool-call` downgrades to `separate-block` at production time in `minionTool` (the SDK owns the session history, so synthetic tool_use/tool_result message pairs can't be sent — and the old path didn't just drop files, it threw `no user message to send` off the empty trailing tool_result message). Attachment-only sends (no text) work; the empty guard now fires only when the turn has no text, no attachments, and no files. `verifyHook` runs in our app after the SDK returns; rejection sets `claudeAgentResumeAt` for the next retry.
- **Usage split.** The SDK `result` message's usage carries `output_tokens_details.thinking_tokens` (inclusive in `output_tokens`); `mapSdkUsage` subtracts it out so `outputTokens` is text-only and `reasoningTokens` rides `StreamResult` / the `R:` display chip like every other provider. The thinking-only-turn classifier message reports the gross spend (`outputTokens + reasoningTokens`).
- **Context-fill snapshot.** The `result` usage aggregates every internal API call of the turn (`num_turns` round-trips), so summing it as context-window fill counts the conversation prefix once per call. The client tracks the LAST call's usage separately — from the partial mapper's per-call `token_usage` chunk (captured, still not yielded; mapper state resets per `message_start`), or from the coalesced assistant's `message.usage` in the no-partials degradation path — and reports `input + output + reasoning + cacheCreation + cacheRead` of that call as `StreamResult.contextWindowUsage`. `buildAssistantMessage` prefers this snapshot over its billing-usage sum (which stays correct for single-call providers); the snapshot flows to the message bubble's `ctx` figure, the chat row, and the `<context_window_usage>` prompt injection. Mid-turn SDK auto-compaction is reflected for free (the last call's usage is post-compact).
- **Notify blocks.** `system`/`notification` SDK messages (compaction errors, quota/credit warnings, stop-hook errors — the CLI's REPL status lines) surface as a `notify` StreamChunk → `NotifyRenderBlock` (`text`, `key`, `priority`, `color`). Categorized as `text`, so the banner renders inline (🔔, red tint on `color: 'error'` / `priority: 'immediate'`) and splits the backstage accordion instead of hiding in it; `StreamingMessage` renders it live mid-turn too. Not pushed into `fullContent` — it's session telemetry, not part of the provider message. Other system subtypes (`informational`, `task_notification`, `thinking_tokens`, compact boundaries) stay log-only.
- **1M context.** The Agent SDK's `Options` take only a `model` string — there is no `betas` array — so the project's Extended Context (1M) toggle is honored by suffixing the model id with `[1m]` (e.g. `claude-opus-4-8[1m]`), the Claude Code / Agent SDK convention. Eligibility is its own set — `supportsClaudeAgent1mContext` (`src/shared/engine/lib/api/claudeAgentExtendedContext.ts`): Sonnet 4.5 and Opus 4.5–4.8 (prefix match, also matches dated + `anthropic.`-prefixed ids). Deliberately distinct from `supportsExtendedContext`: Opus 4.5 needs the suffix but has no `supportsExtendedContext` flag, while Sonnet 4.6 runs at 1M natively and must NOT be suffixed. `agenticLoopGenerator` pre-gates (`apiType === 'claude-agent' && extendedContext && supportsClaudeAgent1mContext(model.id)`) and forwards `claudeAgentExtendedContext`; the client trusts that boolean and appends the suffix (parity with how the anthropic client trusts the pre-gated `extendedContext`). `model.id` stays bare everywhere else (pricing/metadata) — only the string handed to the SDK changes.
- **Tool bridging (in-process MCP).** Tools flagged `claudeAgentBridgeable` (`filesystem`, `memory`, `javascript`, `sketchbook`, `minion`, `metadata`, `dummy`) are exposed to the SDK as an in-process MCP server (`src/server/claudeAgentToolBridge.ts`, server name `gremlin`; tools surface to the model as `mcp__gremlin__<name>`). The exposed set is `run.enabledTools ∩ bridgeable`; with none enabled, `mcpServers` stays `{}` (no behavior change). Since the SDK owns the loop, calls are dispatched through `executeToolSimple` with the agentic loop's prebuilt `ToolContext` (threaded via `streamOptions.toolContext`), not `executeToolsParallel`. The MCP handler is the sole emitter of `tool_use`/`tool_result` StreamChunks — pushed onto a side-channel queue the client merges with the SDK message stream (`Promise.race`), so bridged tools render like other providers. Sub-agent (minion) costs return on `StreamResult.toolTokenTotals`; the loop folds them into chat totals _after_ the subscription cost-zeroing so non-subscription minion costs survive. The `metadata` tool's `chatMetadata` side-effect rides back the same way: the SDK owns the turn so it can't apply mid-turn, so the bridge collects it (`onChatMetadata`), the client surfaces it on `StreamResult.chatMetadata`, and the loop yields the existing `chat_metadata_updated` event after the turn (ChatRunner persists via `patchChat` + broadcasts `chat_updated`) — visible to the next turn and the user, never the in-flight one. Schema fidelity: we drive the low-level MCP `Server` (`tools/list` + `tools/call`) with our exact JSON Schema (minion's dynamic `anyOf` intact) — `McpServer.registerTool` is bypassed because it forces a Zod shape. **Concurrency:** the CLI runs an MCP tool concurrently with its neighbours only when its definition carries `readOnlyHint: true` (verified in the CLI bundle: `isConcurrencySafe() { return annotations?.readOnlyHint ?? false }`; safe calls fan out in parallel up to `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, default 10, every unsafe call runs alone). Every bridged tool therefore advertises `readOnlyHint: true` — our loop already runs a phase's tools in parallel so they tolerate it, and with `bypassPermissions` the read-only claim has no other effect (annotations never reach the model). The CLI fires the whole batch at once, so the bridge re-creates the loop's `parallelThrottleMs` launch stagger per `getParallelThrottleGroup` group with a rate-limiter (`LaunchStagger`: each call claims the next slot `throttleMs` after the previous one in its group; a burst gets 0/T/2T spacing, already-spaced calls wait nothing; the wait is abortable and an abort returns an `isError` result without running the tool). Not reproduced: the loop's simple-then-`complex` phase order (see the pending-features checklist). **Built-in host tools (Read/Write/Edit/Bash) stay OFF** and `allowedTools` whitelists exactly the `mcp__gremlin__*` set (plus the web tools when web search is on — see next bullet), so the model never gets host-fs/Bash access; our tools are VFS-scoped. Hidden (not bridged): `checkpoint` only (its `checkpoint: true` auto-continue signal is meaningful only to the bypassed loop). `return` IS bridged but `internal`, so it never appears in a parent chat's enabled set — it only reaches a minion whose own apiDef is claude-agent, where it runs free-run (its `breakLoop.returnValue` rides the `onReturnValue` side-channel; see Minion integration below). `dummy` IS bridged: `template` is a plain VFS write, and register/unregister set `ToolResult.activeHook` (string = activate, `null` = deactivate) which rides the `onActiveHook` side-channel — the SDK can't swap the outer-loop hook mid-turn, so the client surfaces it on `StreamResult.providerExtra.claudeAgentActiveHook` and the loop activates it after the turn (it fires on the next iteration, before the next SDK turn — so a registered hook can handle a message without starting an SDK turn at all). The hook runs at the outer-loop level in the QuickJS sandbox, identical to the normal path.
- **Model-delivery detection (observe-only).** The SDK can hand the model a different payload than the bridge sent — truncated for size, or replaced with an error — while our UI still shows the full result. `PostToolUse`/`PostToolUseFailure` hooks (`sdkOptions.hooks` in `claudeAgentClient.ts`) detect this without changing what the model receives (every callback returns `{ continue: true }` unchanged): `PostToolUseFailure` carries the SDK's error string; `PostToolUse`'s `tool_response` is compared (`detectTruncation`) against the full content the bridge recorded for that call, flagging a strictly shorter payload. Correlating the model's tool name+input back to the bridge's synthetic `mcp_gremlin_<seq>` id is closure-local — recorded as `tool_use`/`tool_result` chunks pass through `pushChunk`, matched by `consumeBridgedCall` on `(name, input)` + FIFO (MCP never surfaces the model's tool_use id to the server, so the two id-spaces only meet on name+input). On divergence the hook pushes a `tool_result_annotation` StreamChunk (`{ tool_use_id: <synthetic>, modelDelivery: { status: 'truncated' | 'error', detail } }`); `StreamingContentAssembler.handleToolResultAnnotation` patches the already-emitted `ToolResultRenderBlock` by id (via `toolResultMap`), and `ToolResultView` renders an amber badge while still showing the full result. `bridgedToolName` / `toolInputKey` / `extractToolResponseText` / `detectTruncation` are pure and unit-tested. Server-only; worker mode never loads the SDK. (If the SDK ever truncates without `PostToolUse.tool_response` reflecting it, the ground-truth fallback is the SDK's currently-dropped `user`-message frames, which carry `parent_tool_use_id` + the tool_result the model actually received.)
- **Web search / fetch.** The project `webSearchEnabled` toggle now applies to claude-agent: when on, the SDK's built-in `WebSearch` + `WebFetch` are added to the `tools` allowlist and `allowedTools` (alongside any `mcp__gremlin__*`). The `tools` allowlist only ever lists those two web tools — `Read`/`Write`/`Edit`/`Bash` are never added — so host-fs/Bash stay off (parity with the Anthropic direct client, which pairs `web_search` + `web_fetch` under the same flag). The CLI's `server_tool_use` + `web_search_tool_result`/`web_fetch_tool_result` blocks are mapped onto the shared `web_search.*`/`web_fetch.*` StreamChunks in `handleSdkMessage`, so queries and source links render like other providers. `webSearchCount` is surfaced for display only — cost is subscription-zeroed. Under `CLAUDE_AGENT_DEBUG=1` every web block is dumped in full (`dbgJson`): the coalesced `server_tool_use` / `web_search_tool_result` / `web_fetch_tool_result` blocks, plus every partial stream event touching a web block's index (`content_block_start` verbatim, the `input_json_delta` fragments, `content_block_stop`) — for capturing exact wire shapes ahead of richer renderers.
- **Generic unknown-block rendering.** Any assistant content block `handleSdkMessage` has no dedicated handler for is surfaced instead of dropped: an `unknown_block` StreamChunk (`{ blockType, name?, id?, json }`, `json` = `trimBlockJson(block)` — pretty-printed, capped at 2000 chars) → `UnknownBlockRenderBlock` (category `backstage`) → `BackstageView`'s `UnknownBlockSegment` (🧩 header `blockType: name` + collapsible raw-JSON `<pre>`). Covers four shapes: `server_tool_use` with a name other than `web_search`/`web_fetch` (e.g. code execution), a non-bridged `tool_use` (name without the `mcp__gremlin__` prefix — in practice the SDK's built-in WebSearch/WebFetch arrive this way, as plain `tool_use` blocks named `WebSearch`/`WebFetch`, NOT as `server_tool_use`), any block type we don't know at all, and the `tool_result` blocks riding back on SDK `user` messages whose `tool_use_id` matches a surfaced non-bridged `tool_use` (tracked in a per-stream id→name map; rendered under the originating tool's name — bridged results stay side-channel-only). Emitted unconditionally from the coalesced `assistant`/`user` branches (the partial mapper never emits for these, so no double-render); the raw block is also dumped via `dbgJson` under `CLAUDE_AGENT_DEBUG=1`. Intent: make new SDK activity visible so richer renderers can be built from observed wire shapes.
- **Unsupported knobs** (silently logged via `console.debug`): `temperature`, `maxOutputTokens`, `nudgeThinking`, `thinkingKeepTurns`, `pruneThinkingBeforeApiCall`. `fileInjectionMode: 'as-file' | 'mock-tool-call'` are supported as downgrades to `separate-block` (logged in `minionTool`, see Supported knobs). Provider-level advanced settings (`pruneThinking`, `enforceGenuineAnthropic`, etc.) are hidden in the SettingsPage UI for this apiType. Model discovery returns a hard-coded list (`claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`), extended by the definition's Extra Model IDs (`mergeExtraModels` applies to claude-agent like any other apiType); checking "Use only my model list" (`modelsEndpointDisabled`) replaces the built-in list entirely. Custom ids get metadata via `getModelMetadataFor`, but 1M-context eligibility is its own prefix list in `shared/engine/lib/api/claudeAgentExtendedContext.ts` — new model families need an entry there. The SettingsPage add **and** edit forms hide the fields the client never reads — Base URL, Local-provider checkbox, Models Endpoint, CORS proxy — leaving API Key, the two CLI overrides (Binary Path, Extra CLI Args), Extra Model IDs, and the replace-list toggle.
- **UI gating** (`isClaudeAgentChat` prop): hides Fork + user-message Rollback (the SDK only rewinds to assistant UUIDs); the assistant-message Rollback remains and re-purposes to `resumeSessionAt`. Edit stays (it rewinds to the prior assistant turn and drops the user text back into the input). The minion-chat overlay (`MinionChatView`) applies the same gating and additionally hides its single-message ❌ delete — per-message delete is a minion-overlay-only affordance, and the SDK can't splice one message out. Subscription chats are not convertible to ordinary chats — start a fresh chat to switch providers.
- **Minion integration.** A claude-agent _parent_ chat can call the `minion` tool via the tool bridge (above). A minion whose _own_ apiDef is `claude-agent` runs with full tool support: its `enabledTools` bridge through the same in-process MCP server, and web search works via the SDK's built-in WebSearch/WebFetch (gated on the minion `allowWebSearch` option like every minion — `loopOptions.webSearchEnabled` already carried `enableWeb` end-to-end). The `return` tool is **free-run only**: the bridge can't break the SDK's turn, so a `return` call stashes its value via an `onReturnValue` side-channel (mirroring `onChatMetadata`); the client surfaces it on `StreamResult.providerExtra.claudeAgentReturnValue`, and `agenticLoopGenerator` folds it into the loop's `returnValue`. `returnMode` is whatever the minion options resolve to (no longer forced to `no-return`), but enforcement degrades to free-run best-effort — auto-enforce retries are skipped for claude-agent, and the return tool's description is forced to the free-run wording (`deferReturn = 'free-run'`). Knobs the SDK owns (`temperature`, `nudgeThinking`, `thinkingKeepTurns`, `pruneThinkingBeforeApiCall`) are no-ops and logged; `maxOutputTokens` works via the CLI env cap (see Supported knobs). File injection works in every mode (`as-file`/`mock-tool-call` as `separate-block` downgrades, see Supported knobs). `MinionChat.claudeAgentSessionId` / `claudeAgentResumeAt` mirror the parent-chat fields. **Any failed minion turn** (error / aborted / soft-stop / max-iterations / no-assistant / abnormal-stop / verifyHook reject) rewinds the SDK session to sync with the stored-message rollback `autoRollback` / `retry` does: `applyClaudeAgentRewindOnFailure` sets `claudeAgentResumeAt` to the last assistant turn at-or-before the savepoint (repointing `claudeAgentSessionId` to that anchor's stamped owning session when present — see Rollback as metadata), or drops the session entirely on a failed first turn (no prior assistant → a fresh session is the clean retry — same logic as the parent chat's `computeClaudeAgentRewindBefore`). A **manual rollback from the minion overlay** routes through `deleteMessageAndAfter`, whose `GremlinServer` handler calls `applyClaudeAgentRewindOnRollback` to set the same pair from the last assistant turn at-or-before the kept tail (or drop the session when nothing assistant-bearing is kept) before trimming the messages — the rollback analogue of the parent chat's `computeClaudeAgentRewindKeeping`, and gated to minion chats since `getMinionChat` returns null for ordinary chats (which patch their own rewind frontend-side). (claude-agent is server-only, so worker mode never reaches this branch.)
- **Event plumbing.** `agenticLoopGenerator` emits `claude_agent_turn` after each successful claude-agent stream. `ChatRunner` and `minionTool` both consume it to persist the session ID and clear any pending `resumeAt` flag. It also emits `chat_metadata_updated` when the turn's `StreamResult` carries `chatMetadata` (from the bridged `metadata` tool), reusing the normal loop's metadata event path. After the same `claude_agent_turn` point it folds `providerExtra.claudeAgentReturnValue` (free-run `return` tool) into `storedReturnValue`, so the terminal `complete` result reports it exactly like the normal return-tool path. It likewise folds `providerExtra.claudeAgentActiveHook` (bridged `dummy` register/unregister) by swapping the outer-loop hook runtime and emitting the same `active_hook_changed` event the normal path uses — ChatRunner persists `chat.activeHook`; the minion dispatcher swallows it (parity with the normal path, where minions don't carry hooks). Gate is key-presence, not `typeof === 'string'`, so `null` (deactivate) passes.
- **Live streaming (`includePartialMessages`).** The SDK is asked for raw token-by-token `stream_event`s (`SDKPartialAssistantMessage` = a `BetaRawMessageStreamEvent`) so claude-agent turns render live like every other provider. The partial events are routed through the shared `mapAnthropicEventToStreamChunks` (`src/shared/services/api/anthropicStreamMapper.ts`, reused unchanged) — the partial stream is the **sole live emitter** for text / thinking / web-search-intent. Three chunk types are filtered out of the mapper output: `tool_use` (the MCP side-channel owns bridged tool calls), `token_usage` (the `result` message is the authoritative subscription-usage source), and `web_search.result`/`web_fetch.result` (the `assistant` branch is the single results emitter — the assembler's result handler appends, so it must run once). **The SDK's actual message shape:** for one model turn it emits a `message_start`/`message_stop` pair of `stream_event`s wrapping the token deltas, PLUS a separate coalesced `assistant` message **per finished content block** (thinking, text, tool*use each arrive as their own `assistant`, interleaved with that block's partial deltas) — \_not* one batched `assistant` per Beta message. So the partial stream and the per-block `assistant` messages describe the same content twice. Reconciliation is a single per-turn flag, `partialsActive`, set on the first `stream_event`: once partials are streaming, every per-block `assistant` is **`fullContent` + metadata only** (no re-emit → no double-render or block-boundary corruption); the partial stream alone renders text/thinking live. The lone exception is `*_tool_result` blocks, which the partial stream never emits (filtered) — the `assistant` branch is their sole emitter, always. When the CLI never streams partials (older SDK / not honored), `partialsActive` stays false and the per-block `assistant` messages emit the old way (graceful degradation). `result.textContent` (`textBuf`) comes from the partial deltas when streaming, else from the coalesced blocks — one source, so it matches what the assembler rendered (incl. recovered partial text on a cut-off turn). _History note:_ an earlier per-message / per-content-kind FIFO "coverage queue" was wrong for this shape — `message_stop` lands after all the per-block `assistant` messages, so the queue was always empty when each `assistant` was processed (→ double-render) and the one entry it did push was consumed by the next Beta message's first block (off-by-one). The per-turn flag replaced it.
- **Empty-turn surfacing.** A claude-agent turn can close `subtype=success` / `stop=end_turn` while rendering nothing — the SDK swallows the real signal in places the result message doesn't echo. The client captures, per turn: the assistant `BetaMessage.stop_reason` (`pause_turn` / `refusal` / `max_tokens` / `model_context_window_exceeded`) — also read from the partial `message_delta.delta.stop_reason`; the assistant-level `error` (`rate_limit` / `max_output_tokens` / `server_error` / `billing_error` / `overloaded`); the latest `rate_limit_event.status` (`rejected` means the subscription quota was actually hit); and refusal `stop_details` (`{ category, explanation }`, from either the coalesced `BetaMessage` or the partial `message_delta`). **Refusals always error** — whenever `stop_reason === 'refusal'`, `result.error` is set to `claude-agent: refused — <explanation> (category: <cat>)` even if partial text streamed first (`finalizeWithError` keeps the streamed blocks + appends the error). The hard-failure triggers — `hardAssistantError` / `badStop` / `rate_limit rejected` — fire whenever the turn produced no text and no thinking; they recover real signals the SDK buried under `subtype=success`, so they're unconditional (parity with how other providers surface a 429 / overloaded / context-overflow natively from HTTP status / stop_reason). The lone judgment-call trigger, `thinkingOnly` (omitted thinking, no text, no tool call, no distinguishing signal), is **not** a recovered failure — it fires only under the apiDef's `treatEmptyOutputAsError` opt-in, the same switch the loop applies to the structurally identical no-thinking empty turn. This refusal-first → empty-turn decision is the pure, independently unit-tested `classifyTurnError(...)` helper (the caller applies it only when no `resultError` is already set, so a non-success `result` subtype still wins). A milder fallback runs first: when no text block was produced at all but the result message carried a `result` string, that text is adopted — guarded on `sawTextBlock` (not just an empty `textBuf`) so a turn with real text blocks never collapses into the flat result string. `rateLimitStatus` rides out on `providerExtra`. **Truthful stopReason:** the session-level `result.stop_reason` is often a generic `end_turn` even when the assistant message ended badly, so `StreamResult.stopReason` prefers the assistant-level reason when it's in `BAD_STOP_REASONS` (`surfacedStopReason`) — a mid-text `max_tokens` truncation (e.g. the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` cap firing mid-answer) now reaches the stored message, so minions rewind/retry via their abnormal-stop gate and parent chats get the ⚠️ Truncated badge (accept-the-turn convention, matching the direct AnthropicClient: partial text stands, no forced error). Benign mid-turn values (`tool_use` between bridged calls) never override the session value. **Logging:** always-on (`console.debug`) — every coarse SDK message named by `type`/`subtype`, the stream lifecycle events named (`message_start` / `content_block_start`+block type / `content_block_stop` / `message_delta` / `message_stop`, skipping the per-token `content_block_delta`), each thinking block's length, the result message's `num_turns` (also echoed in the stream-complete summary), an explicit `REFUSAL` line (category only), the `turn reclassified as error (fallback)` line when `classifyTurnError` recovers a hidden failure, plus the failure-explaining `rate_limit` / `api_retry` / `assistant stop_reason` / `assistant error` diagnostics, `PostToolUseFailure` tool names, and the result-text adoption fallback. Gated on `CLAUDE_AGENT_DEBUG=1` (`dbg()` helper) — anything conversation-derived (thinking content, refusal explanations, tool-error strings), the chatty per-partial-event detail, coalesced-block dumps, and the prompt/options dumps. **Timestamps:** none of these lines stamp themselves — server mode installs a process-wide `console.*` wrapper (`src/server/installLogTimestamps.ts`, called first thing in `nodeEntry.ts` + the standalone VFS server's `entry.ts`) that prefixes every log with a full-ISO timestamp, so interleaved request/turn lines correlate. It folds the timestamp into the format string so `%s`/`%d`/`%o` specifiers survive, and it's server-only (the shared `console.debug` calls in `src/shared/` get stamped in server mode, untouched in the worker/browser).
- **Fallback handling.** The SDK can hand a request to a different model (e.g. `claude-fable-5` → `claude-opus-4-8`), surfaced as a `{ type: 'fallback', from: { model }, to: { model } }` assistant content block. We state the model handoff as a fact and make **no** claim about _why_ (the block doesn't say — not necessarily a "risky" prompt). The block-dispatch loop in `handleSdkMessage` handles it via the per-definition `advancedSettings.treatFallbackAsError` opt-in: **on** → set `result.error` to `describeFallback(from, to)` (`claude-agent: request handled by <to> instead of <from>`), the same `resultError` → `finalizeWithError` → `status: 'error'` path a refusal takes (the SDK has already produced the fallback response by the time we see the block, so this surfaces the handoff as an error rather than truly aborting generation); **off** (default) → emit a `fallback` StreamChunk carrying `fromModel`/`toModel` that the assembler turns into a `FallbackRenderBlock` (category `text`, rendered inline as an amber `ℹ️` notice by `TextGroupView`'s `FallbackSegment`) and keep the response. The chunk is emitted unconditionally (like `*_tool_result`) since the partial stream never carries a fallback block. `sawFallback` feeds `classifyTurnError` so a notice-only turn doesn't trip the empty-output classifier. The whole block is dumped via `dbg('[claudeAgent] fallback block %o', block)` under `CLAUDE_AGENT_DEBUG=1` to expose any extra SDK fields worth surfacing. The toggle is reachable from the per-provider **Advanced** button in the list (the add-new form hides the advanced surface for claude-agent).

### ChatGPT Subscription Provider

Bills a ChatGPT Plus/Pro/Team plan by speaking the Codex CLI's own login: OAuth against `auth.openai.com` with the CLI's public client id (`app_EMoamEEZ73f0CkXaXp7hrann`), then the Responses wire format against `https://chatgpt.com/backend-api/codex`. There is no OpenAI SDK/CLI path for this — the "Sign in with ChatGPT" identity product only returns name/email/avatar. OpenAI publicly tolerates third-party harnesses on subscription sign-in (OpenCode, Pi, OpenClaw run on it) but nothing is contractual and one short ban wave happened in January 2026; personal use in your own tool is the tolerated shape. Not for resale or multi-user hosting.

- **Both modes.** `ChatgptSubscriptionClient` (`src/shared/services/api/chatgptSubscriptionClient.ts`) is plain `fetch` + the `openai` SDK, registered in `APIService` like any other client. Worker mode **requires** the definition's CORS proxy (`proxyUrl`) because neither `chatgpt.com` nor `auth.openai.com` answers browser preflights; the proxy's `ALLOWED_TARGETS` must include both hosts. Server mode hits them directly. `buildProxiedRequest` (`proxyConfig.ts`) routes raw fetches to arbitrary hosts through the same proxy; `getProxyConfig` targets the backend base URL for the SDK.
- **Sign-in flows** (`chatgptOAuth.ts`, pure + fetch-injected; RPC handlers in `chatgptOAuthRpc.ts`; UI in `ChatgptSignInPanel`): _device code_ — `chatgptOAuthDeviceStart` → `POST /api/accounts/deviceauth/usercode` → the user types the code at `auth.openai.com/codex/device`; the frontend polls `chatgptOAuthDevicePoll` every `interval` seconds (403/404 = pending, 15-minute give-up) until the backend exchanges the returned `authorization_code` + `code_verifier` for tokens. _Manual-paste PKCE_ — `chatgptOAuthAuthorizeUrl` returns the authorize URL plus `codeVerifier`/`state`, which the frontend holds in memory; the browser lands on `http://localhost:1455/auth/callback?code=…` (fails to load — expected), the user pastes that URL, and `chatgptOAuthExchange` checks `state` and exchanges. Both persist `APIDefinition.oauth` after re-reading the row. The backend keeps no in-flight state. Sign-in needs a persisted definition, so the add form says "save, then sign in from Edit".
- **Token ownership.** Refresh tokens rotate and a reused one is rejected permanently (`refresh_token_reused`), so `oauth` is backend-owned: `GremlinServer`'s `saveAPIDefinition` writes `{ ...caller, oauth: stored }` and only the sign-in handlers, sign-out, and the refresher touch the field. `ensureFreshTokens` re-reads the row (the definition handed to `sendMessageStream` is a loop-time snapshot; a sibling minion may already have rotated), refreshes 5 minutes before expiry under a module-level per-definition in-flight promise (one refresh for concurrent callers), persists the rotated pair, and on a permanent failure (`refresh_token_expired|reused|invalidated`, `invalid_grant`, 401) clears `oauth` and surfaces "sign in again". One engine per process makes the in-memory lock sufficient; two processes sharing a SQLite file, or a backup restored on a second install, are two rotators and will lock each other out — sign in again there.
- **Request shaping** (`finalizeRequestParams` hook on `ResponsesClient`): the system prompt moves from the leading `system` input item into `instructions` (`You are a helpful assistant.` when the project has none — the backend wants it non-empty); `max_output_tokens` and `service_tier` are dropped; `include: ["reasoning.encrypted_content"]` is forced; every input item loses its server-minted `id`; `store: false` stays. Streaming is forced on (`supportsNonStreaming() === false`) because the backend rejects `stream: false`. Headers: `Authorization: Bearer <access>`, `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`, `originator: codex_cli_rs`. The accumulator stream path is forced on (the SDK's `.stream()` snapshot accumulator is exactly what breaks on non-stock backends). `ResponsesClient.ownFamily` is `'chatgpt-subscription'` so stored history (encrypted reasoning, function_call items) replays verbatim; a chat moved to a plain `responses_api` definition takes the cross-model reconstruction path instead of replaying chatgpt.com-minted encrypted reasoning at api.openai.com.
- **Errors.** 401 → "sign in again"; a 404/429 whose body mentions `usage_limit_reached` / `rate_limit_exceeded` → subscription usage limit; the not-signed-in `ChatgptOAuthError` surfaces as `StreamResult.error` without the "Invalid API key" wording. Quota headers (`x-codex-primary-used-percent`, `x-codex-primary-reset-at`, `x-codex-secondary-*`, `x-codex-credits-*`) are exposed by the cors-proxy (`Access-Control-Expose-Headers`) but not yet read — see the pending checklist.
- **Models.** `GET /models` on the backend (authenticated) → `{ models: [{ slug, display_name, visibility, context_window, supported_reasoning_levels, … }] }`; only `visibility: "list"` entries are shown, `context_window` overlays the curated metadata (which is borrowed from `responses_api` entries via an apiType alias in `buildModelKnowledgeStorage`), and the backend's effort list fills in only when metadata has none. Before sign-in or on any failure the static `CHATGPT_SUBSCRIPTION_FALLBACK_MODELS` list is returned so the picker is never empty. Extra Model IDs / "use only my list" work as for claude-agent.
- **Cost.** Defaults to metadata (API-list) prices so the chat totals show what the same usage _would_ have cost per token; the Advanced "Subscription service" checkbox (`advancedSettings.isSubscription`, read through `isSubscriptionApiDefinition()` in `src/shared/protocol/apiDefinition.ts`) switches to $0 tracking, same as for claude-agent. The definition card carries a yellow banner stating which mode is active. The thinking / Anthropic / flex knobs are hidden for this type. Badges read `isChatgptSignedIn()`: "Signed in" / "Not signed in".
- **Prompt caching rides the headers, not `prompt_cache_key`.** This backend derives cache affinity from the `session_id` / `conversation_id` request headers the Codex CLI sends on every `/responses` call, not from the body field the way `api.openai.com` does. Without them `cached_tokens` comes back zero no matter how stable the prefix is — measured upstream at 0 vs 40k cached tokens with only the header differing ([openai/codex#44716](https://github.com/openai/codex/issues/44716)). Confirmed against the live backend. `ChatgptSubscriptionClient.requestHeaders` sends both, set to the same `cacheRoutingKey` that rides as `prompt_cache_key`, mirroring Codex using one conversation id for all three. The key is a 64-char sha256 hex digest and the backend 400s a `prompt_cache_key` over 64 chars, so it sits exactly at the ceiling — don't swap in a longer or prefixed digest. `cacheRoutingScope: 'chat'` is the Codex-native one-id-per-conversation shape; `project` scope shares one session id across a project's chats and still caches, since the id is stable within a loop either way.
- **Still unverified against the live backend** (settle at first manual run): the trailing prefill assistant item. `as-file` injection is now correctly downgraded to `separate-block` — `responsesClient` was passing a hardcoded `'responses_api'` to `effectiveInjectionMode` instead of `this.ownFamily`, so `input_file` blocks were reaching the backend against the documented intent.

**AnthropicClient Bedrock Support:**

`AnthropicClient` can route through AWS Bedrock using `@anthropic-ai/bedrock-sdk` as a drop-in replacement. This provides a simpler alternative to `BedrockClient` for Claude models on Bedrock.

- **Endpoint Detection**: `baseUrl` is checked for Bedrock patterns
- **Shorthand Format**: `bedrock:us-east-2` - SDK auto-generates URL from region
- **Full URL Format**: `https://bedrock-runtime.us-east-2.amazonaws.com` (for custom endpoints/proxies)
- **Authentication**: Bedrock API key passed via the SDK's native `apiKey` option (built by `buildBedrockClientOptions`) — the SDK emits `Authorization: Bearer <key>`. Do not use `skipAuth`/`defaultHeaders`: `skipAuth` deletes the Authorization header in `prepareRequest`. With no key, the SDK falls back to SigV4 via the AWS credential chain.
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
- In adaptive mode, `output_config.effort` comes from `mapAnthropicEffort()` — omitted entirely when the model advertises no `supportedReasoningEfforts`

**Stream Mapper Pattern:**

- Separates provider-specific event mapping from client logic
- Event → MapperState → StreamChunk[] (stateful transformation)
- Mappers: `anthropicStreamMapper.ts`, `responsesStreamMapper.ts`, `completionStreamMapper.ts`, `bedrockStreamMapper.ts`
- `completionFullContentAccumulator.ts` - Accumulates streaming chunks to build fullContent for Chat Completions (content + tool_calls + reasoning, including the `reasoning_details` merge — see Chat Completions reasoning round-trip)
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
  - **System prompt mode**: Injects memory listing + README.md into system prompt (toggle in Project Settings). README.md is capped at 64k chars (`README_MAX_CHARS`), truncated on a line boundary with a note pointing at `view` + `view_range` for the rest. The listing is depth-bounded (2 levels), not char-bounded.
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
- Legacy non-user messages without `renderingContent` get a text group backfilled from `content` at the wire boundary (`prepareMessageForWire` in `shared/engine/messageWire.ts`, same hook as the `toolUseBlocks` extraction); `AssistantMessageBubble` also guards with `?? []` for locally constructed messages

**Component Structure:**

```
MessageList.tsx                    # Container with virtual scrolling
├── MessageBubble.tsx              # Container with virtual scrolling logic, delegates rendering
│   ├── UserMessageBubble.tsx      # User messages (blue bubble, attachments, edit/fork/copy/dump JSON)
│   ├── ToolResultBubble.tsx       # Tool result messages (role: USER with tool_result blocks, delete action)
│   ├── AssistantMessageBubble.tsx # Assistant messages (renderingContent; legacy backfill happens wire-side)
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

- **Reasoning Effort** (shared): offers all seven levels regardless of model; each client clamps to what the resolved model accepts, so an unsupported pick degrades rather than erroring (and is preserved if you switch back to a model that supports it)
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

- `src/shared/services/tools/memoryTool.ts` - Tool implementation
- `src/shared/services/vfs/index.ts` - Barrel re-export
- `src/shared/services/vfs/localVfsAdapter.ts` - Locked wrappers + compound operations (`copyFile`, `createFileGuarded`, `ensureDirAndWrite`) over the service
- `src/shared/services/vfs/vfsService.ts` - Unlocked VFS internals with tree structure and versioning, built once per server (`BackendDeps.vfsService`)

Other tools see `/memories` as read-only unless their own `memoriesWritable` option is on (filesystem and JavaScript; see their Readonly Enforcement notes). `isMemoriesPath()` in `memoryTool.ts` is the shared path check.

**Commands (Anthropic spec compliant):**

| Command       | Parameters                                | Description                                                                          |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `view`        | `path`, `view_range?`, `withLineNumbers?` | View directory listing (with file sizes) or file contents (line numbers per setting) |
| `create`      | `path`, `file_text`, `overwrite?`         | Create new file (error if exists). `overwrite` replaces existing                     |
| `str_replace` | `path`, `old_str`, `new_str?`             | Replace unique string. Omitting `new_str` deletes matched text                       |
| `insert`      | `path`, `insert_line`, `insert_text`      | Insert text at specific line (0-indexed)                                             |
| `delete`      | `path`                                    | Delete file or directory (soft delete)                                               |
| `rename`      | `old_path`, `new_path`, `overwrite?`      | Rename/move file. Errors if destination exists unless `overwrite: true`              |
| `mkdir`       | `path`                                    | Create a new directory                                                               |
| `append`      | `path`, `file_text`                       | Append text (auto-adds trailing newline), or create file if not exists               |
| `append_raw`  | `path`, `file_text`                       | Append text verbatim (no trailing newline), or create file if not exists             |
| `view-all`    | `paths`                                   | Batch read multiple files, returns concatenated content with `=== path ===` headers  |

**VFS Architecture:**

- Root path: `/memories` (all paths normalized to this)
- Tree-structured filesystem stored in `vfs_meta` table (JSON tree per project, one encrypted blob)
- Files stored in `vfs_files` table with stable UUID (`fileId`) that survives renames
- Per-file versioning in `vfs_versions` table (auto-versioned on every update)
- Soft-delete with orphan tracking for displaced files during renames
- 999,999 line limit per file (returns error if exceeded)
- `view` on any directory (root or nested) lists 2 levels deep. The handler asks `adapter.isDirectory` first; the `NOT_A_FILE` catch is only a fallback for adapters whose `isDirectory` and `readFile` disagree.
- **Server mode (`FilesystemVfsAdapter`) error parity**: raw Node fs errors are translated to the `VfsError` codes the tools branch on (`ENOENT`/`ENOTDIR` → `PATH_NOT_FOUND`, `EISDIR` → `NOT_A_FILE`, `EEXIST` → `FILE_EXISTS`, `ENOTEMPTY` → `DESTINATION_EXISTS`) via `withNodeErrors`. Without it the model saw `ENOENT: ... open '/srv/...'` with the host path in it. The HTTP facade maps `EISDIR` → 400 for the remote path.
- **Server mode copies: reflink into fresh files, truncating write onto existing ones**: `fs.copyFile` fchmod()s the destination to mirror the source and unlinks it when that fails. On a group-shared tree where the destination belongs to another user that is EPERM, so the copy failed _and_ deleted the file. `cloneFile` in `vfsEngine/versioning.ts` calls `fs.copyFile` with `COPYFILE_EXCL | COPYFILE_FICLONE`, so it only ever writes a file it just created (our own, fchmod is safe); `EEXIST` falls back to `copyFileContents` (read + `fs.writeFile`), which keeps the existing inode, owner and mode. On CoW filesystems (btrfs, XFS reflink, bcachefs, OpenZFS 2.2+) `FICLONE` makes every version snapshot a block-sharing clone, so an append costs O(delta) plus metadata instead of a full re-read and copy; elsewhere libuv does an in-kernel copy. `saveVersion`, `writeFileWithHistory` and `copyFile` use it. Hard links were rejected: appends and outside editors write the live inode in place, which would rewrite the saved version.
- **Server mode overwrite-rename**: `renameVersionDir` removes the destination's `.ver/` before moving the source's, matching worker mode (which orphans the destination node). Previously `fs.rename` onto the non-empty `.ver/` failed with ENOTEMPTY (adapter: raw error after the file already moved; engine: swallowed silently), leaving the source history stranded and the destination's stale history attached to the moved file. `fs.rename` itself is left alone: it swaps directory entries, never chmods, and is atomic, so it has none of the copy quirk. Two caveats: the moved file keeps the source's owner (it is the source inode), and a directory cannot be overwrite-renamed onto a non-empty directory (surfaces as `DESTINATION_EXISTS`). The HTTP `/rename` route has no overwrite flag and always clobbers; `RemoteVfsAdapter.rename` enforces the guard client-side via `/exists`, same check-then-act as its `copyFile`.
- **Namespace isolation**: `VfsAdapter` instances are bound to a namespace at creation time. `LocalVfsAdapter(projectId, namespace)` resolves paths through the namespace (e.g., `/minions/coder` + `/memories/note.md` → `/minions/coder/memories/note.md`). `resolveNamespacedPath()` handles resolution with path traversal mitigation. Tool handlers receive a pre-bound adapter via `ToolContext.vfsAdapter`.
- **Cross-namespace mounts**: Two shared paths bypass namespace prefixing:
  - `/share` — read-only for namespaced callers (main agent has write access). Enforced via `assertWritable()` in VFS core, throws `VfsError('READONLY')`.
  - `/sharerw` — read-write for all, including namespaced callers. Enables minion-to-minion collaboration.
- **Mount root protection**: `/share` directory root cannot be deleted or renamed (throws `INVALID_PATH`). `/sharerw` has no root protection — the main agent can delete it if needed.
- **Concurrency control**: `LocalVfsAdapter` acquires a per-project promise chain (`treeLock.ts`) once per operation, including compound multi-step operations like `copyFile` and `ensureDirAndWrite`. `vfsService.ts` contains unlocked internal functions. Prevents lost-update race conditions and TOCTOU bugs.
- **Encrypted-mode hot paths** (`vfsService.ts`):
  - **Tree cache**: `loadTree` keeps the decrypted tree JSON per project, keyed by the ciphertext it came from (32 projects max). A load whose record still has that exact ciphertext skips base64 + AES + gunzip; any other writer (another device, key rotation, import) produces new ciphertext and simply misses. JSON (not the parsed tree) is cached because ops mutate the tree they load. `saveTree` refills it, `clearVfs` drops it.
  - **`VfsNode.size`**: stored-content length, kept on the node by every write path, so `readDir` / `stat` never decrypt file content. Legacy nodes without it are read once and backfilled by `readDir`.
  - **`appendFile`** is one tree load + one content load (it was exists → stat → read → update: 4 tree loads, 3 content decrypts — slower than read + write from JS). Every append still snapshots the old content as a version.
  - **`deletePaths(paths, recursive)`**: one tree load, per-path soft delete, one tree save. Best-effort with per-path `{ path, error? }` results; a path under one already deleted in the batch counts as deleted (`isCoveredByDeleted` in `vfsPaths.ts`, shared by all backends). Missing / soft-deleted → `PATH_NOT_FOUND`, directory without `recursive` → `NOT_A_FILE`, the caller's root (namespace root when namespaced) and `/share` → `INVALID_PATH`. `deletePath` is a one-path batch on every adapter, so a missing path now throws `PATH_NOT_FOUND` in server / remote mode too (it used to be a silent no-op there).
  - **`mkdir(path, { recursive })`**: parents are always created (as `writeFile` / `appendFile` always did); `recursive` turns an existing directory into a no-op instead of `DIR_EXISTS`. Filesystem and remote mode now return `DIR_EXISTS` too (they used to succeed silently).
  - Updates keep `minStoredVersion` (it was dropped on every write after `dropOldVersions`).
  - `EncryptionCore` imports the AES key once per CEK and uses the chunked / `Buffer` base64 codec from `protocol/binaryEncoding.ts`; the per-byte codec was roughly half of each encrypt/decrypt.
- **Batch delete over HTTP**: `POST /api/rm-many` (`{ paths, recursive }` → `{ results }`), implemented once in `fsEngine.deletePaths` and shared by `FilesystemVfsAdapter`. `RemoteVfsAdapter` falls back to per-path `/stat` + `/rm` / `/rmdir` when an older VFS server answers 404. `rmdir('/')` is refused on every adapter; `RemoteVfsAdapter.clearVfs` calls `/rmdir` on the root directly.
- **VFS server per-request cost**: project-root mkdir is async (still per request — clearing a project removes the root), realpath is memoized per router; preflights are cached (`Access-Control-Max-Age: 600`). `FilesystemVfsAdapter` creates/canonicalizes its root lazily on first use instead of with sync calls in the constructor; `hasVfs` checks without creating it.

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

Client-side tool that provides LLM access to the project's virtual filesystem. Similar to the memory tool but operates from VFS root (`/`) with `/memories` as readonly unless the `memoriesWritable` option is on. Useful for storing code, data files, configuration, and scripts. Supports both text and binary files.

**Files:**

- `src/services/tools/fsTool.ts` - Tool implementation with `FsToolInstance` class

**Commands:**

| Command       | Parameters                                          | Description                                                                                                 |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `view`        | `path`, `view_range?`, `depth?`, `withLineNumbers?` | View directory listing (`depth` levels, default 1, max 5), text file (line numbers per setting), or dataUrl |
| `create`      | `path`, `file_text`, `overwrite?`                   | Create new file (accepts text or dataUrl for binary). `overwrite` replaces existing                         |
| `str_replace` | `path`, `old_str`, `new_str?`                       | Replace unique string (text files only). Omitting `new_str` deletes matched text                            |
| `insert`      | `path`, `insert_line`, `insert_text`                | Insert text at specific line (text files only)                                                              |
| `delete`      | `path`                                              | Delete file or directory (soft delete)                                                                      |
| `rename`      | `old_path`, `new_path`, `overwrite?`                | Rename/move file. Errors if destination exists unless `overwrite: true`                                     |
| `mkdir`       | `path`                                              | Create a new directory                                                                                      |
| `append`      | `path`, `file_text`                                 | Append text (auto-adds trailing newline), or create file if not exists                                      |
| `append_raw`  | `path`, `file_text`                                 | Append text verbatim (no trailing newline), or create file if not exists                                    |
| `view-all`    | `paths`                                             | Batch read multiple files, returns concatenated content with `=== path ===` headers                         |

**Line-number display precedence** (fs + memory tool output, `resolveNoLineNumbers` in `formatFileContent.ts`):

1. Per-call `withLineNumbers` (positive boolean tool input) — wins if set.
2. Loop-level `fileLineNumbers` (`AgenticLoopOptions`/`ToolContext`, positive) — wins over the project setting. Set by the minion tool's `fileLineNumbers` input; `undefined` on the root loop.
3. Project `noLineNumbers` (negative) — default.

Minion `injectFiles` formatting follows the same override, minus the per-call layer: effective `fileLineNumbers` (call → persisted `MinionChat`) else `!project.noLineNumbers`. The minion sub-loop threads both `noLineNumbers` and `fileLineNumbers` into its `loopOptions`, so a minion's own reads resolve the same precedence.

**Binary File Support:**

- **Create binary files**: Pass dataUrl format (`data:<mime>;base64,<data>`) as `file_text`
- **View binary files**: Returns `Binary file {path} ({mime}):\n{dataUrl}` format
- **Text operations blocked**: `str_replace`, `insert`, and `append` return error on binary files
- MIME detection via magic bytes (JPEG, PNG, GIF, WebP, PDF, ZIP)
- File type change (text↔binary or MIME change) orphans old file, creates new

**Readonly Enforcement:**

- `/memories` path and all its contents are readonly by default (tool-level). `checkMemoriesWrite()` runs once in the dispatcher before any handler: `create` / `str_replace` / `insert` / `mkdir` / `append` / `append_raw` / `delete` check `path`, `rename` checks both ends, `copy` only the destination. Reads, including copying out of `/memories`, always work.
- `memoriesWritable` tool option (default `false`) skips that check. The description's first sentence switches with it ("except /memories (readonly…)" vs "including /memories (shared with the memory tool)"). With the option off, the description is byte-identical to the pre-option text, so existing projects keep their prompt cache.
- `/share` is read-only for namespaced callers (VFS-level, enforced by `assertWritable()` in VFS core) regardless of the option
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

- **Event Loop**: microtasks drained via `executePendingJobs(256)` batches, yielding to the host at most every 10 ms (`setImmediate` / `MessageChannel`), then host-scheduled timers fired
- **Timeout**: 300s execution limit via `setInterruptHandler()` (kills infinite loops mid-execution); also caps total real timer sleep
- **Console Capture**: All console methods (log, warn, error, info, debug) captured

**Event Loop Semantics:**

1. User code evaluates synchronously
2. While there are pending jobs, fs ops, or scheduled timers:
   - Check 300s timeout deadline
   - Drain pending fs operations
   - If a microtask is pending: if 10 ms passed since the last yield, yield to host (`setImmediate` in Node, `MessageChannel` in the worker), then run up to 256 with `executePendingJobs(256)`, loop. The old per-job `setTimeout(0)` hop cost ~1.2 ms per `await` in Node (4 ms once browsers clamp nested timers): 10k awaits took 11.6 s, now 62 ms.
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

| Method                                     | Returns                | Description                                                                                                                                                                   |
| ------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readFile(path)`                           | `Promise<ArrayBuffer>` | Read file as binary (Node.js Buffer-like)                                                                                                                                     |
| `readFile(path, encoding)`                 | `Promise<string>`      | Read file as string with encoding                                                                                                                                             |
| `writeFile(path, data, options?)`          | `Promise<void>`        | Create/overwrite file (string or binary); creates missing parents; options ignored                                                                                            |
| `appendFile(path, text, options?)`         | `Promise<void>`        | Append a string in one backend call (atomic, no read round trip); creates file + parents                                                                                      |
| `exists(path)`                             | `Promise<boolean>`     | Check if path exists                                                                                                                                                          |
| `mkdir(path, { recursive }?)`              | `Promise<void>`        | Create directory and missing parents; `recursive` makes an existing dir a no-op                                                                                               |
| `readdir(path)`                            | `Promise<string[]>`    | List directory entries                                                                                                                                                        |
| `unlink(path)`                             | `Promise<void>`        | Delete file                                                                                                                                                                   |
| `rmdir(path)`                              | `Promise<void>`        | Delete directory (recursive)                                                                                                                                                  |
| `rm(path \| paths, { recursive, force }?)` | `Promise<void>`        | Node-style delete; an array is one `deletePaths` batch. Dirs need `recursive`, `force` ignores missing. Best-effort: rejects with the first failure plus a list of the others |
| `rename(oldPath, newPath)`                 | `Promise<void>`        | Move/rename file or directory                                                                                                                                                 |
| `stat(path)`                               | `Promise<StatResult>`  | Get file/directory info                                                                                                                                                       |

`StatResult` type: `{ isFile: boolean, isDirectory: boolean, size: number, readonly: boolean, mtime: Date, isBinary: boolean, mime: string }`

**fs Readonly Enforcement:**

- `/memories` path and all its contents are read-only by default (tool-level check in `FsBridge.isReadonly`)
- The javascript tool's `memoriesWritable` option (default `false`) lifts that; the description's `Note: /memories is read-only.` line switches to "writable" with it. It reaches the bridge as `JsVMContext.create(adapter, loadLib, loadShareLib, { namespace, memoriesWritable })` (`FsBridgeOptions`)
- DUMMY hooks and minion `verifyHook`s don't pass the option, so `/memories` stays read-only for them. They're system-run code, not the javascript tool
- `/share` is read-only for namespaced callers (VFS-level, throws `READONLY` → mapped to `EROFS`)
- Write operations (`writeFile`, `appendFile`, `mkdir`, `unlink`, `rmdir`, `rm`, `rename`) throw `EROFS` error (`rm` reports it per path, even with `force`)
- `stat()` returns `readonly: true` for read-only `/memories` paths and for `/share` paths when namespaced. The namespace comes from `FsBridgeOptions.namespace`: the javascript tool passes `context.namespace` and DUMMY hooks pass the loop's namespace (before that, nobody passed it and `/share` always reported writable)

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

| Parameter                    | Type                 | Required              | Description                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                     | string               | No                    | `'message'` (default) or `'retry'`. Retry rolls back to savepoint and re-executes.                                                                                                                                                                                                                                                                                                              |
| `message`                    | string               | Unless files injected | Task to send to minion. Optional when `injectFiles`/`injectFilesAfter` carry the whole task (see inject-only calls below). For `retry`: omit to re-send original, or provide replacement.                                                                                                                                                                                                       |
| `minionChatId`               | string               | For `retry` action    | Existing minion chat ID to continue or retry                                                                                                                                                                                                                                                                                                                                                    |
| `enableWeb`                  | boolean              | No                    | Enable web search for minion (only exposed when `allowWebSearch` option is true)                                                                                                                                                                                                                                                                                                                |
| `enabledTools`               | string[]             | No                    | Tools for minion (validated against project tools, defaults to none)                                                                                                                                                                                                                                                                                                                            |
| `persona`                    | string               | No                    | Persona name (matches `/minions/<name>.md`). Only when `namespacedMinion` is not `off`.                                                                                                                                                                                                                                                                                                         |
| `model`                      | string               | No                    | Model to use (`apiDefId:modelId`). Only when `namespacedMinion` is not `off` + `models` configured.                                                                                                                                                                                                                                                                                             |
| `displayName`                | string               | No                    | Display name shown in the UI for this minion call. If omitted, persona name is used.                                                                                                                                                                                                                                                                                                            |
| `injectFiles`                | (string \| object)[] | No                    | VFS files to inject as context **before** the message. Each item is a path string, or `{ path, preamble?, postamble? }` where preamble/postamble replace the default `=== path ===` framing (joined to content with newlines). The inline `=== end of files ===` marker is emitted only when at least one file uses default framing. Injection method controlled by `fileInjectionMode` option. |
| `injectFilesAfter`           | (string \| object)[] | No                    | Same as `injectFiles`, but the content lands **after** the message (instructions first, reference material last). The trailing batch never emits `=== end of files ===` — nothing follows it. Both batches share one `fileInjectionMode` / `fileLineNumbers` resolution.                                                                                                                        |
| `verifyHook`                 | string               | No                    | Hook file name (without `.js`) in `/hooks/` to verify minion output before savepoint advances.                                                                                                                                                                                                                                                                                                  |
| `enableReasoning`            | boolean              | No                    | Override reasoning on/off for this call                                                                                                                                                                                                                                                                                                                                                         |
| `reasoningBudgetTokens`      | number               | No                    | Override reasoning budget. 0 = adaptive on supported models.                                                                                                                                                                                                                                                                                                                                    |
| `reasoningEffort`            | string               | No                    | Override reasoning effort (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`)                                                                                                                                                                                                                                                                                                                |
| `verbosity`                  | string               | No                    | Override response length (`low`/`medium`/`high`). OpenAI GPT-5-era models only; ignored elsewhere. Persists on the minion chat.                                                                                                                                                                                                                                                                 |
| `temperature`                | number               | No                    | Override temperature for this call                                                                                                                                                                                                                                                                                                                                                              |
| `maxOutputTokens`            | number               | No                    | Override max output tokens for this call (default: project setting). Persists on the minion chat for follow-up calls.                                                                                                                                                                                                                                                                           |
| `fileInjectionMode`          | string               | No                    | Override file injection mode (`inline`/`separate-block`/`as-file`/`mock-tool-call`)                                                                                                                                                                                                                                                                                                             |
| `fileLineNumbers`            | boolean              | No                    | Override line-number display (true = show). Governs injected files and the minion's own fs/memory reads; a per-read `withLineNumbers` still wins. Persists on the minion chat.                                                                                                                                                                                                                  |
| `systemPrompt`               | string               | No                    | Additional system prompt text, appended after persona/configured prompt                                                                                                                                                                                                                                                                                                                         |
| `systemPromptFile`           | string \| string[]   | No                    | VFS file path(s) to system prompt file(s). Single string or array; contents appended after `systemPrompt` in order.                                                                                                                                                                                                                                                                             |
| `prePersonaSystemPromptFile` | string               | No                    | Override the pre-persona prompt file path (default `/minions/_global.md`). Only surfaced when `namespacedMinion` is not `off`. Empty string disables the pre-persona prompt. Missing custom path is a hard error; the default path stays silently optional. Persists on the minion chat.                                                                                                        |
| `nudgeThinking`              | string               | No                    | Text appended to last user message to nudge CoT. Empty string disables. Persists on the minion chat for follow-up calls.                                                                                                                                                                                                                                                                        |
| `allowNesting`               | boolean              | No                    | Grant the spawned minion the ability to spawn its own sub-minions (default off). Only surfaced when the project `allowNesting` option is on; bounded by `maxNestingDepth`. Persists on the minion chat.                                                                                                                                                                                         |
| `availablePersonas`          | string[]             | No                    | Persona set the spawned minion may delegate to (subset of what this minion holds). Only surfaced when namespaced + nesting on. Omit to grant the full set. Persists on the minion chat.                                                                                                                                                                                                         |

**Tool call display:** `renderMinionInput` emits a line for every parameter the caller actually passed, then the message body. Booleans and arrays test `!== undefined`, not truthiness — an explicit `enableWeb: false` or `enabledTools: []` is a real instruction and renders as `Web: disabled` / `Tools: (none)`, while an omitted field stays absent. The display reflects what the LLM asked for, never the resolved defaults. `injectFiles` / `injectFilesAfter` render as separate `Files:` / `FilesAfter:` lines; entries carrying a custom `preamble`/`postamble` are marked `(framed)` since the framing changes what the minion sees. Long free text (`systemPrompt`, `nudgeThinking`) truncates at 80 chars.

**Cloning a minion chat into a real chat:**

`⧉` in the minion overlay header (`MinionChatView` → `CloneMinionChatModal`) calls the
`cloneMinionChat` RPC → `cloneMinionChatToChat` (`src/shared/engine/cloneMinionChat.ts`).
The transcript is copied into a new `Chat` in the minion's project, and
`deriveChatAgentConfigFromMinion` turns the `MinionChat` record into a
`ChatAgentConfig` so the clone keeps behaving like the minion rather than
inheriting the project's identity.

It is an engine orchestrator, not a `UnifiedStorage` method: it needs
`project.toolOptions.minion` and `buildMinionTools`, and putting that in storage
would create a `storage → minionTool → storage` cycle.

Why the clone reproduces the minion's prompt exactly: both sides feed the same
four inputs to `resolveAgentSystemPrompt` — `resolveMinionPromptInputs` for the
minion, `deriveChatAgentConfigFromMinion` for the clone.
`cloneMinionChat.equivalence.test.ts` asserts the resulting base prompts are
string-identical across all four `namespacedMinion` / persona branches.

Caveats, each a decision rather than an omission:

- **`systemPromptMode: 'replace'` is mandatory.** The minion never saw
  `project.systemPrompt`; inheriting it would stack a second agent's
  instructions above the persona's.
- **`prePersonaSystemPromptFile: ''` for non-namespaced minions.** Not a no-op —
  `undefined` would newly pull in `/minions/_global.md` for a minion that never
  read it.
- **Only the tool-level configured `systemPrompt` is snapshotted.** Persona,
  pre-persona and prompt files stay _recipes_ resolved from the VFS every turn,
  so editing `/minions/<persona>.md` still takes effect in the clone.
- **`return` is dropped** and an open trailing `return` call is closed with a
  synthesized `tool_result` (`closeUnresolvedToolUses.ts`) — every provider
  rejects an assistant turn whose tool calls have no results. Siblings called in
  parallel with `return` are closed as errors. Skipped for an `incomplete` tail
  (the incomplete-tail lock owns that, and appending a user message would
  silently unlock the chat) and for claude-agent (the SDK owns its own turn).
- **`minion` is dropped too.** A cloned chat is top-level, so
  `minionAvailablePersonas` would be `undefined` = unrestricted — a privilege
  escalation over the minion, which ran under `minionChat.availablePersonas`. The
  user can tick `minion` on in chat settings and get ordinary top-level
  authority. (If a ceiling is ever wanted: add `availablePersonas` to
  `ChatAgentConfig` and thread it into `AgenticLoopOptions`.)
- **claude-agent** clones inherit the `{sessionId, resumeAt}` pair and fork off
  it on the first send. Both halves or neither: a session without `resumeAt`
  would _append_ the clone's turns into the minion's own file. See Claude Agent
  Provider → Fork on branch, not on rollback for the protect list this requires.
  The expected workflow — clone, then immediately trim the copy back to the turn
  you want to continue from — works because the predicate is the protect list:
  the clone has not sent yet, so its row and the anchor's stamp name the same
  session, and a `row.sessionId !== anchor.sessionId` check would append into
  the minion's file instead of branching.
- **Cost appears twice.** The clone copies the minion's `total*` while the parent
  chat keeps that spend in `minionTotal*`. Nothing double-sums today (the only
  consumer is the per-row display in `ProjectView`), `cloneChat` already sets
  this precedent for forks, and `clonedFromMinionChatId` is the discriminator if
  a project-level aggregate ever lands.
- **A clone and its source share the VFS namespace** `/minions/<persona>` with no
  locking — a pre-existing property of namespaced minions, not new here.
- The chat list needs no event: `ProjectView` unmounts while in `ChatView` and
  refetches on return.

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
8. **Mirror it into the chat layer** if the field is agent identity rather than minion plumbing: add it to `ChatAgentConfig`, resolve it in `resolveChatAgentSettings`, copy it in `deriveChatAgentConfigFromMinion`, and add a row to the chat panel. Skipping this means a cloned minion chat silently loses the override.

**Tool Options:**

- `systemPrompt` (longtext) - Instructions for minion sub-agents
- `model` (ModelReference) - Model for delegated tasks (can use cheaper model)
- `models` (ModelReference[]) - Models the LLM can choose from when calling minions. When non-empty and `namespacedMinion` is not `off`, adds `model` input parameter with enum of `apiDefId:modelId` strings. LLM omitting `model` falls back to default `model` option.
- `allowWebSearch` (boolean, default: false) - Project-level gate for minion web search. Must be enabled for `enableWeb` to work. When disabled, `enableWeb` parameter and web search mention are omitted from the schema/description sent to the LLM.
- `allowNesting` (boolean, default: false) - Project-level **master gate** for nested minions. When off, the `minion` tool is stripped from every minion's toolset. When on, nesting becomes _possible_ but is still gated per-call: a child only receives the `minion` tool when its caller passes `allowNesting: true` (explicit opt-in), within `maxNestingDepth`.
- `maxNestingDepth` (number, default: 3, min: 1, visibleWhen allowNesting) - Hard cap on minion nesting depth (depth 1 = a top-level chat's minion). See **Nested minions** below.
- `returnMode` (select: `no-return`/`both`/`return-only`/`enforced`/`auto-enforced`, default: `both`) - Controls return tool behavior and output format. Migrates from legacy `noReturnTool` and `returnOnly` booleans.
  - `no-return` — Remove return tool from minion toolset
  - `both` — Return tool available + text capture. Result as JSON `{ text, stopReason, hasCoT, minionChatId, result? }`
  - `return-only` — Only return value captured; text suppressed when return tool used. Falls back to text if return not called.
  - `enforced` — Return must be called; warning if not
  - `auto-enforced` — Like `enforced` but auto-retries up to `AUTO_ENFORCE_MAX_RETRIES` (2) times with a reminder message before giving up. A run whose last turn was cut short (stop reason outside `NORMAL_STOP_REASONS`) gets no reminder — it goes straight to the abnormal-stop error
  - Non-`both` modes use simplified format: `<minionChatId>id</minionChatId>\n[<hasCoT />]\ncontent` (`<hasCoT />` self-closing tag present only when true)
- `disableReasoning` (boolean, default: false) - Turn off reasoning/thinking for minion calls regardless of project settings
- `deferReturn` (boolean, default: false, visibleWhen returnMode != no-return) - Return tool stores result without breaking the agentic loop. The loop continues until natural completion, then returns the stored value. Multiple calls overwrite (last wins). Sets `deferReturn` on `AgenticLoopOptions` and injects it into the return tool's options so its description reflects the mode.
- `deferredSoftStopRounds` (number, default: 5, visibleWhen deferReturn) - Rounds after deferred return before injecting stop messages
- `deferredForceStopRounds` (number, default: 10, visibleWhen deferReturn) - Rounds after deferred return before force-stopping the loop
- `returnAckMessage` (text, visibleWhen deferReturn) - Message sent when deferred return stores a result
- `returnDuplicateMessage` (text, visibleWhen deferReturn) - Error sent when return is called again after a result is stored
- `returnEnforceMessage` (text, visibleWhen returnMode=auto-enforced) - Message sent when auto-enforced mode retries because return was not called
- `fileInjectionMode` (select: `inline`/`separate-block`/`as-file`/`mock-tool-call`, default: `inline`) - How injected files are sent to the minion LLM. `inline` splices file text into the message string. `separate-block` sends each file as a separate text content block. `as-file` uses native document/file blocks. `mock-tool-call` inserts synthetic assistant tool_use + user tool_result message pairs (filesystem readFile) — works with all API types except claude-agent, where it (like `as-file`) downgrades to `separate-block` because the SDK owns the session history. The mode governs both injection parameters: `injectFiles` content lands before the message text (leading content blocks in structured modes), `injectFilesAfter` after it (trailing blocks), and in `mock-tool-call` the leading batch's synthetic pairs are emitted before the trailing batch's.
- **Inject-only calls.** `message` may be omitted when at least one file is injected (`hasInjectSpecs`); the file content is the task. `inline` sends the assembled sections with the separators around the absent message trimmed (`buildInlineContent`); the remote human minion gets the same string. `separate-block`/`as-file` store `content: ''` plus the fields, and every API client skips the empty text block (OpenAI and Responses included; Responses still emits one empty `input_text` item for a message with nothing at all). `mock-tool-call` downgrades to `separate-block` for an inject-only call — the synthetic pairs need a preceding user turn with content, and an empty user message is rejected by every provider. A call with neither text nor files is still rejected in Phase 1. The rendered user message keeps its `text` group with `blocks: []` so `UserMessageBubble` can still split leading/trailing file bars on it; the bubble itself is omitted when there is no text and no attachment.
- **Return-tool continuation.** When the previous minion turn ended on a `return` call, the next message becomes that tool's `tool_result`. Injected files are inlined into that tool result whatever `fileInjectionMode` says (a tool result is plain text), and the file bars render around the tool-result group.
- `namespacedMinion` (select: `off`/`persona`/`all`, default: `off`) - Controls persona and VFS namespace behavior. Migrates from legacy boolean (`true` → `all`).
  - `off` — No persona parameter, no namespace. Minions use configured system prompt.
  - `persona` — Persona parameter available. Only minions called with an explicit non-default persona get VFS namespace (`/minions/<persona>/`) and persona prompts. Default/no-persona minions behave like `off` (root VFS, configured system prompt, no `_global.md`).
  - `all` — Everyone namespaced. Default persona maps to `/minions/default/`, reads `_global.md` (path overridable per call via `prePersonaSystemPromptFile`).
- `personaListingMode` (select: `detailed`/`name-only`/`none`, default: `detailed`, visibleWhen namespacedMinion=`persona`/`all`) - Controls how the persona list is injected into the system prompt. `detailed` = name + first-line gist of each persona. `name-only` = names only (skips reading persona bodies). `none` = no persona block injected at all.

**Nested minions (`allowNesting`):**

Off by default. When enabled, a minion can spawn its own sub-minions, hard-capped by `maxNestingDepth`.

- **Depth threading.** `ToolContext.minionDepth` carries the nesting depth (absent/0 = top-level chat). `executeMinion` reads `callerDepth = context.minionDepth ?? 0`; the child it spawns runs at `callerDepth + 1`, threaded onto the child loop via `AgenticLoopOptions.minionDepth` → the loop's `ToolContext`.
- **Hard cap (two layers).** Before any chat is created, `executeMinion` rejects with a clean error when `childDepth > maxNestingDepth` (defense-in-depth). The model never sees a tool it can't use: `resolveChildNesting(projectAllowNesting, childMayNest, childDepth, maxNestingDepth)` gates the `includeMinion` flag, and `buildMinionTools` grants `minion` _authoritatively_ — it drops any model-listed `minion` and re-adds it only when nesting is granted (so `allowNesting: true` alone gives the child the tool, and `enabledTools` can't sneak it in).
- **Per-call capability delegation.** Each spawn hands the child a narrowable subset of the caller's own capability, threaded through `ToolContext` like `minionDepth`:
  - **Nesting grant** (`allowNesting` input, **default off**): the caller decides per-spawn whether the child may itself nest. `childMayNest = input.allowNesting ?? chat.allowNesting ?? false`. Bounded by the project master gate + depth cap (can only narrow). So the root controls whether a minion may spawn, and a minion controls whether _its_ minion may.
  - **Persona allowlist** (`availablePersonas` input): the caller grants the child a persona set it may delegate to. `ToolContext.minionAvailablePersonas` is the **ceiling** (undefined = unrestricted root). `executeMinion` validates via `checkPersonaDelegation(ceiling, persona, grant)` — the child's persona must be in the ceiling (`'default'` exempt), and `availablePersonas` ⊆ ceiling — then threads the effective set (`grant ?? ceiling`, i.e. inherit-when-omitted) onto the child loop (`AgenticLoopOptions.minionAvailablePersonas`) and into `SystemPromptContext.minionAvailablePersonas`, which filters the child's persona listing in `getMinionSystemPromptInjection`. Both fields persist on `MinionChat` for continuations.
- **Abort cascade chains for free.** Each level wires the existing parent→child one-shot abort listener, so aborting the top loop cascades down the whole subtree. Child→parent stays unidirectional.
- **Sidebar** renders the loop tree to arbitrary depth (`RunningLoopsSection` recursive walk + depth-based indent in `ActiveLoopRow`); grandchild loops are no longer orphaned.
- **Minion-chat overlay** is a stack (`ChatView.minionChatStack`): "View Chat" inside a minion overlay drills in (pushes a layer) instead of replacing; back/close pops one layer.
- **Final rendering is recursive already** — a completed sub-minion's `renderingGroups` propagate up via the parent minion's `message_created` finalize delta, and the frontend tool-result chain recurses. **Known limitation (Phase 2 follow-up):** _live_ streaming is swallowed at depth ≥ 2 — `executeMinion`'s event loop drops a child loop's in-flight `tool_groups_delta`/`tool_block_update`/`pending_tool_result`, so a grandchild's progress only appears once it completes. Forwarding in-flight nested state (plus `LoopRegistry` replay-cache parity) is the deferred upgrade.

**Persona System (namespacedMinion `persona` or `all`):**

When `namespacedMinion` is not `off`, `persona` input parameter and system prompt injection are enabled:

- Persona files stored at `/minions/<name>.md` in root VFS. Content becomes the minion's system prompt.
- `/minions/_global.md` (optional) — content prepended to the system prompt for namespaced personas. Read from root VFS before persona-specific prompt. The path is overridable per call via `prePersonaSystemPromptFile` (persists on the minion chat); `''` disables the pre-persona prompt entirely. A custom path that fails to read is a hard error (stated intent), while the missing default stays silently optional.
- `persona` input parameter selects a persona (omit for `default`). Namespaced personas map to namespace `/minions/<persona>`.
- In `persona` mode, default/no-persona minions stay in root VFS with no namespace and no `_global.md`.
- Namespace flows through the agentic loop: `AgenticLoopOptions.namespace` → `ToolContext.vfsAdapter` (pre-bound adapter) → all VFS calls in memory, filesystem, JavaScript, sketchbook, and DUMMY tools. `ToolContext.createVfsAdapter` factory lets minion tool create adapters for other namespaces.
- A persona's `/memories/README.md` resolves to `/minions/<persona>/memories/README.md` in VFS storage.
- `/share` paths bypass namespace prefixing — read-only for namespaced minions (main agent writes, minions read).
- `/sharerw` paths bypass namespace prefixing — read-write for all, enables minion-to-minion collaboration.
- System prompt injection lists available personas from `/minions/*.md`. The `personaListingMode` option controls the shape: `detailed` (name + first-line gist, default), `name-only` (names only), or `none` (no injection).

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
- Stash reuse is gated on a **true retry** (`resolveRetryStash`): the rolled-back message's stashed `fullContent`/`renderingContent`/injected-files are reused only when the message being sent equals the recovered original. A different message after a failed turn builds fresh content — reusing the stash would render the old message in the mirror and, for fullContent-canon providers, send the old message to the model. `mock-tool-call` mode stores `injectedFiles`/`injectedFilesAfter`/`injectionMode` on the user message just like the structured modes (API clients ignore the stored `'mock-tool-call'` value — no emit branch matches) so a retry can rebuild the synthetic tool pairs the rollback deleted; without the fields the re-run would silently drop the file content. An inject-only structured-mode message has empty text; `rollbackToSavepoint` recovers it as `''` (not "unrecoverable") when the stash carries injected files, so `action: 'retry'` with the message omitted is a true retry and reuses the stash.
- `verifyFeedback` tool option (default off): a verifyHook rejection stores its reason on `MinionChat.pendingVerifyFeedback`; the next true retry appends `[Previous attempt was rejected by verification: …]` to the resent message (model-visible content + rendered mirror), breaking the byte-identical retry loop with a corrective signal. Consumed on use, dropped when a different message arrives, cleared on success. Recovery strips the note back off (`stripVerifyFeedbackNote`) so repeated rejections still compare as true retries and notes never stack.
- Busy guard: `executeMinion` takes an exclusive per-minion-chat-id hold via `LoopRegistry.acquireMinionChat` / `releaseMinionChat` (minion loops register under the _parent_ chat id, so ChatRunner's `CHAT_BUSY` doesn't cover them). A concurrent send to the same minion chat returns a "busy" error instead of interleaving with the lazy savepoint rollback.
- Persisted settings: `displayName`, `persona`, `apiDefinitionId`, `modelId`, `enabledTools`, `verifyHook`, `prePersonaSystemPromptFile` — stored on creation and updated on continuation. Enables stored-model and stored-tools fallback when continuing without re-specifying them.

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
- Injected files shown as collapsible bars that bracket the message, matching where their content sits in what the minion received: `injectFiles` above, `injectFilesAfter` below. In minion chat the bars come from `InjectedFileRenderBlock` groups and the split point is the message's text group (leading groups render above the bubble, trailing ones below). In the tool result view they come from `ToolInfoRenderBlock.injectedFiles` / `.injectedFilesAfter`, rendered above and below the blue input box.
- Bar content carries the framing the minion sees: the caller's `preamble`/`postamble` when given, otherwise the full default framing — `=== path ===` header plus the `Here's the content of <path>[ with line numbers]:` intro, i.e. verbatim what inline mode sends (`buildInjectedFileDisplay` in `minionTool.ts`, baked in at block-construction time via `buildInlineSection`). The API payload keeps raw content plus the framing fields, so the client frames it exactly once.
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
   - Chat Completions prunes a **field**, not an array item — reasoning lives as `reasoning_content` / `reasoning` / `reasoning_details` on the stored `CompletionMessage`, and all three go together. Same two paths, same boundary helper; an assistant message left with no content and no tool calls is dropped.
   - **`thinkingKeepTurns = 0` strips the in-flight turn too, by design.** `findThinkingBoundaryN` returns `messages.length` for `n <= 0`, putting the boundary past the end so nothing is spared; `n = 1` returns the last user _text_ message's index and everything from there on keeps its thinking. Sparing the live turn at 0 would make it indistinguishable from 1, so 0 genuinely means "keep none". The consequence is that 0 is incompatible with tool loops on providers that sign their reasoning — Anthropic (direct and via OpenRouter) rejects a `tool_use` turn whose `thinking` block is missing, and Gemini's `thoughtSignature` has the same exposure. `1` is the lowest safe value there; `0` is for context savings on chats that don't call tools. Uniform across all four clients — no client special-cases it. Revisit if someone actually trips over it.
3. **Empty text pruning** (per-definition `advancedSettings.pruneEmptyText`): removes empty/whitespace text blocks from messages before the last text user message.
4. **Genuine Anthropic enforcement** (per-definition `advancedSettings.enforceGenuineAnthropic`): post-response validation in `anthropicClient.ts` via `validateAnthropicResponse()`. Checks: (a) if input_tokens > 4096 and both cache_creation/read are zero → not genuine Anthropic; (b) if thinking blocks exist but lack cryptographic `signature` field → not genuine Anthropic. Both checks throw, caught by existing error handler.
5. **Nudge thinking**: the provider-level toggle `advancedSettings.nudgeThinking` (boolean) is resolved into an `AgenticLoopOptions.nudgeThinking: string` at loop-build time (`buildLoopOptions.ts`) — on → `NUDGE_THINKING_DEFAULT`, off → `undefined`. The loop forwards it into `sendMessageStream()` which calls `applyNudgeThinking()` to shallow-clone the last user message and append `\n\n<nudge>` to its text content. Send-time only — stored messages are untouched. `minionTool` exposes a `nudgeThinking` input parameter that overrides the resolved text (empty string = explicitly off), so the parent LLM can experiment with different nudge phrasings without a UI.
6. **Mandate CoT** (per-definition `advancedSettings.mandateCoT`): per-run check in `agenticLoopGenerator.ts`. Tracks `loopHasCoT` across all iterations (unified: `hasCoT` or `reasoningTokens > 0`). At run completion, rejects if no iteration produced chain-of-thought. Allows runs where CoT appears in one response but not others. Returns an error status that triggers minion savepoint rollback on retry.
7. **Treat empty output as error** (per-definition `advancedSettings.treatEmptyOutputAsError`): rejects turns producing whitespace-only text and no tool calls — catches degenerate responses from unreliable providers.
8. **Treat fallback as error** (per-definition `advancedSettings.treatFallbackAsError`, claude-agent only): when the SDK hands the request to a different model (a `{ type: 'fallback', from, to }` block), surfaces it as a turn error instead of rendering the default inline model-handoff notice. See Claude Agent Provider → Fallback handling.
9. **Stream accumulator** (per-definition `advancedSettings.useStreamAccumulator`, Responses API only): in `responsesClient.ts` streaming path, builds the `StreamResult` from `ResponsesStreamAccumulator` (`responsesStreamAccumulator.ts`) instead of `stream.finalResponse()`. Some third-party Responses API providers stream events but return an empty `Response.output` from the SDK's final response — text and tool blocks render to the user but `result.textContent` and `result.fullContent` are empty, breaking minion text capture and tool extraction. The accumulator consumes the same events the mapper does, keying items by `output_index` and replacing with the complete item on `response.output_item.done`. Tolerant to out-of-order events: deltas referencing unknown indices are silently dropped. Default off — enable per-provider in Settings → Advanced.

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
- Empty / cut-off response detection: API client returns `result.error` for empty choices (non-streaming) or a stream that ended without its terminal signal, however much it rendered (see Stream termination). The loop checks `result.error` → returns `status: 'error'`. Minion tool has a final guard: if zero assistant messages were produced, returns `isError: true`.

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
- `fallbackToolExtraction?: boolean` — when true, extract tool_use blocks from response content even when `stopReason !== 'tool_use'`. Handles third-party APIs that return wrong stopReason. Only for a turn that finished: the mapped stop reason must be in `NORMAL_STOP_REASONS` (`apiHelpers.ts`, `end_turn` / `stop_sequence`). A `max_tokens` or filtered turn's calls may be partial, so they never run, and the minion's abnormal-stop gate (same set) reports the turn. Enabled by default in minion loops. Main loop left unchanged (user handles via "resolve pending tool call" UI).

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

### Stale reasoning signatures when a chat switches models mid-history

Under the `openrouter` dialect, a chat whose history was produced by model A and is now being sent to model B echoes A's `reasoning_details` signatures. `modelFamily === 'chatgpt'` is the only discriminator at the echo site and it does not distinguish upstreams. A guard on `metadata.servedModel` would also suppress legitimate echoes across alias→snapshot resolution, so it isn't wired. Escape hatch: turn on `pruneThinking` for the definition. Planned fix: Reasoning provenance (Pending Features → API & Pricing).

### Claude-agent session JSONL leaks on chat deletion

Nothing deletes session files any more (see Claude Agent Provider → Fork on branch, not on rollback), and deleting a chat/minion chat doesn't either — so its session file, plus any sessions abandoned by rollbacks onto shared-era messages, stay under the session dir forever. Low urgency (a handful of files per deleted chat); `APIService.deleteProviderSession` and the client method are still there for exactly this, unused in the meantime. Wire them into the chat-deletion paths when it itches — that is the one place a session genuinely becomes unreachable, which is why the call survived the GC's removal.

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

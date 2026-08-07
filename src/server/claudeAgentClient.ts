/**
 * Claude Agent SDK client — bills against the Claude Max subscription via
 * the local `claude` CLI's OAuth credentials. Server-mode only: the SDK
 * spawns a `claude` CLI subprocess, so it cannot run in a Web Worker.
 *
 * The companion `ClaudeAgentStubClient` is registered in worker mode and
 * throws a clear "requires server mode" error. `nodeEntry.ts` injects
 * this real client via `setBootstrapClaudeAgentClientFactory`, which
 * `GremlinServer.init()` plumbs into the per-server `APIService`.
 *
 * History lives in the SDK's session JSONL on disk under
 * `~/.claude/projects/<cwd>/<sessionId>.jsonl` — we only ship the latest
 * user turn each call and let the SDK reconstruct context via `resume:`.
 * Rollback is a metadata flag on the chat row consumed on the next send
 * (mapped to SDK `resumeSessionAt`).
 */
import {
  query,
  deleteSession,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  APIDefinition,
  Message,
  Model,
  TokenTotals,
  ToolContext,
  ToolOptions,
  ToolUseBlock,
} from '../shared/protocol/types';
import type { APIClient, StreamChunk, StreamResult } from '../shared/services/api/baseClient';
import type { APIServiceDeps } from '../shared/services/api/apiService';
import {
  createMapperState,
  mapAnthropicEventToStreamChunks,
} from '../shared/services/api/anthropicStreamMapper';
import { getModelMetadataFor } from '../shared/engine/lib/api/modelMetadata';
import { mapAnthropicEffort } from '../shared/engine/lib/reasoningEffort';
import { addTokens, createTokenTotals } from '../shared/engine/lib/tokenTotals';
import { buildGremlinMcpServer, MCP_SERVER_NAME } from './claudeAgentToolBridge';
import {
  buildSeparateBlockText,
  effectiveInjectionMode,
  wrapInjectedFile,
  type InjectedFile,
  type InjectionMode,
} from '../shared/services/api/fileInjectionHelper';

/** Hard-coded model list — the SDK has no listing endpoint. */
const CLAUDE_AGENT_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

/**
 * Stable session-storage working directory for the spawned `claude` CLI.
 * The SDK doesn't actually write session JSONL here (those go to
 * `$HOME/.claude/projects/<dashified-cwd>/`), but the subprocess must be
 * able to chdir into this path. Resolved from `ServerConfig` and passed
 * in by `nodeEntry.ts` so a read-only deploy can redirect it via
 * `CLAUDE_AGENT_SESSION_DIR` without touching the bundled code.
 */
function defaultSessionDir(): string {
  const base = path.resolve(process.cwd(), 'data', 'claude-agent-sessions');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/** Extract the latest user message from the thread. */
function extractLastUserMessage(messages: Message<unknown>[]): Message<unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return m;
  }
  return undefined;
}

/**
 * Content blocks for the outgoing user turn, in the same order the direct
 * anthropic client uses: image attachments, leading injected files, the
 * message text (skipped when empty), trailing injected files. The SDK's
 * stream-json input takes a full MessageParam, so these ride the same wire
 * path a plain string prompt does. Exported for unit tests.
 */
export function buildUserContentBlocks(
  msg: Message<unknown>
): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  for (const attachment of msg.attachments ?? []) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data },
    });
  }

  const pushInjectedFiles = (files?: InjectedFile[]) => {
    if (!files?.length || !msg.content.injectionMode) return;
    const mode = effectiveInjectionMode(msg.content.injectionMode as InjectionMode, 'claude-agent');
    for (const file of files) {
      if (mode === 'as-file') {
        // Dormant until 'claude-agent' joins the as-file allowlist in
        // effectiveInjectionMode (CLI document-block passthrough unverified).
        blocks.push({
          type: 'document',
          source: { type: 'text', data: wrapInjectedFile(file), media_type: 'text/plain' },
          title: file.path,
        });
      } else {
        blocks.push({ type: 'text', text: buildSeparateBlockText(file) });
      }
    }
  };

  pushInjectedFiles(msg.content.injectedFiles);
  const text = msg.content.content ?? '';
  if (text) blocks.push({ type: 'text', text });
  pushInjectedFiles(msg.content.injectedFilesAfter);
  return blocks;
}

/**
 * Map an SDK NonNullableUsage (Anthropic Beta usage shape) onto the
 * normalized fields GremlinOFA tracks at the StreamResult level.
 */
interface SdkUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function mapSdkUsage(usage: SdkUsageShape | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
} {
  const u = usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

/**
 * Verbose per-message / per-block stream tracing, off by default. The
 * once-per-turn lifecycle lines below use `console.debug` directly (always on);
 * the chatty per-SDK-message and per-partial-event traces route through `dbg`
 * so they only fire under `CLAUDE_AGENT_DEBUG=1` when diagnosing resume/rollback
 * or partial-stream issues. Keeps normal runs legible without losing the
 * diagnostics when you actually need them.
 *
 * Timestamps are added process-wide by the server entry's `installLogTimestamps`
 * (full ISO), so nothing here stamps per-line.
 */
const CLAUDE_AGENT_DEBUG = process.env.CLAUDE_AGENT_DEBUG === '1';
function dbg(fmt: string, ...args: unknown[]): void {
  if (CLAUDE_AGENT_DEBUG) console.debug(fmt, ...args);
}
/** Full-fidelity JSON dump, gated like `dbg` — the stringify only runs when on. */
function dbgJson(label: string, payload: unknown): void {
  if (CLAUDE_AGENT_DEBUG) console.debug(label, JSON.stringify(payload));
}

/** Debug copy of the outgoing blocks with base64 image data elided. */
function redactContentBlocks(
  blocks: Anthropic.Messages.ContentBlockParam[]
): Anthropic.Messages.ContentBlockParam[] {
  return blocks.map(b =>
    b.type === 'image' && b.source.type === 'base64'
      ? { ...b, source: { ...b.source, data: `<${b.source.data.length} base64 chars>` } }
      : b
  );
}

/**
 * Hard assistant-level errors the SDK can attach to an `assistant` message but
 * never echo on the `result` — each means the turn failed even if it closed
 * "successfully".
 */
const HARD_ASSISTANT_ERRORS = [
  'rate_limit',
  'max_output_tokens',
  'server_error',
  'billing_error',
  'overloaded',
];
/**
 * Stop reasons that mean "no usable answer" — including `pause_turn`, which
 * signals the turn needs continuation the SDK didn't perform here.
 */
const BAD_STOP_REASONS = ['max_tokens', 'refusal', 'pause_turn', 'model_context_window_exceeded'];

/** Signals accumulated while draining a claude-agent turn, fed to `classifyTurnError`. */
export interface TurnOutcomeSignals {
  textLength: number;
  thinkingLength: number;
  sawThinkingBlock: boolean;
  sawToolUse: boolean;
  stopReason: string | undefined;
  assistantStopReason: string | undefined;
  assistantError: string | undefined;
  rateLimitStatus: string | undefined;
  refusalExplanation: string | undefined;
  refusalCategory: string | undefined;
  outputTokens: number;
  /**
   * The model emitted a `fallback` block and the provider's `treatFallbackAsError`
   * is off, so it rendered as an inline notice — real output, not an empty turn.
   */
  sawFallback: boolean;
  /**
   * The apiDef's opt-in for treating empty output as an error. Gates only the
   * thinking-only branch — the hard-failure branches (refusal / assistant error
   * / bad stop / rejected quota) recover real signals the SDK hid and stay
   * unconditional, matching how other providers surface those natively.
   */
  treatEmptyOutputAsError: boolean;
}

/**
 * Decide whether a claude-agent turn the SDK closed "successfully" should
 * actually surface as a loop error. The SDK can report subtype=success /
 * stop=end_turn while the turn produced nothing usable — the real signal lives
 * on the assistant message's stop_reason / error, a rejected subscription quota,
 * or a thinking-only malfunction. Without this the agentic loop logs "Complete
 * with empty response" and the minion silently stalls.
 *
 * Pure, so the empty-turn cases can be unit-tested without driving a fake SDK
 * stream. Precedence: refusal first (unconditional — even when partial text
 * streamed), then, only when the turn produced nothing, hardAssistantError >
 * badStop > rejected-quota > thinking-only. The first four recover real failure
 * signals the SDK hid, so they fire regardless of settings; thinking-only is a
 * judgment call and fires only under the apiDef's `treatEmptyOutputAsError`
 * opt-in. Returns `undefined` when the turn is fine. The caller applies this only
 * when no `resultError` is already set, so a non-success `result` subtype still wins.
 */
export function classifyTurnError(s: TurnOutcomeSignals): { message: string } | undefined {
  // A refusal always errors, even when the model streamed partial text first —
  // surface the human-readable reason rather than leaving a half-answer that
  // looks complete.
  if (s.assistantStopReason === 'refusal') {
    return {
      message: `claude-agent: refused${s.refusalExplanation ? ` — ${s.refusalExplanation}` : ''}${
        s.refusalCategory ? ` (category: ${s.refusalCategory})` : ''
      }`,
    };
  }

  // Everything below concerns a turn that rendered nothing at all. A fallback
  // notice (treatFallbackAsError off) is real rendered output, so it counts too.
  if (s.textLength > 0 || s.thinkingLength > 0 || s.sawFallback) return undefined;

  if (s.assistantError && HARD_ASSISTANT_ERRORS.includes(s.assistantError)) {
    return { message: `claude-agent: ${s.assistantError}` };
  }
  if (s.assistantStopReason && BAD_STOP_REASONS.includes(s.assistantStopReason)) {
    return {
      message: `claude-agent: turn ended with stop_reason=${s.assistantStopReason} and no output`,
    };
  }
  if (s.rateLimitStatus === 'rejected') {
    return { message: 'claude-agent: turn rejected (rate_limit_status=rejected)' };
  }
  // Thinking-only: spent the output budget on omitted/empty thinking, emitted no
  // text and called no tool, and closed with no distinguishing signal. Unlike the
  // branches above this is a judgment call, not a recovered failure signal, so it
  // honors the apiDef's `treatEmptyOutputAsError` opt-in — same switch the loop
  // applies to the structurally identical no-thinking empty turn.
  if (
    s.treatEmptyOutputAsError &&
    s.sawThinkingBlock &&
    !s.sawToolUse &&
    s.stopReason !== 'tool_use'
  ) {
    return {
      message: `claude-agent: turn produced only thinking and no output (${s.outputTokens} output tokens spent)`,
    };
  }
  return undefined;
}

/**
 * Factual message for a model-fallback turn — the SDK handed the request to a
 * different model. We state only the model handoff (the `from`/`to` we can read
 * off the block); we make no claim about *why*, since the block doesn't tell us
 * (it is not necessarily a "risky" prompt). Pure, for unit testing.
 */
export function describeFallback(fromModel?: string, toModel?: string): string {
  if (toModel && fromModel) {
    return `claude-agent: request handled by ${toModel} instead of ${fromModel}`;
  }
  if (toModel) {
    return `claude-agent: request handled by ${toModel}`;
  }
  return 'claude-agent: request handled by a different model';
}

/**
 * Pretty-print a raw SDK block for the generic unknown-block renderer, capped
 * so huge payloads (base64 images, full page dumps) don't bloat storage.
 * Pure, for unit testing.
 */
export function trimBlockJson(block: unknown, maxChars = 2000): string {
  let json: string;
  try {
    json = JSON.stringify(block, null, 2) ?? String(block);
  } catch {
    json = String(block);
  }
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}… (+${json.length - maxChars} more chars)`;
}

/**
 * Strip the `mcp__<server>__` prefix the model sees off a bridged tool name,
 * recovering the bare name our bridge registered. Returns null for tools that
 * aren't ours (built-in WebSearch/WebFetch). Pure, for the model-delivery hooks.
 */
export function bridgedToolName(mcpToolName: string): string | null {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  return mcpToolName.startsWith(prefix) ? mcpToolName.slice(prefix.length) : null;
}

/**
 * Deterministic key for matching a hook's `tool_input` back to the bridged call
 * that produced it. Stability across the two SDK-built copies matters more than
 * canonical form, so a plain stringify suffices.
 */
export function toolInputKey(input: unknown): string {
  try {
    return JSON.stringify(input ?? null);
  } catch {
    return '';
  }
}

/**
 * Pull plain text out of a PostToolUse `tool_response` (typed `unknown` by the
 * SDK). Handles a bare string, an MCP CallToolResult (`{ content: [{ text }] }`),
 * and falls back to JSON. Pure.
 */
export function extractToolResponseText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    const content = (resp as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(block =>
          block &&
          typeof block === 'object' &&
          typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : ''
        )
        .join('');
    }
    try {
      return JSON.stringify(resp);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Decide whether what the model received (`received`) diverges from what the
 * bridge sent (`sent`). Conservative: only a strictly shorter payload counts as
 * truncated — the SDK's observable size-cap behavior. Returns null when they
 * match (no annotation). Pure.
 */
export function detectTruncation(
  sent: string,
  received: string
): { status: 'truncated'; detail: string } | null {
  if (received.length < sent.length) {
    return {
      status: 'truncated',
      detail: `model received ${received.length} of ${sent.length} chars`,
    };
  }
  return null;
}

export interface ClaudeAgentClientOptions {
  /** Override the SDK `query` entry point (tests inject a fake). */
  query?: typeof query;
  /** Override the SDK `deleteSession` entry point (tests inject a fake). */
  deleteSession?: typeof deleteSession;
  /** Override the session dir resolver (tests inject a tmp dir). */
  sessionDir?: () => string;
  /** Override UUID generator (tests assert a deterministic ID). */
  generateSessionId?: () => string;
}

export class ClaudeAgentClient implements APIClient {
  protected readonly deps: APIServiceDeps;
  private readonly queryFn: typeof query;
  private readonly deleteSessionFn: typeof deleteSession;
  private readonly sessionDir: () => string;
  private readonly generateSessionId: () => string;

  constructor(deps: APIServiceDeps, options: ClaudeAgentClientOptions = {}) {
    this.deps = deps;
    this.queryFn = options.query ?? query;
    this.deleteSessionFn = options.deleteSession ?? deleteSession;
    this.sessionDir = options.sessionDir ?? defaultSessionDir;
    this.generateSessionId = options.generateSessionId ?? (() => randomUUID());
  }

  /**
   * GC a superseded on-disk SDK session (a forked retry replaced it on the
   * chat row, so no future send can ever resume it). Best-effort: the forked
   * session carries the entire kept history, so a stale file only wastes disk
   * — a failed delete must never break the turn that triggered it.
   */
  async deleteProviderSession(sessionId: string): Promise<void> {
    try {
      await this.deleteSessionFn(sessionId, { dir: this.sessionDir() });
      console.debug('[claudeAgent] deleted superseded session %s', sessionId);
    } catch (err) {
      console.debug('[claudeAgent] session GC failed for %s:', sessionId, err);
    }
  }

  async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    return CLAUDE_AGENT_MODELS.map(id => ({
      ...getModelMetadataFor(apiDefinition, id),
      id,
      name: id,
    }));
  }

  shouldPrependPrefill(_apiDefinition: APIDefinition): boolean {
    return false;
  }

  async *sendMessageStream(
    messages: Message<unknown>[],
    modelId: string,
    apiDefinition: APIDefinition,
    options: {
      signal: AbortSignal;
      systemPrompt?: string;
      enableReasoning?: boolean;
      reasoningBudgetTokens?: number;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      reasoningSummary?: 'auto' | 'concise' | 'detailed';
      claudeAgentSessionId?: string;
      claudeAgentResumeAt?: string;
      // Tool bridge inputs (claude-agent only). The agentic loop forwards its
      // prebuilt ToolContext + enabled tools so we can expose the bridgeable
      // subset as an in-process MCP server.
      enabledTools?: string[];
      toolOptions?: Record<string, ToolOptions>;
      toolContext?: ToolContext;
      /** Project web-search toggle: enables the SDK's built-in WebSearch/WebFetch. */
      webSearchEnabled?: boolean;
      /**
       * Pre-gated by the agentic loop: when true, opt into the 1M context window
       * by suffixing the model id with `[1m]` (the Claude Code convention; we
       * use it rather than the SDK's `Options.betas`).
       */
      claudeAgentExtendedContext?: boolean;
    } & Record<string, unknown>
  ): AsyncGenerator<StreamChunk, StreamResult<Anthropic.Beta.BetaContentBlock[]>, unknown> {
    const lastUserMsg = extractLastUserMessage(messages);
    if (!lastUserMsg) {
      throw new Error('claude-agent: no user message to send');
    }
    const contentBlocks = buildUserContentBlocks(lastUserMsg);
    if (contentBlocks.length === 0) {
      throw new Error('claude-agent: no user content to send');
    }
    // Single text block → keep the SDK's plain-string prompt path (it wraps
    // the string into the identical stream-json user message). Anything more
    // (images, injected files) goes through the streaming-input form.
    const textOnlyPrompt =
      contentBlocks.length === 1 && contentBlocks[0].type === 'text'
        ? contentBlocks[0].text
        : undefined;

    const sessionId = options.claudeAgentSessionId ?? this.generateSessionId();
    const isFirstTurn = !options.claudeAgentSessionId;
    const resumeAt = options.claudeAgentResumeAt;

    // Auth fallback chain: explicit OAuth token > explicit API key >
    // host CLI credentials (apiKeySource: 'none').
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (apiDefinition.apiKey?.startsWith('sk-ant-oat01-')) {
      env.CLAUDE_CODE_OAUTH_TOKEN = apiDefinition.apiKey;
      delete env.ANTHROPIC_API_KEY;
    } else if (apiDefinition.apiKey) {
      env.ANTHROPIC_API_KEY = apiDefinition.apiKey;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    // Hard per-call output ceiling (thinking tokens included), honored by the
    // CLI via its env. `Options` has no direct equivalent, and the adaptive
    // models' `thinking`/`maxThinkingTokens` knobs can't cap thinking depth —
    // this is the one working guardrail against runaway-thinking turns. A
    // capped turn surfaces the assistant's `max_tokens` on
    // `StreamResult.stopReason` (see the surfacedStopReason return): minions
    // rewind/retry via their abnormal-stop gate, parent chats badge the
    // message as Truncated, and an empty capped turn (runaway thinking, no
    // text) is still reclassified as a failed turn by `classifyTurnError`.
    if (typeof options.maxTokens === 'number' && options.maxTokens > 0) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.maxTokens);
    }

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    options.signal.addEventListener('abort', onAbort);

    // Anthropic thinking.display: Opus 4.7+ / Claude 5 default server-side to
    // 'omitted', which strips the content of thinking AND narration blocks — a
    // tool-heavy turn then renders only its final text segment, with the model's
    // mid-loop prose arriving as empty signed blocks. Same convention as the
    // direct AnthropicClient: any Reasoning Summary selection opts into
    // 'summarized' so the content is returned.
    const thinkingDisplay: 'summarized' | undefined =
      options.reasoningSummary !== undefined ? 'summarized' : undefined;

    // Map our reasoning controls onto SDK shapes.
    //   - explicit `false` → disabled
    //   - explicit `true` + positive budget → enabled with that budget
    //   - explicit `true` + budget 0 / missing → adaptive. Normally omitted so
    //     the SDK's adaptive default kicks in (matches GremlinOFA's
    //     "0 = adaptive" convention; required for Opus 4.7+ which is
    //     `onlyAdaptiveReasoning` and ignores `budgetTokens` entirely — control
    //     the level via `effort`), but a display opt-in needs the explicit
    //     `{ type: 'adaptive' }` form to have somewhere to ride.
    //   - both unset → omit
    let thinking: Options['thinking'];
    if (options.enableReasoning === false) {
      thinking = { type: 'disabled' };
    } else if (
      options.enableReasoning === true &&
      typeof options.reasoningBudgetTokens === 'number' &&
      options.reasoningBudgetTokens > 0
    ) {
      thinking = {
        type: 'enabled',
        budgetTokens: options.reasoningBudgetTokens,
        ...(thinkingDisplay && { display: thinkingDisplay }),
      };
    } else if (options.enableReasoning === true && thinkingDisplay) {
      thinking = { type: 'adaptive', display: thinkingDisplay };
    }

    // The SDK's EffortLevel has no 'none'/'minimal', and a model that doesn't take
    // `effort` rejects it — clamp against metadata instead of casting. Gated on the
    // model's effort list alone, not on adaptive mode: the SDK accepts `effort`
    // independently of `thinking`.
    const effortLevel = mapAnthropicEffort(
      options.reasoningEffort,
      getModelMetadataFor(apiDefinition, modelId).supportedReasoningEfforts
    );

    // --- Tool bridge ------------------------------------------------------
    // Expose the enabled, bridgeable subset of our internal tools to the SDK
    // as an in-process MCP server. The MCP handlers can't yield into this
    // generator, so they push synthetic StreamChunks onto `chunkQueue`; the
    // streaming loop below merges that queue with the SDK message iterator.
    const chunkQueue: StreamChunk[] = [];
    let notifyChunk: (() => void) | null = null;
    // Model-delivery correlation: the PostToolUse/Failure hooks identify a call
    // by the model's tool name + input, but the UI block is keyed by the bridge's
    // synthetic id (MCP never surfaces the model's tool_use id to the server). We
    // record each bridged call as its chunks flow through here and match later by
    // (name, input) + FIFO. Approximate for parallel same-input calls — fine for
    // a diagnostic, not a correctness path.
    interface PendingBridgedCall {
      syntheticId: string;
      inputKey: string;
      content: string;
    }
    const pendingByName = new Map<string, PendingBridgedCall[]>();
    const pendingById = new Map<string, PendingBridgedCall>();
    const pushChunk = (chunk: StreamChunk): void => {
      if (chunk.type === 'tool_use') {
        const entry: PendingBridgedCall = {
          syntheticId: chunk.id,
          inputKey: toolInputKey(chunk.input),
          content: '',
        };
        pendingById.set(chunk.id, entry);
        const queue = pendingByName.get(chunk.name);
        if (queue) queue.push(entry);
        else pendingByName.set(chunk.name, [entry]);
      } else if (chunk.type === 'tool_result') {
        const entry = pendingById.get(chunk.tool_use_id);
        if (entry) entry.content = chunk.content;
      }
      chunkQueue.push(chunk);
      const notify = notifyChunk;
      notifyChunk = null;
      notify?.();
    };
    // Pops the bridged call a hook event refers to: prefer an exact input match,
    // else the oldest pending call for that tool. Returns null for non-bridged
    // tools (WebSearch/WebFetch) or when nothing matches.
    const consumeBridgedCall = (
      mcpToolName: string,
      toolInput: unknown
    ): PendingBridgedCall | null => {
      const bare = bridgedToolName(mcpToolName);
      if (!bare) return null;
      const queue = pendingByName.get(bare);
      if (!queue || queue.length === 0) return null;
      const wantKey = toolInputKey(toolInput);
      const idx = queue.findIndex(e => e.inputKey === wantKey);
      const [entry] = queue.splice(idx >= 0 ? idx : 0, 1);
      return entry ?? null;
    };
    // Sub-agent (minion) costs accrue here — the SDK's own `result.usage` never
    // includes them since they come from our apiService. Surfaced on the
    // StreamResult so the agentic loop folds them into the chat totals.
    const toolTokenTotals = createTokenTotals();
    // Chat title/summary set by the metadata tool during this turn. The SDK owns
    // the turn so it can't apply mid-turn — surfaced on the StreamResult and
    // folded into the chat after the turn (last-write-wins per field).
    let chatMetadata: { name?: string; summary?: string } | undefined;
    // Free-run return value from a bridged `return` tool (minion sub-agents). The
    // bridge can't break the SDK turn, so the value is stashed here and surfaced
    // on the StreamResult; the agentic loop reports it as the minion's result.
    let claudeAgentReturnValue: string | undefined;
    // DUMMY hook (un)register from a bridged `dummy` tool. `undefined` = no
    // change this turn; `string` = activate; `null` = deactivate. Surfaced on
    // the StreamResult; the loop swaps the outer hook runtime after the turn.
    let claudeAgentActiveHook: string | null | undefined;

    const toolContext = options.toolContext as ToolContext | undefined;
    const enabledTools = (options.enabledTools as string[] | undefined) ?? [];
    const toolOptions = (options.toolOptions as Record<string, ToolOptions> | undefined) ?? {};

    // Built-in web tools (network-read only) are the one exception to the
    // "no host tools" rule — enabled when the project's web-search toggle is on.
    // The `tools` allowlist is exact, so Read/Write/Edit/Bash stay excluded.
    const webSearchEnabled = options.webSearchEnabled === true;
    const builtinTools: string[] = webSearchEnabled ? ['WebSearch', 'WebFetch'] : [];

    let mcpServers: Options['mcpServers'] = {};
    // Auto-approve list (permissionMode is bypassPermissions): the bridged
    // mcp__gremlin__* tools plus the built-in web tools when enabled.
    const allowedToolNames: string[] = [];
    if (toolContext && enabledTools.length > 0) {
      const bridge = buildGremlinMcpServer({
        toolContext,
        enabledTools,
        toolOptions,
        signal: abortController.signal,
        pushChunk,
        onToolTokens: (totals: TokenTotals) => addTokens(toolTokenTotals, totals),
        onChatMetadata: metadata => {
          chatMetadata = { ...chatMetadata, ...metadata };
        },
        onReturnValue: value => {
          claudeAgentReturnValue = value;
        },
        onActiveHook: hook => {
          claudeAgentActiveHook = hook;
        },
      });
      if (bridge) {
        mcpServers = { [MCP_SERVER_NAME]: bridge.server };
        allowedToolNames.push(...bridge.allowedTools);
        console.debug('[claudeAgent] bridged tools=%s', bridge.allowedTools.join(', '));
      } else {
        // enabledTools had no `claudeAgentBridgeable` tool — leave mcpServers empty.
        console.debug(
          '[claudeAgent] no bridgeable tool among enabled=[%s]; mcpServers stays empty',
          enabledTools.join(', ')
        );
      }
    } else {
      // The most common reason tools "aren't set": either the agentic loop
      // didn't thread a toolContext (non-loop caller) or the chat enabled none.
      console.debug(
        '[claudeAgent] tool bridge skipped: hasToolContext=%s enabledToolCount=%d',
        !!toolContext,
        enabledTools.length
      );
    }
    if (webSearchEnabled) {
      allowedToolNames.push(...builtinTools);
      console.debug('[claudeAgent] web tools enabled: WebSearch, WebFetch');
    }

    // Note: the project's max output tokens (`options.maxTokens`) rides the
    // CLI env (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, set with the auth env above) —
    // `Options` itself has no equivalent field.
    // The Agent SDK opts into the 1M window via a `[1m]` model-id suffix rather
    // than a beta header. Eligibility is pre-gated upstream (the loop only sets
    // claudeAgentExtendedContext for the supported Sonnet 4.5 / Opus 4.5–4.8 set).
    const sdkModelId = options.claudeAgentExtendedContext ? `${modelId}[1m]` : modelId;
    if (options.claudeAgentExtendedContext) {
      console.debug('[claudeAgent] 1M context enabled, model=%s', sdkModelId);
    }

    const sdkOptions: Options = {
      model: sdkModelId,
      // Emit raw token-by-token stream events (SDKPartialAssistantMessage) on top
      // of the coalesced assistant/result messages, so we can render claude-agent
      // turns live like every other provider and recover partial text on cut-off
      // turns. Reconciled against the coalesced message below (the coalesced one
      // stays the source of fullContent + final metadata).
      includePartialMessages: true,
      systemPrompt: options.systemPrompt,
      // Built-in host tools (Read/Write/Edit/Bash) stay OFF — they operate on
      // the host filesystem at `cwd` and would bypass our VFS sandbox. Only the
      // web tools (when web search is on) and our `mcp__gremlin__*` tools are
      // exposed, gated by the allowedTools whitelist below.
      tools: builtinTools,
      mcpServers,
      ...(allowedToolNames.length ? { allowedTools: allowedToolNames } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      cwd: this.sessionDir(),
      env,
      abortController,
      // Observe-only: detect when the SDK delivered a different payload to the
      // model than our bridge sent (truncated for size, or replaced with an
      // error) and annotate the matching tool_result block in the UI. Never
      // mutates what the model receives — every callback returns unchanged.
      hooks: {
        PostToolUse: [
          {
            hooks: [
              async input => {
                if (input.hook_event_name === 'PostToolUse') {
                  const pending = consumeBridgedCall(input.tool_name, input.tool_input);
                  if (pending) {
                    const received = extractToolResponseText(input.tool_response);
                    const delivery = detectTruncation(pending.content, received);
                    if (delivery) {
                      console.debug(
                        '[claudeAgent] model delivery truncated name=%s sent=%d recv=%d',
                        input.tool_name,
                        pending.content.length,
                        received.length
                      );
                      pushChunk({
                        type: 'tool_result_annotation',
                        tool_use_id: pending.syntheticId,
                        modelDelivery: delivery,
                      });
                    }
                  }
                }
                return { continue: true };
              },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            hooks: [
              async input => {
                if (input.hook_event_name === 'PostToolUseFailure') {
                  // Error string can quote tool input/output — content stays gated.
                  console.debug('[claudeAgent] PostToolUseFailure name=%s', input.tool_name);
                  dbg('[claudeAgent] PostToolUseFailure error=%s', input.error);
                  const pending = consumeBridgedCall(input.tool_name, input.tool_input);
                  if (pending) {
                    pushChunk({
                      type: 'tool_result_annotation',
                      tool_use_id: pending.syntheticId,
                      modelDelivery: { status: 'error', detail: input.error },
                    });
                  }
                }
                return { continue: true };
              },
            ],
          },
        ],
      },
      ...(thinking ? { thinking } : {}),
      ...(effortLevel ? { effort: effortLevel } : {}),
      // A rewound send (resumeAt set) FORKS into a fresh session containing
      // history only up to the anchor uuid. Resuming the old session in place
      // would leave the rejected/aborted turn in its JSONL, and whether a later
      // plain `resume` excludes such dead branches is CLI-internal behavior we
      // can't rely on. The forked id arrives on the `system:init` message and
      // flows back through providerExtra; the engine then GCs the old session.
      ...(isFirstTurn
        ? { sessionId }
        : {
            resume: sessionId,
            ...(resumeAt ? { resumeSessionAt: resumeAt, forkSession: true } : {}),
          }),
    };

    // Logged with env stripped — full process.env would leak credentials.
    // `prompt` is logged separately so the redacted env doesn't make
    // debugging the actual content harder.
    const { env: _envForLog, abortController: _ac, ...sdkOptionsForLog } = sdkOptions;
    // Gated: prompt is user content; options dumps the full system prompt + tool
    // config. Both are diagnostic-only and shouldn't print on every normal turn.
    if (textOnlyPrompt !== undefined) {
      dbg('[claudeAgent] query() prompt=', textOnlyPrompt);
    } else {
      console.debug(
        '[claudeAgent] structured prompt: %d blocks (%d image, %d text, %d document)',
        contentBlocks.length,
        contentBlocks.filter(b => b.type === 'image').length,
        contentBlocks.filter(b => b.type === 'text').length,
        contentBlocks.filter(b => b.type === 'document').length
      );
      dbg('[claudeAgent] query() blocks=', redactContentBlocks(contentBlocks));
    }
    dbg('[claudeAgent] query() options=', sdkOptionsForLog);
    console.debug(
      '[claudeAgent] turn lifecycle: isFirstTurn=%s sessionId=%s resumeAt=%s',
      isFirstTurn,
      sessionId,
      resumeAt ?? '(none)'
    );

    // The one-shot generator mirrors the SDK's own string-prompt wrapper
    // (`{type:'user', session_id:'', message, parent_tool_use_id:null}`); it
    // returns immediately, so streamInput can close the CLI's stdin.
    const prompt =
      textOnlyPrompt !== undefined
        ? textOnlyPrompt
        : (async function* (): AsyncGenerator<SDKUserMessage> {
            yield {
              type: 'user',
              session_id: '',
              parent_tool_use_id: null,
              message: { role: 'user', content: contentBlocks },
            };
          })();
    const iter = this.queryFn({ prompt, options: sdkOptions });

    const fullContent: Anthropic.Beta.BetaContentBlock[] = [];
    let textBuf = '';
    let thinkingBuf = '';
    let stopReason: string | undefined;
    let assistantUuid: string | undefined;
    // The session id the CLI actually writes to, from `system:init`. Differs
    // from the id we passed on forked (rewound) sends — that new id is what
    // must be persisted on the chat row, so it wins in providerExtra.
    let sdkReportedSessionId: string | undefined;
    let usage: ReturnType<typeof mapSdkUsage> = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    let resultError: { message: string; status?: number } | undefined;
    // Latest subscription rate-limit status + assistant-message error, captured
    // from the rate_limit_event / assistant SDK messages. Used to turn a turn
    // that closes "successfully" but renders nothing into a loud loop error
    // instead of an empty bubble.
    let lastRateLimitStatus: string | undefined;
    let lastAssistantError: string | undefined;
    // The assistant message's own BetaMessage.stop_reason — the real API signal
    // (pause_turn / refusal / max_tokens / model_context_window_exceeded). It can
    // differ from the result message's session-level stop_reason (often a generic
    // `end_turn`), so a paused/refused turn would otherwise be swallowed.
    let lastAssistantStopReason: string | undefined;
    // The SDK result message's `result` string — the final text, a fallback for
    // turns where the assistant message carried no text block.
    let resultText = '';
    // Whether the turn engaged the model (a thinking block) or did anything
    // actionable (a tool call). A turn that thought but produced no text and
    // called no tool is a malfunction worth surfacing, not a deliberate silence.
    let sawThinkingBlock = false;
    let sawToolUse = false;
    // Refusal detail from `stop_details` (coalesced BetaMessage or partial
    // message_delta). Folded into the loud refusal error below.
    let lastRefusalExplanation: string | undefined;
    let lastRefusalCategory: string | undefined;
    // Live-streaming reconciliation (includePartialMessages). For ONE model turn
    // the SDK emits a `message_start`/`message_stop` pair of `stream_event`s
    // wrapping the raw token deltas, PLUS one coalesced `assistant` message per
    // finished content block — thinking, text, and tool_use each arrive as their
    // own `assistant`, interleaved with that block's partial deltas. The partial
    // stream and the per-block `assistant` messages describe the SAME content.
    //
    // So the partial stream is the sole live emitter for text / thinking /
    // web-search-intent. Once partials are active for a turn, every per-block
    // `assistant` is metadata + `fullContent` only (no re-emit → no double render
    // or block-boundary corruption). When the CLI never streams partials (older
    // SDK / not honored), `partialsActive` stays false and the `assistant`
    // messages emit the old way (graceful degradation). The one exception is
    // `*_tool_result` blocks: the partial stream never emits them (filtered), so
    // the `assistant` branch is their sole emitter, always.
    let mapperState = createMapperState();
    let partialsActive = false;
    // Whether the model produced any text block at all (streamed or coalesced).
    // Gates the result-string fallback so a turn with real text never collapses.
    let sawTextBlock = false;
    // The model softened a risky prompt instead of refusing (a `fallback` block).
    // When `treatFallbackAsError` is off this counts as real output (an inline
    // notice), so it suppresses the empty-turn classifier just like text does.
    let sawFallback = false;
    const treatFallbackAsError = apiDefinition.advancedSettings?.treatFallbackAsError === true;
    let loggedTtft = false;
    // Built-in WebSearch requests the SDK reports on its result usage. Surfaced
    // for the "N searches" display only — claude-agent cost is subscription-zeroed.
    let webSearchCount = 0;
    // Block indices of in-flight web blocks (server_tool_use / *_tool_result) in
    // the current partial Beta message. Their stream events are dumped in full
    // under CLAUDE_AGENT_DEBUG to capture the exact wire shapes (renderer work).
    const webBlockIndices = new Set<number>();
    // id → name of non-bridged tool_use blocks surfaced as unknown_block (e.g.
    // built-in WebSearch/WebFetch). Their results come back as tool_result
    // blocks inside SDK `user` messages; this map picks those out for the same
    // generic rendering while bridged results stay side-channel-only.
    const nonBridgedToolUses = new Map<string, string>();
    // Total turns the SDK spent on this prompt (from the result message). Logged
    // for visibility into how many model round-trips a tool loop consumed.
    let numTurns: number | undefined;

    // Map one SDK message to our StreamChunks, updating the closure state.
    // Closes over the accumulators above (assignment to outer `let` is fine).
    const handleSdkMessage = function* (msg: SDKMessage): Generator<StreamChunk, void, unknown> {
      // Name every coarse SDK message as it arrives (always-on) so the event flow
      // is legible by default — `type` + `subtype`/`uuid` is usually enough.
      // `stream_event` is excluded here: with includePartialMessages it fires per
      // token, so its branch below names its own lifecycle events (skipping the
      // per-token deltas) instead of burying the log.
      if (msg.type !== 'stream_event') {
        console.debug(
          '[claudeAgent] sdk event=%s%s%s',
          msg.type,
          'subtype' in msg ? ` subtype=${msg.subtype}` : '',
          'uuid' in msg ? ` uuid=${msg.uuid}` : ''
        );
      }
      if (msg.type === 'stream_event') {
        // Live token-by-token stream. Any partial event means streaming is active
        // for this turn → the per-block `assistant` messages become metadata-only.
        // message_start resets the per-Beta-message mapper state; message_delta
        // carries the truthful stop_reason + refusal stop_details.
        partialsActive = true;
        const event = msg.event;
        // Name the stream lifecycle events always-on (message_start /
        // content_block_start + its block type / content_block_stop /
        // message_delta / message_stop), skipping the per-token
        // content_block_delta so the flow stays legible.
        if (event.type !== 'content_block_delta') {
          console.debug(
            '[claudeAgent] stream event=%s%s',
            event.type,
            event.type === 'content_block_start' ? ` block=${event.content_block.type}` : ''
          );
        }
        // Full-event dumps for web blocks (server_tool_use + *_tool_result):
        // every stream event touching one of their indices is dumped verbatim,
        // including the input_json_delta fragments that build the tool input.
        if (event.type === 'content_block_start') {
          const blockType = event.content_block.type;
          if (
            blockType === 'server_tool_use' ||
            blockType === 'web_search_tool_result' ||
            blockType === 'web_fetch_tool_result'
          ) {
            webBlockIndices.add(event.index);
            dbgJson('[claudeAgent] web stream content_block_start', event);
          }
        } else if (event.type === 'content_block_delta' && webBlockIndices.has(event.index)) {
          dbgJson('[claudeAgent] web stream content_block_delta', event);
        } else if (event.type === 'content_block_stop' && webBlockIndices.has(event.index)) {
          webBlockIndices.delete(event.index);
          dbg('[claudeAgent] web stream content_block_stop index=%d', event.index);
        }
        if (event.type === 'message_start') {
          mapperState = createMapperState();
          webBlockIndices.clear();
          dbg('[claudeAgent] partial message_start uuid=%s', msg.uuid);
        }
        if (event.type === 'message_delta') {
          const d = event.delta;
          if (d.stop_reason) lastAssistantStopReason = d.stop_reason;
          const sd = d.stop_details;
          if (sd && sd.type === 'refusal') {
            if (sd.explanation) lastRefusalExplanation = sd.explanation;
            if (sd.category) lastRefusalCategory = sd.category;
          }
          dbg(
            '[claudeAgent] partial message_delta stop_reason=%s refusalCategory=%s',
            d.stop_reason ?? '(none)',
            sd?.type === 'refusal' ? (sd.category ?? '(uncategorized)') : '(n/a)'
          );
        }
        if (!loggedTtft && typeof msg.ttft_ms === 'number') {
          loggedTtft = true;
          console.debug('[claudeAgent] first token ttft_ms=%d', msg.ttft_ms);
        }
        // Route through the shared Anthropic mapper, then drop the chunk types we
        // don't own here: `tool_use` (the MCP side-channel emits bridged tools),
        // `token_usage` (the result message is the authoritative usage source),
        // and `web_*.result` (the coalesced branch is the single emitter of
        // results — the assembler's result handler appends, so it must run once).
        const mapped = mapAnthropicEventToStreamChunks(
          { event: event.type, data: event },
          mapperState
        );
        mapperState = mapped.state;
        for (const chunk of mapped.chunks) {
          if (
            chunk.type === 'tool_use' ||
            chunk.type === 'token_usage' ||
            chunk.type === 'web_search.result' ||
            chunk.type === 'web_fetch.result'
          ) {
            continue;
          }
          if (chunk.type === 'content') {
            textBuf += chunk.content;
            sawTextBlock = true;
          } else if (chunk.type === 'thinking') {
            thinkingBuf += chunk.content;
            sawThinkingBlock = true;
          } else if (chunk.type === 'thinking.start') {
            sawThinkingBlock = true;
          } else if (
            chunk.type === 'web_search' ||
            chunk.type === 'web_search.start' ||
            chunk.type === 'web_fetch' ||
            chunk.type === 'web_fetch.start'
          ) {
            sawToolUse = true;
          }
          yield chunk;
        }
        if (event.type === 'message_stop') {
          dbg('[claudeAgent] partial message_stop');
        }
      } else if (msg.type === 'assistant') {
        assistantUuid = msg.uuid;
        // One coalesced `assistant` per finished content block. When partials are
        // streaming this turn it's metadata + fullContent only (the partial stream
        // already rendered the block live); otherwise it's the live emitter.
        const blocks = msg.message?.content ?? [];
        dbg(
          '[claudeAgent] coalesced assistant uuid=%s partialsActive=%s',
          msg.uuid,
          partialsActive
        );
        dbg(
          '[claudeAgent] assistant blocks=',
          blocks.map(b => ({
            type: b.type,
            ...('text' in b ? { textLen: b.text?.length } : {}),
            ...('thinking' in b ? { thinkingLen: b.thinking?.length } : {}),
            // A thinking block with thinkingLen 0 but a signature is omitted
            // (display:'omitted') thinking — tokens were spent, content redacted.
            // Distinguishes that from a genuinely empty block.
            ...('signature' in b ? { hasSignature: !!b.signature } : {}),
          }))
        );
        // The assistant message can carry a turn-level error (rate_limit,
        // max_output_tokens, server_error, …) that the result message doesn't
        // echo. It's dropped from fullContent, so log + capture it here.
        if (msg.error) {
          lastAssistantError = msg.error;
          console.debug('[claudeAgent] assistant error=%s uuid=%s', msg.error, msg.uuid);
        }
        // The BetaMessage's own stop_reason — the truthful API signal. Captured
        // separately from the result message's session-level stop_reason.
        const msgStopReason = msg.message?.stop_reason ?? undefined;
        if (msgStopReason) {
          lastAssistantStopReason = msgStopReason;
          // Ungated: once per turn and load-bearing for "why did this turn fail".
          console.debug('[claudeAgent] assistant stop_reason=%s uuid=%s', msgStopReason, msg.uuid);
        }
        // Structured refusal info (category + human-readable explanation). The
        // coalesced BetaMessage carries it just like the partial message_delta.
        const msgStopDetails = msg.message?.stop_details;
        if (msgStopDetails && msgStopDetails.type === 'refusal') {
          if (msgStopDetails.explanation) lastRefusalExplanation = msgStopDetails.explanation;
          if (msgStopDetails.category) lastRefusalCategory = msgStopDetails.category;
        }
        if (msgStopReason === 'refusal') {
          // Always-on: a refusal is the headline "why nothing came back" signal,
          // so call it out explicitly instead of leaving it implicit in the
          // stop_reason line above. The explanation is model text that can
          // paraphrase the conversation — content stays gated.
          console.debug(
            '[claudeAgent] REFUSAL category=%s',
            lastRefusalCategory ?? '(uncategorized)'
          );
          dbg('[claudeAgent] refusal explanation=%s', lastRefusalExplanation ?? '(none)');
        }
        for (const block of blocks) {
          if (block.type === 'text') {
            // Record that the model produced text (gates the result-string
            // fallback below) — independent of who renders it.
            sawTextBlock = true;
            dbg(
              '[claudeAgent] coalesced text block emit=%s len=%d',
              !partialsActive,
              block.text.length
            );
            // Partials already streamed this block live → metadata only. Emit only
            // in the no-partials degradation path.
            if (!partialsActive) {
              yield { type: 'content.start' };
              yield { type: 'content', content: block.text };
              yield { type: 'content.end' };
              textBuf += block.text;
            }
            fullContent.push(block);
          } else if (block.type === 'thinking') {
            sawThinkingBlock = true;
            // Surface the thinking length once per block (always-on). The coalesced
            // assistant carries the full block even when partials streamed it live,
            // so this fires exactly once regardless of the streaming path. The
            // chain-of-thought itself is conversation content — gated.
            console.debug('[claudeAgent] thinking block len=%d', block.thinking.length);
            dbg('[claudeAgent] thinking content=%s', block.thinking);
            if (!partialsActive) {
              yield { type: 'thinking.start' };
              yield { type: 'thinking', content: block.thinking };
              yield { type: 'thinking.end' };
              thinkingBuf += block.thinking;
            }
            fullContent.push(block);
          } else if (block.type === 'server_tool_use') {
            sawToolUse = true;
            // Built-in WebSearch/WebFetch invocation by the CLI. Surface it via
            // the shared web_search.*/web_fetch.* chunks (the assembler renders
            // the query + source links). Our mcp__gremlin__* tools never appear
            // here — those results arrive on the side channel.
            dbgJson('[claudeAgent] server_tool_use block', block);
            if (block.name !== 'web_search' && block.name !== 'web_fetch') {
              // Server tool we have no dedicated renderer for (e.g. code
              // execution). The partial mapper only emits for the web tools, so
              // this coalesced branch is the sole emitter — always yield.
              yield {
                type: 'unknown_block',
                blockType: block.type,
                name: block.name,
                id: block.id,
                json: trimBlockJson(block),
              };
            } else if (!partialsActive) {
              if (block.name === 'web_search') {
                const query = typeof block.input.query === 'string' ? block.input.query : '';
                yield { type: 'web_search.start', id: block.id };
                yield { type: 'web_search', id: block.id, query };
              } else {
                const url = typeof block.input.url === 'string' ? block.input.url : '';
                yield { type: 'web_fetch.start', id: block.id };
                yield { type: 'web_fetch', id: block.id, url };
              }
            }
            fullContent.push(block);
          } else if (block.type === 'web_search_tool_result') {
            // `tool_use_id` matches the originating server_tool_use block's id.
            dbgJson('[claudeAgent] web_search_tool_result block', block);
            if (Array.isArray(block.content)) {
              for (const hit of block.content) {
                yield {
                  type: 'web_search.result',
                  tool_use_id: block.tool_use_id,
                  title: hit.title,
                  url: hit.url,
                };
              }
            }
            fullContent.push(block);
          } else if (block.type === 'web_fetch_tool_result') {
            dbgJson('[claudeAgent] web_fetch_tool_result block', block);
            if (block.content.type === 'web_fetch_result') {
              yield {
                type: 'web_fetch.result',
                tool_use_id: block.tool_use_id,
                url: block.content.url,
              };
            }
            fullContent.push(block);
          } else if ((block as { type: string }).type === 'fallback') {
            // The SDK handed the request to a different model (e.g.
            // claude-fable-5 → claude-opus-4-8): `{ from: { model }, to: { model } }`.
            // The published block union may not type 'fallback' yet, so narrow via
            // a cast. Dump the whole block under CLAUDE_AGENT_DEBUG to expose any
            // extra fields. We state the model handoff as a fact and make no claim
            // about why (we don't know — not necessarily a "risky" prompt).
            sawFallback = true;
            dbg('[claudeAgent] fallback block %o', block);
            const fb = block as { from?: { model?: unknown }; to?: { model?: unknown } };
            const fromModel = typeof fb.from?.model === 'string' ? fb.from.model : undefined;
            const toModel = typeof fb.to?.model === 'string' ? fb.to.model : undefined;
            if (treatFallbackAsError) {
              // Surface it as an error — the same path a refusal takes (resultError
              // → error block + loop `status: 'error'`). The SDK has already
              // produced the fallback response by this point, so we can't truly
              // abort generation; we just refuse to present it silently.
              if (!resultError) {
                resultError = { message: describeFallback(fromModel, toModel) };
              }
              fullContent.push(block);
              break;
            }
            // Always emit (like *_tool_result): the partial stream never carries a
            // fallback block, so this coalesced branch is its sole emitter.
            yield {
              type: 'fallback',
              ...(fromModel ? { fromModel } : {}),
              ...(toModel ? { toModel } : {}),
            };
            fullContent.push(block);
          } else if (block.type === 'tool_use') {
            sawToolUse = true;
            // Bridged (mcp__gremlin__*) tools: the MCP side channel already
            // emits their tool_use/tool_result StreamChunks — retain for
            // fullContent only. A non-bridged tool_use (an SDK tool we didn't
            // whitelist knowingly) has no other emitter → generic render.
            if (bridgedToolName(block.name) === null) {
              dbgJson('[claudeAgent] non-bridged tool_use block', block);
              nonBridgedToolUses.set(block.id, block.name);
              yield {
                type: 'unknown_block',
                blockType: block.type,
                name: block.name,
                id: block.id,
                json: trimBlockJson(block),
              };
            }
            fullContent.push(block);
          } else if ((block as { type: string }).type === 'tool_result') {
            // Side-channel domain (see tool_use above); shouldn't appear in
            // assistant messages, but never render it twice if it does.
            fullContent.push(block);
          } else {
            // Block type we don't know at all (new SDK capability). Surface it
            // via the generic unknown-block renderer instead of dropping it.
            dbgJson('[claudeAgent] unknown block', block);
            const raw = block as { type: string; name?: unknown; id?: unknown };
            yield {
              type: 'unknown_block',
              blockType: raw.type,
              ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
              ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
              json: trimBlockJson(block),
            };
            fullContent.push(block);
          }
        }
      } else if (msg.type === 'user') {
        // Tool results ride back on SDK user messages. Bridged (mcp__gremlin__*)
        // results already render via the MCP side channel; results matching a
        // non-bridged tool_use we surfaced (built-in WebSearch/WebFetch, …) get
        // the same generic unknown_block rendering as their call.
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const toolName = nonBridgedToolUses.get(block.tool_use_id);
            if (toolName === undefined) continue;
            dbgJson('[claudeAgent] non-bridged tool_result block', block);
            yield {
              type: 'unknown_block',
              blockType: block.type,
              name: toolName,
              id: block.tool_use_id,
              json: trimBlockJson(block),
            };
          }
        }
      } else if (msg.type === 'result') {
        stopReason = msg.stop_reason ?? msg.subtype;
        usage = mapSdkUsage(msg.usage);
        numTurns = msg.num_turns;
        // `result` (success only) holds the final text — kept as a fallback for
        // turns whose assistant message emitted no text block.
        if ('result' in msg && typeof msg.result === 'string') resultText = msg.result;
        const serverToolUse = (
          msg.usage as { server_tool_use?: { web_search_requests?: number } } | undefined
        )?.server_tool_use;
        if (serverToolUse?.web_search_requests) webSearchCount += serverToolUse.web_search_requests;
        console.debug(
          '[claudeAgent] result subtype=%s stop=%s numTurns=%d resultLen=%d usage=',
          msg.subtype,
          stopReason,
          numTurns,
          resultText.length,
          usage
        );
        yield { type: 'token_usage', ...usage };
        if (msg.subtype !== 'success') {
          resultError = {
            message: `claude-agent: ${msg.subtype}`,
          };
        }
      } else if (msg.type === 'rate_limit_event') {
        // Subscription-quota telemetry (claude.ai Max/Pro), not a per-request
        // 429. Emitted whenever utilization changes — i.e. nearly every turn,
        // tools or not. `status: rejected` means the quota was actually hit and
        // the turn was likely cut; `allowed`/`allowed_warning` is informational.
        const info = msg.rate_limit_info;
        lastRateLimitStatus = info.status;
        // Ungated: ~once per turn and explains rejected-quota turn failures.
        console.debug(
          '[claudeAgent] rate_limit status=%s type=%s utilization=%s resetsAt=%s overageStatus=%s isUsingOverage=%s surpassedThreshold=%s',
          info.status,
          info.rateLimitType ?? '(none)',
          info.utilization ?? '(none)',
          info.resetsAt ?? '(none)',
          info.overageStatus ?? '(none)',
          info.isUsingOverage ?? '(none)',
          info.surpassedThreshold ?? '(none)'
        );
      } else if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
        sdkReportedSessionId = msg.session_id;
        if (msg.session_id !== sessionId) {
          // Expected on forked sends; anywhere else it means the CLI diverged
          // from the id we requested and resumes would silently miss history.
          console.debug(
            '[claudeAgent] init session_id=%s differs from requested %s%s',
            msg.session_id,
            sessionId,
            resumeAt ? ' (forked rewind)' : ' — UNEXPECTED'
          );
        }
      } else if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'api_retry') {
        // The SDK retries retryable errors (overloaded, rate_limit, 5xx) with
        // backoff. Surfacing the attempt + delay explains stalls between turns.
        console.debug(
          '[claudeAgent] api_retry attempt=%d/%d delayMs=%d errorStatus=%s error=%s',
          msg.attempt,
          msg.max_retries,
          msg.retry_delay_ms,
          msg.error_status ?? '(none)',
          msg.error
        );
      } else if (msg.type === 'system' && 'subtype' in msg) {
        // Untyped system telemetry beyond `init` (handled above) — keep it
        // to a one-liner, surfacing the thinking-token estimate when present.
        const sys = msg as { estimated_tokens?: number; estimated_tokens_delta?: number };
        dbg(
          '[claudeAgent] system %s estimated_tokens=%s delta=%s',
          msg.subtype,
          sys.estimated_tokens ?? '(n/a)',
          sys.estimated_tokens_delta ?? '(n/a)'
        );
      }
    };

    const drainQueue = function* (): Generator<StreamChunk, void, unknown> {
      while (chunkQueue.length) {
        yield chunkQueue.shift() as StreamChunk;
      }
    };

    // Resolves as soon as a tool chunk is queued (or immediately if one waits).
    const waitForChunk = (): Promise<{ kind: 'queue' }> =>
      chunkQueue.length > 0
        ? Promise.resolve({ kind: 'queue' as const })
        : new Promise<{ kind: 'queue' }>(resolve => {
            notifyChunk = () => resolve({ kind: 'queue' as const });
          });

    // Merge the SDK message iterator with the tool side-channel: an MCP tool
    // call runs while we await the next SDK message and pushes its chunks onto
    // the queue, so we race both sources and flush the queue first to keep
    // tool_use → tool_result ordered ahead of the assistant text that follows.
    const sdkIter = (iter as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
    try {
      let sdkPending = sdkIter.next().then(res => ({ kind: 'sdk' as const, res }));
      let queuePending = waitForChunk();
      let done = false;
      while (!done) {
        const winner = await Promise.race([sdkPending, queuePending]);
        yield* drainQueue();
        if (winner.kind === 'queue') {
          queuePending = waitForChunk();
          continue;
        }
        if (winner.res.done) {
          done = true;
          break;
        }
        yield* handleSdkMessage(winner.res.value);
        sdkPending = sdkIter.next().then(res => ({ kind: 'sdk' as const, res }));
      }
    } finally {
      options.signal.removeEventListener('abort', onAbort);
    }
    // Flush any chunks pushed during the final SDK step.
    yield* drainQueue();

    // Fallback: the assistant message rendered no text block at all, but the
    // SDK's result message carried final text. Adopt it (and stream it) so the
    // turn isn't a silent empty bubble. Guarded on `sawTextBlock` (not just an
    // empty textBuf) so a turn that DID produce text blocks never collapses into
    // the flat result string — which for an interleaved turn would concatenate
    // every text segment into one block after the thinking.
    dbg(
      '[claudeAgent] text adoption check sawTextBlock=%s textBufLen=%d resultLen=%d willAdopt=%s',
      sawTextBlock,
      textBuf.length,
      resultText.length,
      !sawTextBlock && !!resultText.trim()
    );
    if (!sawTextBlock && resultText.trim()) {
      console.debug(
        '[claudeAgent] adopting result.result as text (len=%d) — assistant blocks had none',
        resultText.length
      );
      yield { type: 'content.start' };
      yield { type: 'content', content: resultText };
      yield { type: 'content.end' };
      textBuf += resultText;
    }

    // Surface a turn that closed "successfully" but rendered nothing usable
    // (see `classifyTurnError`). Gated on `!resultError` so a non-success
    // `result` subtype captured above still wins.
    if (!resultError) {
      resultError = classifyTurnError({
        textLength: textBuf.length,
        thinkingLength: thinkingBuf.length,
        sawThinkingBlock,
        sawToolUse,
        stopReason,
        assistantStopReason: lastAssistantStopReason,
        assistantError: lastAssistantError,
        rateLimitStatus: lastRateLimitStatus,
        refusalExplanation: lastRefusalExplanation,
        refusalCategory: lastRefusalCategory,
        outputTokens: usage.outputTokens,
        sawFallback,
        treatEmptyOutputAsError: apiDefinition.advancedSettings?.treatEmptyOutputAsError === true,
      });
      if (resultError) {
        // Always-on: the SDK closed this turn "successfully" but it produced
        // nothing usable — surface the recovered failure reason rather than
        // letting the loop log a silent empty response.
        console.debug(
          '[claudeAgent] turn reclassified as error (fallback): %s',
          resultError.message
        );
      }
    }

    console.debug(
      '[claudeAgent] stream complete: numTurns=%s textLen=%d thinkingLen=%d resultStop=%s assistantStop=%s rateLimit=%s assistantError=%s assistantUuid=%s',
      numTurns ?? '(n/a)',
      textBuf.length,
      thinkingBuf.length,
      stopReason,
      lastAssistantStopReason ?? '(none)',
      lastRateLimitStatus ?? '(none)',
      lastAssistantError ?? '(none)',
      assistantUuid
    );

    // The session-level result stop_reason is often a generic `end_turn` even
    // when the assistant message ended badly (e.g. mid-text `max_tokens` from
    // the CLAUDE_CODE_MAX_OUTPUT_TOKENS cap). Surface the assistant-level
    // reason only when it's a bad one: the truthful value drives the minion
    // abnormal-stop rewind and the Truncated badge, while benign mid-turn
    // values (`tool_use` between bridged calls) must not leak into the loop's
    // continuation check.
    const surfacedStopReason =
      lastAssistantStopReason && BAD_STOP_REASONS.includes(lastAssistantStopReason)
        ? lastAssistantStopReason
        : stopReason;

    return {
      textContent: textBuf,
      thinkingContent: thinkingBuf,
      hasCoT: thinkingBuf.length > 0,
      fullContent,
      stopReason: surfacedStopReason,
      ...usage,
      ...(webSearchCount > 0 ? { webSearchCount } : {}),
      ...(resultError ? { error: resultError } : {}),
      // Sub-agent (minion) costs the SDK incurred via our bridged tools. The
      // agentic loop folds this into chat totals (guarded by hasTokenUsage).
      toolTokenTotals,
      // Chat title/summary set via the bridged metadata tool this turn. The
      // loop yields it as a `chat_metadata_updated` event after the turn.
      ...(chatMetadata ? { chatMetadata } : {}),
      providerExtra: {
        claudeAgentSessionId: sdkReportedSessionId ?? sessionId,
        claudeAgentMessageUuid: assistantUuid,
        ...(claudeAgentReturnValue !== undefined ? { claudeAgentReturnValue } : {}),
        ...(claudeAgentActiveHook !== undefined ? { claudeAgentActiveHook } : {}),
        ...(lastRateLimitStatus ? { rateLimitStatus: lastRateLimitStatus } : {}),
      },
    };
  }

  extractToolUseBlocks(_fullContent: unknown): ToolUseBlock[] {
    return [];
  }
}

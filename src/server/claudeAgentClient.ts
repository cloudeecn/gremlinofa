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
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
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
import { addTokens, createTokenTotals } from '../shared/engine/lib/tokenTotals';
import { buildGremlinMcpServer, MCP_SERVER_NAME } from './claudeAgentToolBridge';

/** Hard-coded model list — the SDK has no listing endpoint. */
const CLAUDE_AGENT_MODELS = [
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

/** Extract the latest user text content from the message thread. */
function extractLastUserText(messages: Message<unknown>[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return m.content.content ?? '';
  }
  return '';
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

export interface ClaudeAgentClientOptions {
  /** Override the SDK `query` entry point (tests inject a fake). */
  query?: typeof query;
  /** Override the session dir resolver (tests inject a tmp dir). */
  sessionDir?: () => string;
  /** Override UUID generator (tests assert a deterministic ID). */
  generateSessionId?: () => string;
}

export class ClaudeAgentClient implements APIClient {
  protected readonly deps: APIServiceDeps;
  private readonly queryFn: typeof query;
  private readonly sessionDir: () => string;
  private readonly generateSessionId: () => string;

  constructor(deps: APIServiceDeps, options: ClaudeAgentClientOptions = {}) {
    this.deps = deps;
    this.queryFn = options.query ?? query;
    this.sessionDir = options.sessionDir ?? defaultSessionDir;
    this.generateSessionId = options.generateSessionId ?? (() => randomUUID());
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
    } & Record<string, unknown>
  ): AsyncGenerator<StreamChunk, StreamResult<Anthropic.Beta.BetaContentBlock[]>, unknown> {
    const lastUser = extractLastUserText(messages);
    if (!lastUser) {
      throw new Error('claude-agent: no user message to send');
    }

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

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    options.signal.addEventListener('abort', onAbort);

    // Map our reasoning controls onto SDK shapes.
    //   - explicit `false` → disabled
    //   - explicit `true` + positive budget → enabled with that budget
    //   - explicit `true` + budget 0 / missing → omit `thinking` so the SDK's
    //     adaptive default kicks in (matches GremlinOFA's "0 = adaptive"
    //     convention; required for Opus 4.7+ which is `onlyAdaptiveReasoning`
    //     and ignores `budgetTokens` entirely — control the level via `effort`)
    //   - both unset → omit
    let thinking: { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } | undefined;
    if (options.enableReasoning === false) {
      thinking = { type: 'disabled' };
    } else if (
      options.enableReasoning === true &&
      typeof options.reasoningBudgetTokens === 'number' &&
      options.reasoningBudgetTokens > 0
    ) {
      thinking = { type: 'enabled', budgetTokens: options.reasoningBudgetTokens };
    }

    // --- Tool bridge ------------------------------------------------------
    // Expose the enabled, bridgeable subset of our internal tools to the SDK
    // as an in-process MCP server. The MCP handlers can't yield into this
    // generator, so they push synthetic StreamChunks onto `chunkQueue`; the
    // streaming loop below merges that queue with the SDK message iterator.
    const chunkQueue: StreamChunk[] = [];
    let notifyChunk: (() => void) | null = null;
    const pushChunk = (chunk: StreamChunk): void => {
      chunkQueue.push(chunk);
      const notify = notifyChunk;
      notifyChunk = null;
      notify?.();
    };
    // Sub-agent (minion) costs accrue here — the SDK's own `result.usage` never
    // includes them since they come from our apiService. Surfaced on the
    // StreamResult so the agentic loop folds them into the chat totals.
    const toolTokenTotals = createTokenTotals();

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

    // Note: the project's max output tokens (`options.maxTokens`) has no SDK
    // equivalent — `Options` exposes only `effort` / deprecated
    // `maxThinkingTokens` / `maxTurns`, so a claude-agent turn's output length
    // is governed by `effort` + CLI/model defaults. We intentionally don't
    // forward it; the value is a no-op for this provider.
    const sdkOptions: Options = {
      model: modelId,
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
      ...(thinking ? { thinking } : {}),
      ...(options.reasoningEffort && options.reasoningEffort !== 'none'
        ? { effort: options.reasoningEffort as Options['effort'] }
        : {}),
      ...(isFirstTurn
        ? { sessionId }
        : { resume: sessionId, ...(resumeAt ? { resumeSessionAt: resumeAt } : {}) }),
    };

    // Logged with env stripped — full process.env would leak credentials.
    // `prompt` is logged separately so the redacted env doesn't make
    // debugging the actual content harder.
    const { env: _envForLog, abortController: _ac, ...sdkOptionsForLog } = sdkOptions;
    console.debug('[claudeAgent] query() prompt=', lastUser);
    console.debug('[claudeAgent] query() options=', sdkOptionsForLog);
    console.debug(
      '[claudeAgent] turn lifecycle: isFirstTurn=%s sessionId=%s resumeAt=%s',
      isFirstTurn,
      sessionId,
      resumeAt ?? '(none)'
    );

    const iter = this.queryFn({ prompt: lastUser, options: sdkOptions });

    const fullContent: Anthropic.Beta.BetaContentBlock[] = [];
    let textBuf = '';
    let thinkingBuf = '';
    let stopReason: string | undefined;
    let assistantUuid: string | undefined;
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
    let loggedTtft = false;
    // Debug-only counters for reconstructing the partial stream shape in logs
    // without per-token spam (trim these logs before a PR — see development.md).
    let dbgDeltaCount = 0;
    let dbgDeltaType = '';
    // Built-in WebSearch requests the SDK reports on its result usage. Surfaced
    // for the "N searches" display only — claude-agent cost is subscription-zeroed.
    let webSearchCount = 0;

    // Map one SDK message to our StreamChunks, updating the closure state.
    // Closes over the accumulators above (assignment to outer `let` is fine).
    const handleSdkMessage = function* (msg: SDKMessage): Generator<StreamChunk, void, unknown> {
      // Log every SDK message — verbose but invaluable when debugging
      // resume/rollback issues. `type` + `subtype`/`uuid` is usually enough.
      // Skip `stream_event` here: with includePartialMessages it fires per token,
      // so logging each would bury the lifecycle one-liners (the branch below
      // logs the few partial events worth seeing).
      if (msg.type !== 'stream_event') {
        console.debug(
          '[claudeAgent] sdk msg type=%s%s%s',
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
        if (event.type === 'message_start') {
          mapperState = createMapperState();
          console.debug('[claudeAgent] partial message_start uuid=%s', msg.uuid);
        }
        // Debug: reconstruct the per-block partial shape without per-token spam.
        if (event.type === 'content_block_start') {
          dbgDeltaCount = 0;
          dbgDeltaType = '';
          console.debug(
            '[claudeAgent] partial block.start index=%s type=%s',
            event.index,
            event.content_block.type
          );
        } else if (event.type === 'content_block_delta') {
          dbgDeltaCount += 1;
          dbgDeltaType = event.delta.type;
        } else if (event.type === 'content_block_stop') {
          console.debug(
            '[claudeAgent] partial block.stop index=%s deltas=%d deltaType=%s',
            event.index,
            dbgDeltaCount,
            dbgDeltaType
          );
        }
        if (event.type === 'message_delta') {
          const d = event.delta;
          if (d.stop_reason) lastAssistantStopReason = d.stop_reason;
          const sd = d.stop_details;
          if (sd && sd.type === 'refusal') {
            if (sd.explanation) lastRefusalExplanation = sd.explanation;
            if (sd.category) lastRefusalCategory = sd.category;
          }
          console.debug(
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
          console.debug('[claudeAgent] partial message_stop');
        }
      } else if (msg.type === 'assistant') {
        assistantUuid = msg.uuid;
        // One coalesced `assistant` per finished content block. When partials are
        // streaming this turn it's metadata + fullContent only (the partial stream
        // already rendered the block live); otherwise it's the live emitter.
        const blocks = msg.message?.content ?? [];
        console.debug(
          '[claudeAgent] coalesced assistant uuid=%s partialsActive=%s',
          msg.uuid,
          partialsActive
        );
        console.debug(
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
          console.debug('[claudeAgent] assistant stop_reason=%s uuid=%s', msgStopReason, msg.uuid);
        }
        // Structured refusal info (category + human-readable explanation). The
        // coalesced BetaMessage carries it just like the partial message_delta.
        const msgStopDetails = msg.message?.stop_details;
        if (msgStopDetails && msgStopDetails.type === 'refusal') {
          if (msgStopDetails.explanation) lastRefusalExplanation = msgStopDetails.explanation;
          if (msgStopDetails.category) lastRefusalCategory = msgStopDetails.category;
        }
        for (const block of blocks) {
          if (block.type === 'text') {
            // Record that the model produced text (gates the result-string
            // fallback below) — independent of who renders it.
            sawTextBlock = true;
            console.debug(
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
            if (!partialsActive) {
              if (block.name === 'web_search') {
                const query = typeof block.input.query === 'string' ? block.input.query : '';
                yield { type: 'web_search.start', id: block.id };
                yield { type: 'web_search', id: block.id, query };
              } else if (block.name === 'web_fetch') {
                const url = typeof block.input.url === 'string' ? block.input.url : '';
                yield { type: 'web_fetch.start', id: block.id };
                yield { type: 'web_fetch', id: block.id, url };
              }
            }
            fullContent.push(block);
          } else if (block.type === 'web_search_tool_result') {
            // `tool_use_id` matches the originating server_tool_use block's id.
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
            if (block.content.type === 'web_fetch_result') {
              yield {
                type: 'web_fetch.result',
                tool_use_id: block.tool_use_id,
                url: block.content.url,
              };
            }
            fullContent.push(block);
          } else {
            // tool_use / tool_result blocks: the MCP bridge already emits
            // tool_use/tool_result StreamChunks via the side channel, so don't
            // render them here — just retain for fullContent/session fidelity.
            if (block.type === 'tool_use') sawToolUse = true;
            fullContent.push(block);
          }
        }
      } else if (msg.type === 'result') {
        stopReason = msg.stop_reason ?? msg.subtype;
        usage = mapSdkUsage(msg.usage);
        // `result` (success only) holds the final text — kept as a fallback for
        // turns whose assistant message emitted no text block.
        if ('result' in msg && typeof msg.result === 'string') resultText = msg.result;
        const serverToolUse = (
          msg.usage as { server_tool_use?: { web_search_requests?: number } } | undefined
        )?.server_tool_use;
        if (serverToolUse?.web_search_requests) webSearchCount += serverToolUse.web_search_requests;
        console.debug(
          '[claudeAgent] result subtype=%s stop=%s resultLen=%d usage=',
          msg.subtype,
          stopReason,
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
      } else if (msg.type === 'system' && 'subtype' in msg && msg.subtype !== 'init') {
        // Untyped system telemetry beyond `init` (e.g. thinking_tokens) — keep it
        // to a one-liner, surfacing the thinking-token estimate when present.
        const sys = msg as { estimated_tokens?: number; estimated_tokens_delta?: number };
        console.debug(
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
    console.debug(
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

    // Surface a turn that closed "successfully" but rendered nothing. The SDK
    // can report subtype=success / stop=end_turn while emitting only omitted
    // thinking and no text — e.g. a paused/refused turn whose real signal lives
    // on the assistant message's stop_reason (the result's session-level reason
    // is a generic end_turn), the CLI cutting generation on a rejected quota, or
    // an assistant-level hard error the result never echoes. Without this the
    // agentic loop just logs "Complete with empty response" and the minion
    // silently stalls.
    const HARD_ASSISTANT_ERRORS = [
      'rate_limit',
      'max_output_tokens',
      'server_error',
      'billing_error',
      'overloaded',
    ];
    // Terminal reasons that mean "no usable answer" — including pause_turn, which
    // signals the turn needs continuation the SDK didn't perform here.
    const BAD_STOP_REASONS = [
      'max_tokens',
      'refusal',
      'pause_turn',
      'model_context_window_exceeded',
    ];
    const producedNothing = textBuf.length === 0 && thinkingBuf.length === 0;
    const hardAssistantError =
      !!lastAssistantError && HARD_ASSISTANT_ERRORS.includes(lastAssistantError);
    const badStop = !!lastAssistantStopReason && BAD_STOP_REASONS.includes(lastAssistantStopReason);
    // A refusal always errors — even when the model streamed partial text first —
    // so the loop surfaces it (status: 'error') with the human-readable reason
    // rather than leaving a half-answer that looks complete. Built from the
    // refusal `stop_details` captured off the coalesced message or the partial
    // message_delta. This runs unconditionally (not gated on producedNothing);
    // setting `resultError` here means the producedNothing block below skips it.
    const refusalMessage =
      lastAssistantStopReason === 'refusal'
        ? `claude-agent: refused${lastRefusalExplanation ? ` — ${lastRefusalExplanation}` : ''}${
            lastRefusalCategory ? ` (category: ${lastRefusalCategory})` : ''
          }`
        : undefined;
    if (!resultError && refusalMessage) {
      resultError = { message: refusalMessage };
    }
    // The observed failure: the model spent its output budget on omitted/empty
    // thinking, emitted no text and called no tool, and the turn closed with no
    // distinguishing signal (allowed quota, no error, null stop_reason). Burning
    // thinking tokens with zero output is a malfunction, not a deliberate empty
    // reply — surface it. A turn with no thinking either is left for the loop's
    // `treatEmptyOutputAsError` to honor the project's preference.
    const thinkingOnly =
      producedNothing && sawThinkingBlock && !sawToolUse && stopReason !== 'tool_use';
    if (
      !resultError &&
      producedNothing &&
      (hardAssistantError || badStop || lastRateLimitStatus === 'rejected' || thinkingOnly)
    ) {
      resultError = {
        message: hardAssistantError
          ? `claude-agent: ${lastAssistantError}`
          : badStop
            ? `claude-agent: turn ended with stop_reason=${lastAssistantStopReason} and no output`
            : lastRateLimitStatus === 'rejected'
              ? 'claude-agent: turn rejected (rate_limit_status=rejected)'
              : `claude-agent: turn produced only thinking and no output (${usage.outputTokens} output tokens spent)`,
      };
    }

    console.debug(
      '[claudeAgent] stream complete: textLen=%d thinkingLen=%d resultStop=%s assistantStop=%s rateLimit=%s assistantError=%s assistantUuid=%s',
      textBuf.length,
      thinkingBuf.length,
      stopReason,
      lastAssistantStopReason ?? '(none)',
      lastRateLimitStatus ?? '(none)',
      lastAssistantError ?? '(none)',
      assistantUuid
    );

    return {
      textContent: textBuf,
      thinkingContent: thinkingBuf,
      hasCoT: thinkingBuf.length > 0,
      fullContent,
      stopReason,
      ...usage,
      ...(webSearchCount > 0 ? { webSearchCount } : {}),
      ...(resultError ? { error: resultError } : {}),
      // Sub-agent (minion) costs the SDK incurred via our bridged tools. The
      // agentic loop folds this into chat totals (guarded by hasTokenUsage).
      toolTokenTotals,
      providerExtra: {
        claudeAgentSessionId: sessionId,
        claudeAgentMessageUuid: assistantUuid,
        ...(lastRateLimitStatus ? { rateLimitStatus: lastRateLimitStatus } : {}),
      },
    };
  }

  extractToolUseBlocks(_fullContent: unknown): ToolUseBlock[] {
    return [];
  }
}

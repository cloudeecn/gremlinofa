/**
 * Bridges GremlinOFA's internal client-side tools into the Claude Agent SDK.
 *
 * For the `claude-agent` provider the SDK owns the agentic loop — the host
 * `claude` CLI runs the whole multi-tool turn internally, so our own
 * `agenticLoopGenerator` never dispatches tools. To let a claude-agent chat
 * use our tools we register them as an in-process MCP server (passed via the
 * SDK's `mcpServers` option). The model sees them as `mcp__gremlin__<name>`;
 * each call is dispatched through `executeToolSimple` with the same
 * `ToolContext` the loop would have used.
 *
 * Schema fidelity: `McpServer.registerTool` forces a Zod schema and would lose
 * our exact JSON Schema (notably minion's dynamic `anyOf`). We instead drive
 * the inner low-level `Server` directly with manual `tools/list` / `tools/call`
 * handlers, so the model sees the byte-for-byte schema every other provider
 * gets. The `McpServer` wrapper still satisfies the SDK's `instance` type and
 * its `connect()` delegates to the low-level server.
 *
 * Server-mode only: this module imports the SDK + MCP packages, which must stay
 * out of the worker bundle. It lives under `src/server/` and is never imported
 * by the worker entry.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ToolContext, ToolOptions, TokenTotals } from '../shared/protocol/types';
import type { StreamChunk } from '../shared/services/api/baseClient';
import { executeToolSimple } from '../shared/services/tools/clientSideTools';

/** MCP server name; tools surface to the model as `mcp__gremlin__<tool>`. */
export const MCP_SERVER_NAME = 'gremlin';

export interface GremlinMcpBridge {
  /** Ready to drop into the SDK's `mcpServers` map. */
  server: McpSdkServerConfigWithInstance;
  /** Exact `mcp__gremlin__*` names to put on the SDK's `allowedTools`. */
  allowedTools: string[];
}

export interface BuildGremlinMcpServerParams {
  /** Prebuilt loop context (vfs/storage/apiService/loopRegistry/loopId/…). */
  toolContext: ToolContext;
  /** The run's enabled tool names; intersected with the bridgeable set. */
  enabledTools: string[];
  toolOptions: Record<string, ToolOptions>;
  /** Per-query abort signal so a turn abort cascades into in-flight tools. */
  signal: AbortSignal;
  /** Pushes synthetic StreamChunks (tool_use/tool_result) to the client stream. */
  pushChunk: (chunk: StreamChunk) => void;
  /** Receives sub-agent (minion) costs so the client can surface them. */
  onToolTokens: (totals: TokenTotals) => void;
  /**
   * Receives chat title/summary changes from the `metadata` tool. The SDK owns
   * the turn so these can't apply mid-turn; the client surfaces them on the
   * StreamResult to be folded in after the turn.
   */
  onChatMetadata: (metadata: { name?: string; summary?: string }) => void;
  /**
   * Receives the value from the `return` tool (minion sub-agents). The bridge
   * can't break the SDK's turn, so this is free-run: the value is stored here
   * and the SDK keeps running. The client surfaces it on the StreamResult; the
   * agentic loop reports it as the minion's result. Last-write-wins.
   */
  onReturnValue: (value: string) => void;
  /**
   * Receives the DUMMY-system hook change from the `dummy` tool (string =
   * activate, null = deactivate). The SDK owns the turn so it can't swap the
   * outer-loop hook mid-turn; the bridge hands it to the client, which surfaces
   * it on the StreamResult, and the loop activates it after the turn (it fires
   * on the next iteration, before the next SDK turn). Last-write-wins.
   */
  onActiveHook: (hook: string | null) => void;
}

/**
 * Build an in-process MCP server exposing the bridgeable subset of the run's
 * enabled tools. Returns `null` when nothing is bridgeable (caller then keeps
 * the SDK's default no-tools behavior).
 */
export function buildGremlinMcpServer(
  params: BuildGremlinMcpServerParams
): GremlinMcpBridge | null {
  const {
    toolContext,
    enabledTools,
    toolOptions,
    signal,
    pushChunk,
    onToolTokens,
    onChatMetadata,
    onReturnValue,
    onActiveHook,
  } = params;

  const bridged = enabledTools.filter(
    name => toolContext.toolRegistry.get(name)?.claudeAgentBridgeable
  );
  if (bridged.length === 0) return null;

  const defs = toolContext.toolRegistry.getToolDefinitions(bridged, toolOptions);
  const ctx: ToolContext = { ...toolContext, signal };

  const mcp = new McpServer({ name: MCP_SERVER_NAME, version: '1.0.0' });
  // Drive the low-level server directly (see file header for why we bypass
  // registerTool). Capabilities must be registered before any setRequestHandler.
  mcp.server.registerCapabilities({ tools: {} });

  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: defs.map(d => ({
      name: d.name,
      description: d.description,
      // Our exact JSON Schema, passed through verbatim (no Zod round-trip).
      inputSchema: d.input_schema as { type: 'object'; [k: string]: unknown },
    })),
  }));

  // Mints a stable id per call so the tool_use chunk pairs with its tool_result
  // chunk — MCP doesn't surface the model's own tool_use block id to the server.
  let callSeq = 0;

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const input = (request.params.arguments ?? {}) as Record<string, unknown>;
    const toolUseId = `mcp_${MCP_SERVER_NAME}_${++callSeq}`;

    pushChunk({ type: 'tool_use', id: toolUseId, name, input });

    const result = await executeToolSimple(name, input, enabledTools, toolOptions, ctx);

    if (result.tokenTotals) onToolTokens(result.tokenTotals);
    if (result.chatMetadata) onChatMetadata(result.chatMetadata);
    // Free-run return: the tool's `breakLoop.returnValue` can't stop the SDK
    // here, so hand it to the client to surface on the StreamResult instead.
    if (result.breakLoop?.returnValue !== undefined) onReturnValue(result.breakLoop.returnValue);
    // DUMMY hook (un)register: `null` is the meaningful "deactivate" value, so
    // gate on `!== undefined` (a plain truthiness check would swallow it).
    if (result.activeHook !== undefined) onActiveHook(result.activeHook);

    pushChunk({
      type: 'tool_result',
      tool_use_id: toolUseId,
      name,
      content: result.content,
      isError: result.isError,
      ...(result.renderingGroups ? { renderingGroups: result.renderingGroups } : {}),
      ...(result.tokenTotals ? { tokenTotals: result.tokenTotals } : {}),
    });

    return {
      content: [{ type: 'text', text: result.content }],
      ...(result.isError ? { isError: true } : {}),
    };
  });

  return {
    server: { type: 'sdk', name: MCP_SERVER_NAME, instance: mcp },
    allowedTools: bridged.map(n => `mcp__${MCP_SERVER_NAME}__${n}`),
  };
}

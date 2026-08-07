/**
 * Tests for the claude-agent tool bridge.
 *
 * The bridge exposes our internal tools to the Claude Agent SDK as an
 * in-process MCP server. We drive it end-to-end through an in-memory MCP
 * Client/Server transport pair to prove: (1) only the enabled, bridgeable
 * tools are exposed, (2) our exact JSON Schema survives the round-trip (no
 * lossy Zod conversion), and (3) a call dispatches to our tool and surfaces
 * the result plus the synthetic tool_use/tool_result StreamChunks and token
 * totals on the side channel.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildGremlinMcpServer } from '../claudeAgentToolBridge';
import { ClientSideToolRegistry } from '../../shared/services/tools/clientSideTools';
import type { ClientSideTool, TokenTotals, ToolContext } from '../../shared/protocol/types';
import type { StreamChunk } from '../../shared/services/api/baseClient';

const ECHO_SCHEMA = {
  type: 'object' as const,
  properties: { message: { type: 'string', description: 'message to echo' } },
  required: ['message'],
};

function tokenTotals(cost: number): TokenTotals {
  return {
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchCount: 0,
    cost,
    costUnreliable: false,
  };
}

const echoTool: ClientSideTool = {
  name: 'echo',
  claudeAgentBridgeable: true,
  description: 'Echo the message back',
  inputSchema: ECHO_SCHEMA,
  iconOutput: '🔁',
  execute: async input => ({
    content: `echo:${String(input.message)}`,
    tokenTotals: tokenTotals(0.5),
  }),
};

const errorTool: ClientSideTool = {
  name: 'boom',
  claudeAgentBridgeable: true,
  description: 'Always errors',
  inputSchema: { type: 'object', properties: {}, required: [] },
  execute: async () => ({ content: 'kaboom', isError: true }),
};

const metaTool: ClientSideTool = {
  name: 'meta',
  claudeAgentBridgeable: true,
  description: 'Sets chat metadata',
  inputSchema: { type: 'object', properties: {}, required: [] },
  execute: async () => ({
    content: 'metadata updated',
    chatMetadata: { name: 'Renamed', summary: 'A summary' },
  }),
};

const hiddenTool: ClientSideTool = {
  name: 'secret',
  // Not bridgeable — must never reach the SDK.
  description: 'hidden',
  inputSchema: { type: 'object', properties: {}, required: [] },
  execute: async () => ({ content: 'nope' }),
};

// Mirrors the real `return` tool: free-run value via breakLoop. The bridge can't
// stop the SDK turn, so it forwards the value on the onReturnValue side channel.
const returnish: ClientSideTool = {
  name: 'returnish',
  claudeAgentBridgeable: true,
  description: 'Returns a value',
  inputSchema: {
    type: 'object',
    properties: { result: { type: 'string' } },
    required: ['result'],
  },
  execute: async input => ({
    content: String(input.result),
    breakLoop: { returnValue: String(input.result) },
  }),
};

// Mirrors the real `dummy` tool: register returns an activeHook string,
// unregister returns null. The bridge forwards both on the onActiveHook side
// channel; `null` must survive (it means "deactivate").
const hookish: ClientSideTool = {
  name: 'hookish',
  claudeAgentBridgeable: true,
  description: '(De)activates a DUMMY hook',
  inputSchema: {
    type: 'object',
    properties: { action: { type: 'string' } },
    required: ['action'],
  },
  execute: async input =>
    input.action === 'register'
      ? { content: 'hook on', activeHook: 'my-hook' }
      : { content: 'hook off', activeHook: null },
};

function makeContext(): ToolContext {
  const registry = new ClientSideToolRegistry();
  registry.registerAll([echoTool, errorTool, hiddenTool, metaTool, returnish, hookish]);
  return { toolRegistry: registry } as unknown as ToolContext;
}

const noop = () => {};

describe('claudeAgentToolBridge', () => {
  it('returns null when no enabled tool is bridgeable', () => {
    const bridge = buildGremlinMcpServer({
      toolContext: makeContext(),
      enabledTools: ['secret'],
      toolOptions: {},
      signal: new AbortController().signal,
      pushChunk: noop,
      onToolTokens: noop,
      onChatMetadata: noop,
      onReturnValue: noop,
      onActiveHook: noop,
    });
    expect(bridge).toBeNull();
  });

  it('exposes only the bridgeable subset and namespaces allowedTools', () => {
    const bridge = buildGremlinMcpServer({
      toolContext: makeContext(),
      enabledTools: ['echo', 'secret', 'boom'],
      toolOptions: {},
      signal: new AbortController().signal,
      pushChunk: noop,
      onToolTokens: noop,
      onChatMetadata: noop,
      onReturnValue: noop,
      onActiveHook: noop,
    });
    expect(bridge).not.toBeNull();
    expect(bridge!.server.type).toBe('sdk');
    expect(bridge!.server.name).toBe('gremlin');
    expect(bridge!.allowedTools).toEqual(['mcp__gremlin__echo', 'mcp__gremlin__boom']);
  });

  it('round-trips exact JSON Schema and dispatches calls to our tools', async () => {
    const chunks: StreamChunk[] = [];
    const tokens: TokenTotals[] = [];
    const metadata: Array<{ name?: string; summary?: string }> = [];
    const returnValues: string[] = [];
    const activeHooks: Array<string | null> = [];
    const bridge = buildGremlinMcpServer({
      toolContext: makeContext(),
      enabledTools: ['echo', 'boom', 'meta', 'returnish', 'hookish'],
      toolOptions: {},
      signal: new AbortController().signal,
      pushChunk: c => chunks.push(c),
      onToolTokens: t => tokens.push(t),
      onChatMetadata: m => metadata.push(m),
      onReturnValue: v => returnValues.push(v),
      onActiveHook: h => activeHooks.push(h),
    })!;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bridge.server.instance.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);

    // (1) Schema fidelity — the model sees our exact JSON Schema.
    const list = await client.listTools();
    const echoDef = list.tools.find(t => t.name === 'echo');
    expect(echoDef?.inputSchema).toEqual(ECHO_SCHEMA);

    // (2) A successful call dispatches to our tool and surfaces chunks + tokens.
    const ok = await client.callTool({ name: 'echo', arguments: { message: 'hi' } });
    expect(ok.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    expect(ok.isError).toBeFalsy();

    expect(chunks.map(c => c.type)).toEqual(['tool_use', 'tool_result']);
    const toolUse = chunks[0] as Extract<StreamChunk, { type: 'tool_use' }>;
    const toolResult = chunks[1] as Extract<StreamChunk, { type: 'tool_result' }>;
    expect(toolUse).toMatchObject({ name: 'echo', input: { message: 'hi' } });
    expect(toolResult).toMatchObject({
      name: 'echo',
      content: 'echo:hi',
      tool_use_id: toolUse.id,
    });
    expect(toolResult.tokenTotals?.cost).toBe(0.5);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].cost).toBe(0.5);

    // (3) An error result round-trips with isError.
    const err = await client.callTool({ name: 'boom', arguments: {} });
    expect(err.isError).toBe(true);
    expect(err.content).toEqual([{ type: 'text', text: 'kaboom' }]);

    // The echo and boom calls carry no chatMetadata signal.
    expect(metadata).toHaveLength(0);

    // (4) A chatMetadata-bearing result surfaces on the side channel for the
    // client to fold into the chat after the turn.
    const meta = await client.callTool({ name: 'meta', arguments: {} });
    expect(meta.content).toEqual([{ type: 'text', text: 'metadata updated' }]);
    expect(metadata).toEqual([{ name: 'Renamed', summary: 'A summary' }]);

    // The echo/boom/meta calls carried no return value.
    expect(returnValues).toHaveLength(0);

    // (5) Free-run return: a breakLoop.returnValue surfaces on the onReturnValue
    // side channel (the bridge can't stop the SDK turn), and the tool still
    // returns its content to the model so the turn continues.
    const ret = await client.callTool({ name: 'returnish', arguments: { result: 'final answer' } });
    expect(ret.content).toEqual([{ type: 'text', text: 'final answer' }]);
    expect(ret.isError).toBeFalsy();
    expect(returnValues).toEqual(['final answer']);

    // No DUMMY hook signal from any of the calls so far.
    expect(activeHooks).toHaveLength(0);

    // (6) DUMMY hook: register surfaces the hook name, unregister surfaces null
    // (both ride the onActiveHook side channel; `null` survives as "deactivate").
    await client.callTool({ name: 'hookish', arguments: { action: 'register' } });
    expect(activeHooks).toEqual(['my-hook']);
    await client.callTool({ name: 'hookish', arguments: { action: 'unregister' } });
    expect(activeHooks).toEqual(['my-hook', null]);

    await client.close();
  });
});

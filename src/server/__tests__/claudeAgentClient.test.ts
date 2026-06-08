/**
 * Unit tests for the Claude Agent SDK client.
 *
 * The real SDK spawns the host `claude` CLI subprocess, so every test
 * injects a fake `query` that returns a scripted async iterable of
 * `SDKMessage`-shaped events. We assert the StreamChunk[] sequence,
 * the StreamResult shape, and the SDK options derived from our
 * GremlinOFA-side knobs (reasoning, auth, resume).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ClaudeAgentClient,
  classifyTurnError,
  type TurnOutcomeSignals,
} from '../claudeAgentClient';
import type {
  APIDefinition,
  ClientSideTool,
  Message,
  ToolContext,
} from '../../shared/protocol/types';
import { APIService, type APIServiceDeps } from '../../shared/services/api/apiService';
import type { StreamChunk } from '../../shared/services/api/baseClient';
import { StreamingContentAssembler } from '../../shared/services/streaming/StreamingContentAssembler';
import { ClientSideToolRegistry } from '../../shared/services/tools/clientSideTools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function makeDeps(): APIServiceDeps {
  return {
    storage: {} as APIServiceDeps['storage'],
    toolRegistry: {} as APIServiceDeps['toolRegistry'],
    encryption: {} as APIServiceDeps['encryption'],
  };
}

function makeApiDef(overrides: Partial<APIDefinition> = {}): APIDefinition {
  return {
    id: 'def_test',
    apiType: 'claude-agent',
    name: 'test',
    baseUrl: '',
    apiKey: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function userMessage(text: string): Message<unknown> {
  return {
    id: 'm1',
    role: 'user',
    content: { type: 'text', content: text },
    timestamp: new Date(),
  };
}

interface ScriptedTurn {
  uuid?: string;
  text?: string;
  thinking?: string;
  subtype?: 'success' | 'error_during_execution';
  stop_reason?: string;
}

function makeFakeQuery(turn: ScriptedTurn, optsSink: { value?: unknown } = {}) {
  // The signature mirrors `@anthropic-ai/claude-agent-sdk`'s `query`.
  return vi.fn((params: { prompt: unknown; options?: unknown }) => {
    optsSink.value = params.options;
    const iter = (async function* () {
      yield {
        type: 'system' as const,
        subtype: 'init' as const,
        session_id: 'sess-1',
      };
      yield {
        type: 'assistant' as const,
        uuid: turn.uuid ?? 'asst-uuid-1',
        session_id: 'sess-1',
        message: {
          content: [
            ...(turn.thinking ? [{ type: 'thinking', thinking: turn.thinking }] : []),
            ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
          ],
        },
      };
      yield {
        type: 'result' as const,
        subtype: turn.subtype ?? 'success',
        stop_reason: turn.stop_reason ?? 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };
    })();
    return iter as unknown;
  });
}

/**
 * Scripts a turn that closes as subtype=success but renders nothing useful —
 * the empty-response shape we're instrumenting. Optionally carries an assistant
 * `error` and/or a `rate_limit_event` with a given status.
 */
function makeFailingTurnQuery(opts: {
  assistantError?: string;
  rateLimitStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  text?: string;
  thinking?: { thinking: string; signature?: string };
  /** BetaMessage-level stop_reason on the assistant message. */
  messageStopReason?: string;
  /** Final text on the result message (the `result` string). */
  resultText?: string;
}) {
  return vi.fn(
    () =>
      (async function* () {
        yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
        yield {
          type: 'assistant' as const,
          uuid: 'a1',
          session_id: 's',
          ...(opts.assistantError ? { error: opts.assistantError } : {}),
          message: {
            ...(opts.messageStopReason ? { stop_reason: opts.messageStopReason } : {}),
            content: [
              ...(opts.thinking
                ? [
                    {
                      type: 'thinking',
                      thinking: opts.thinking.thinking,
                      signature: opts.thinking.signature,
                    },
                  ]
                : []),
              ...(opts.text ? [{ type: 'text', text: opts.text }] : []),
            ],
          },
        };
        if (opts.rateLimitStatus) {
          yield {
            type: 'rate_limit_event' as const,
            uuid: 'rl1',
            session_id: 's',
            rate_limit_info: {
              status: opts.rateLimitStatus,
              rateLimitType: 'seven_day_opus',
              utilization: 0.97,
            },
          };
        }
        yield {
          type: 'result' as const,
          subtype: 'success' as const,
          stop_reason: 'end_turn',
          ...(opts.resultText !== undefined ? { result: opts.resultText } : {}),
          usage: { input_tokens: 2, output_tokens: 1562 },
        };
      })() as unknown
  );
}

async function consume(
  client: ClaudeAgentClient,
  messages: Message<unknown>[],
  apiDef: APIDefinition,
  options: Record<string, unknown> = {}
) {
  const ac = new AbortController();
  const gen = client.sendMessageStream(messages, 'claude-haiku-4-5', apiDef, {
    signal: ac.signal,
    ...options,
  } as Parameters<ClaudeAgentClient['sendMessageStream']>[3]);
  const chunks: StreamChunk[] = [];
  let result: unknown;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    chunks.push(next.value);
  }
  return { chunks, result };
}

describe('ClaudeAgentClient', () => {
  it('emits content + thinking chunks and surfaces session ID via providerExtra', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ thinking: 'reasoning…', text: 'hi' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp/sessions',
      generateSessionId: () => 'fixed-uuid',
    });

    const { chunks, result } = await consume(client, [userMessage('hello')], makeApiDef());

    const types = chunks.map(c => c.type);
    expect(types).toContain('thinking.start');
    expect(types).toContain('thinking');
    expect(types).toContain('thinking.end');
    expect(types).toContain('content.start');
    expect(types).toContain('content');
    expect(types).toContain('content.end');
    expect(types).toContain('token_usage');

    const r = result as {
      textContent: string;
      thinkingContent: string;
      providerExtra?: Record<string, unknown>;
    };
    expect(r.textContent).toBe('hi');
    expect(r.thinkingContent).toBe('reasoning…');
    expect(r.providerExtra?.claudeAgentSessionId).toBe('fixed-uuid');
    expect(r.providerExtra?.claudeAgentMessageUuid).toBe('asst-uuid-1');
  });

  it('first turn passes sessionId; resume turn passes resume + resumeSessionAt', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'x' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'new-uuid',
    });

    await consume(client, [userMessage('first')], makeApiDef());
    expect((optsSink.value as Record<string, unknown>).sessionId).toBe('new-uuid');
    expect((optsSink.value as Record<string, unknown>).resume).toBeUndefined();

    optsSink.value = undefined;
    await consume(client, [userMessage('second')], makeApiDef(), {
      claudeAgentSessionId: 'persisted-uuid',
      claudeAgentResumeAt: 'asst-uuid-prev',
    });
    expect((optsSink.value as Record<string, unknown>).resume).toBe('persisted-uuid');
    expect((optsSink.value as Record<string, unknown>).resumeSessionAt).toBe('asst-uuid-prev');
    expect((optsSink.value as Record<string, unknown>).sessionId).toBeUndefined();
  });

  it('maps reasoning controls onto SDK thinking / effort options', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    await consume(client, [userMessage('hey')], makeApiDef(), {
      enableReasoning: true,
      reasoningBudgetTokens: 4000,
      reasoningEffort: 'high',
    });
    const opts = optsSink.value as Record<string, unknown>;
    expect(opts.thinking).toEqual({ type: 'enabled', budgetTokens: 4000 });
    expect(opts.effort).toBe('high');

    optsSink.value = undefined;
    await consume(client, [userMessage('hey')], makeApiDef(), { enableReasoning: false });
    expect((optsSink.value as Record<string, unknown>).thinking).toEqual({ type: 'disabled' });

    optsSink.value = undefined;
    await consume(client, [userMessage('hey')], makeApiDef());
    expect((optsSink.value as Record<string, unknown>).thinking).toBeUndefined();
    expect((optsSink.value as Record<string, unknown>).effort).toBeUndefined();

    // Adaptive: enableReasoning=true + budget=0 → omit `thinking` so the SDK's
    // adaptive default applies (required for Opus 4.7+ which only does adaptive).
    optsSink.value = undefined;
    await consume(client, [userMessage('hey')], makeApiDef(), {
      enableReasoning: true,
      reasoningBudgetTokens: 0,
      reasoningEffort: 'high',
    });
    expect((optsSink.value as Record<string, unknown>).thinking).toBeUndefined();
    expect((optsSink.value as Record<string, unknown>).effort).toBe('high');
  });

  it('routes OAuth tokens via CLAUDE_CODE_OAUTH_TOKEN, API keys via ANTHROPIC_API_KEY', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    await consume(client, [userMessage('hey')], makeApiDef({ apiKey: 'sk-ant-oat01-abc' }));
    let env = (optsSink.value as { env: Record<string, string> }).env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-abc');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();

    optsSink.value = undefined;
    await consume(client, [userMessage('hey')], makeApiDef({ apiKey: 'sk-ant-api03-xyz' }));
    env = (optsSink.value as { env: Record<string, string> }).env;
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-xyz');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    optsSink.value = undefined;
    await consume(client, [userMessage('hey')], makeApiDef({ apiKey: '' }));
    env = (optsSink.value as { env: Record<string, string> }).env;
    // Empty key → host CLI credentials path; neither env var should be set
    // unless the host had them already.
    if (!process.env.ANTHROPIC_API_KEY) expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('discoverModels returns the hard-coded model set', async () => {
    const client = new ClaudeAgentClient(makeDeps(), {
      query: vi.fn() as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const models = await client.discoverModels(makeApiDef());
    expect(models.map(m => m.id).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
    ]);
  });

  it('throws when no user message is present', async () => {
    const client = new ClaudeAgentClient(makeDeps(), {
      query: vi.fn() as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const ac = new AbortController();
    const gen = client.sendMessageStream([], 'claude-haiku-4-5', makeApiDef(), {
      signal: ac.signal,
    } as Parameters<ClaudeAgentClient['sendMessageStream']>[3]);
    await expect(gen.next()).rejects.toThrow(/no user message/);
  });

  it('bridges enabled tools into mcpServers + allowedTools, keeping built-ins off', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const registry = new ClientSideToolRegistry();
    const fsLike: ClientSideTool = {
      name: 'filesystem',
      claudeAgentBridgeable: true,
      description: 'fs',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ content: '' }),
    };
    registry.registerAll([fsLike]);
    const toolContext = { toolRegistry: registry } as unknown as ToolContext;

    await consume(client, [userMessage('hey')], makeApiDef(), {
      toolContext,
      enabledTools: ['filesystem'],
      toolOptions: {},
    });

    const opts = optsSink.value as Record<string, unknown>;
    expect(Object.keys(opts.mcpServers as object)).toEqual(['gremlin']);
    expect(opts.allowedTools).toEqual(['mcp__gremlin__filesystem']);
    // Built-in CLI tools (host fs / Bash) must stay disabled.
    expect(opts.tools).toEqual([]);
  });

  it('omits mcpServers when no tool context is provided (back-compat)', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    await consume(client, [userMessage('hey')], makeApiDef());

    const opts = optsSink.value as Record<string, unknown>;
    expect(opts.mcpServers).toEqual({});
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.tools).toEqual([]);
  });

  it('merges tool_use/tool_result from the MCP handler into the stream', async () => {
    const registry = new ClientSideToolRegistry();
    const echoTool: ClientSideTool = {
      name: 'echo',
      claudeAgentBridgeable: true,
      description: 'echo',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      execute: async input => ({ content: `echo:${String(input.message)}` }),
    };
    registry.registerAll([echoTool]);
    const toolContext = { toolRegistry: registry } as unknown as ToolContext;

    // Fake query that, like the real SDK, invokes the in-process MCP server
    // mid-turn. The handler pushes tool_use/tool_result onto the client's side
    // channel, which the merge loop must interleave into its StreamChunk output.
    const fakeQuery = vi.fn((params: { prompt: unknown; options?: unknown }) => {
      const instance = (
        params.options as {
          mcpServers: {
            gremlin: { instance: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer };
          };
        }
      ).mcpServers.gremlin.instance;
      return (async function* () {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await instance.connect(serverTransport);
        const sdkSim = new Client({ name: 'sdk-sim', version: '1.0.0' });
        await sdkSim.connect(clientTransport);

        yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
        yield {
          type: 'assistant' as const,
          uuid: 'a1',
          session_id: 's',
          message: { content: [{ type: 'text', text: 'before' }] },
        };
        await sdkSim.callTool({ name: 'echo', arguments: { message: 'hi' } });
        yield {
          type: 'assistant' as const,
          uuid: 'a2',
          session_id: 's',
          message: { content: [{ type: 'text', text: 'after' }] },
        };
        yield {
          type: 'result' as const,
          subtype: 'success' as const,
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })() as unknown;
    });

    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { chunks } = await consume(client, [userMessage('go')], makeApiDef(), {
      toolContext,
      enabledTools: ['echo'],
      toolOptions: {},
    });

    const types = chunks.map(c => c.type);
    expect(types).toContain('tool_use');
    expect(types).toContain('tool_result');
    expect(types.indexOf('tool_use')).toBeLessThan(types.indexOf('tool_result'));

    const toolResult = chunks.find(c => c.type === 'tool_result') as Extract<
      StreamChunk,
      { type: 'tool_result' }
    >;
    expect(toolResult.name).toBe('echo');
    expect(toolResult.content).toBe('echo:hi');
  });

  it('delivers toolContext + enabledTools through APIService to the SDK options', async () => {
    // End-to-end of the wiring the agentic loop relies on: APIService must
    // forward `toolContext`/`enabledTools` verbatim so the client can bridge.
    const registry = new ClientSideToolRegistry();
    const fsLike: ClientSideTool = {
      name: 'filesystem',
      claudeAgentBridgeable: true,
      description: 'fs',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ content: '' }),
    };
    registry.registerAll([fsLike]);
    const deps = {
      storage: {} as APIServiceDeps['storage'],
      toolRegistry: registry,
      encryption: {} as APIServiceDeps['encryption'],
    };

    const optsSink: { value?: unknown } = {};
    const apiService = new APIService(deps);
    apiService.setClient(
      'claude-agent',
      new ClaudeAgentClient(deps, {
        query: makeFakeQuery({ text: 'ok' }, optsSink) as never,
        sessionDir: () => '/tmp',
        generateSessionId: () => 'u',
      })
    );

    const toolContext = { toolRegistry: registry } as unknown as ToolContext;
    const ac = new AbortController();
    const gen = apiService.sendMessageStream(
      [userMessage('hey')],
      'claude-haiku-4-5',
      makeApiDef(),
      {
        signal: ac.signal,
        maxTokens: 100,
        enableReasoning: false,
        reasoningBudgetTokens: 0,
        enabledTools: ['filesystem'],
        toolOptions: {},
        toolContext,
      }
    );
    while (!(await gen.next()).done) {
      /* drain */
    }

    const opts = optsSink.value as Record<string, unknown>;
    expect(Object.keys(opts.mcpServers as object)).toEqual(['gremlin']);
    expect(opts.allowedTools).toEqual(['mcp__gremlin__filesystem']);
  });

  it('enables built-in WebSearch/WebFetch when webSearchEnabled (no bridge)', async () => {
    const optsSink: { value?: unknown } = {};
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFakeQuery({ text: 'ok' }, optsSink) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    await consume(client, [userMessage('hey')], makeApiDef(), { webSearchEnabled: true });

    const opts = optsSink.value as Record<string, unknown>;
    expect(opts.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(opts.allowedTools).toEqual(['WebSearch', 'WebFetch']);
    expect(opts.mcpServers).toEqual({});
  });

  it('leaves built-ins off when webSearchEnabled is false (back-compat)', async () => {
    const optsSink: { value?: unknown } = {};
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFakeQuery({ text: 'ok' }, optsSink) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    await consume(client, [userMessage('hey')], makeApiDef(), { webSearchEnabled: false });

    const opts = optsSink.value as Record<string, unknown>;
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toBeUndefined();
  });

  it('combines bridged tools and built-in web tools in allowedTools', async () => {
    const optsSink: { value?: unknown } = {};
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFakeQuery({ text: 'ok' }, optsSink) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const registry = new ClientSideToolRegistry();
    const fsLike: ClientSideTool = {
      name: 'filesystem',
      claudeAgentBridgeable: true,
      description: 'fs',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ content: '' }),
    };
    registry.registerAll([fsLike]);
    const toolContext = { toolRegistry: registry } as unknown as ToolContext;

    await consume(client, [userMessage('hey')], makeApiDef(), {
      toolContext,
      enabledTools: ['filesystem'],
      toolOptions: {},
      webSearchEnabled: true,
    });

    const opts = optsSink.value as Record<string, unknown>;
    expect(Object.keys(opts.mcpServers as object)).toEqual(['gremlin']);
    expect(opts.allowedTools).toEqual(['mcp__gremlin__filesystem', 'WebSearch', 'WebFetch']);
    expect(opts.tools).toEqual(['WebSearch', 'WebFetch']);
  });

  it('renders built-in web search/fetch blocks as web_search.*/web_fetch.* chunks', async () => {
    // Server-side web tools surface in the assistant message as server_tool_use
    // + web_*_tool_result blocks (the Anthropic Beta content shapes). We map them
    // onto the shared chunks so they render like every other provider's search.
    const fakeQuery = vi.fn(
      () =>
        (async function* () {
          yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
          yield {
            type: 'assistant' as const,
            uuid: 'a1',
            session_id: 's',
            message: {
              content: [
                {
                  type: 'server_tool_use',
                  id: 'srv1',
                  name: 'web_search',
                  input: { query: 'cats' },
                },
                {
                  type: 'web_search_tool_result',
                  tool_use_id: 'srv1',
                  content: [
                    {
                      type: 'web_search_result',
                      title: 'Cats',
                      url: 'https://cats.example',
                      encrypted_content: 'x',
                      page_age: null,
                    },
                  ],
                },
                {
                  type: 'server_tool_use',
                  id: 'srv2',
                  name: 'web_fetch',
                  input: { url: 'https://cats.example' },
                },
                {
                  type: 'web_fetch_tool_result',
                  tool_use_id: 'srv2',
                  content: {
                    type: 'web_fetch_result',
                    url: 'https://cats.example',
                    retrieved_at: null,
                  },
                },
                { type: 'text', text: 'Cats are great.' },
              ],
            },
          };
          yield {
            type: 'result' as const,
            subtype: 'success' as const,
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              server_tool_use: { web_search_requests: 1 },
            },
          };
        })() as unknown
    );

    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { chunks, result } = await consume(client, [userMessage('find cats')], makeApiDef(), {
      webSearchEnabled: true,
    });

    const types = chunks.map(c => c.type);
    expect(types).toContain('web_search.start');
    expect(types).toContain('web_fetch.start');

    const search = chunks.find(c => c.type === 'web_search') as Extract<
      StreamChunk,
      { type: 'web_search' }
    >;
    expect(search.query).toBe('cats');
    const searchResult = chunks.find(c => c.type === 'web_search.result') as Extract<
      StreamChunk,
      { type: 'web_search.result' }
    >;
    expect(searchResult).toMatchObject({
      tool_use_id: 'srv1',
      title: 'Cats',
      url: 'https://cats.example',
    });
    const fetch = chunks.find(c => c.type === 'web_fetch') as Extract<
      StreamChunk,
      { type: 'web_fetch' }
    >;
    expect(fetch.url).toBe('https://cats.example');
    const fetchResult = chunks.find(c => c.type === 'web_fetch.result') as Extract<
      StreamChunk,
      { type: 'web_fetch.result' }
    >;
    expect(fetchResult).toMatchObject({ tool_use_id: 'srv2', url: 'https://cats.example' });

    const r = result as { textContent: string; webSearchCount?: number };
    expect(r.textContent).toBe('Cats are great.');
    expect(r.webSearchCount).toBe(1);
  });

  it('surfaces an empty turn with a hard assistant error as result.error + logs detail', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFailingTurnQuery({
        assistantError: 'max_output_tokens',
        rateLimitStatus: 'rejected',
        // Omitted thinking: tokens spent, content redacted (signature-only).
        thinking: { thinking: '', signature: 'sig-abc' },
      }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as {
      error?: { message: string };
      providerExtra?: Record<string, unknown>;
    };
    // Assistant error takes precedence over the rate-limit message.
    expect(r.error?.message).toMatch(/max_output_tokens/);
    expect(r.providerExtra?.rateLimitStatus).toBe('rejected');

    const logged = debugSpy.mock.calls.map(c => String(c[0]));
    expect(logged.some(l => l.includes('rate_limit status='))).toBe(true);
    expect(logged.some(l => l.includes('assistant error='))).toBe(true);
    debugSpy.mockRestore();
  });

  it('surfaces a rejected quota with no assistant error as a turn-rejected error', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFailingTurnQuery({
        rateLimitStatus: 'rejected',
        thinking: { thinking: '', signature: 'sig-abc' },
      }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { error?: { message: string } };
    expect(r.error?.message).toMatch(/rate_limit_status=rejected/);
    debugSpy.mockRestore();
  });

  it('surfaces an empty turn whose assistant stop_reason is pause_turn as an error', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFailingTurnQuery({
        rateLimitStatus: 'allowed',
        messageStopReason: 'pause_turn',
        thinking: { thinking: '', signature: 'sig-abc' },
      }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { error?: { message: string } };
    expect(r.error?.message).toMatch(/stop_reason=pause_turn/);

    const logged = debugSpy.mock.calls.map(c => String(c[0]));
    expect(logged.some(l => l.includes('assistant stop_reason='))).toBe(true);
    debugSpy.mockRestore();
  });

  it('surfaces a thinking-only turn (omitted thinking, no text, no signal) as an error', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFailingTurnQuery({
        // Exactly the observed shape: omitted thinking, allowed quota, no
        // assistant error, no message stop_reason, no result text.
        rateLimitStatus: 'allowed',
        thinking: { thinking: '', signature: 'sig-abc' },
      }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { error?: { message: string } };
    expect(r.error?.message).toMatch(/only thinking and no output/);
    debugSpy.mockRestore();
  });

  it('adopts result.result as text when the assistant message had no text block', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFailingTurnQuery({
        rateLimitStatus: 'allowed',
        thinking: { thinking: '', signature: 'sig-abc' },
        resultText: 'recovered answer',
      }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { chunks, result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { error?: { message: string }; textContent: string };
    expect(r.textContent).toBe('recovered answer');
    // No error: the fallback filled in text, so the turn isn't "empty".
    expect(r.error).toBeUndefined();
    // The adopted text is streamed as content chunks too.
    const content = chunks.find(c => c.type === 'content') as Extract<
      StreamChunk,
      { type: 'content' }
    >;
    expect(content.content).toBe('recovered answer');
    debugSpy.mockRestore();
  });

  it('leaves a normal turn carrying a benign rate-limit event untouched', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFailingTurnQuery({
        rateLimitStatus: 'allowed_warning',
        text: 'here is your answer',
      }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as {
      error?: { message: string };
      textContent: string;
      providerExtra?: Record<string, unknown>;
    };
    expect(r.error).toBeUndefined();
    expect(r.textContent).toBe('here is your answer');
    expect(r.providerExtra?.rateLimitStatus).toBe('allowed_warning');
    debugSpy.mockRestore();
  });

  // --- includePartialMessages live-streaming -------------------------------

  /** Wrap a raw BetaRawMessageStreamEvent as an SDKPartialAssistantMessage. */
  function streamEv(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return { type: 'stream_event' as const, uuid: 'p1', session_id: 's', ...extra, event };
  }

  /**
   * Scripts a turn that streams token-by-token via `stream_event`s (the
   * includePartialMessages shape) followed by the coalesced `assistant` + `result`
   * messages. The coalesced text defaults to the joined deltas so a covered
   * message is suppressed without losing content.
   */
  function makeStreamingTurnQuery(opts: {
    textDeltas?: string[];
    thinkingDeltas?: string[];
    partialStopReason?: string;
    stopDetails?: { type: 'refusal'; category?: string | null; explanation?: string | null };
    coalescedText?: string;
    coalescedContent?: unknown[];
    omitCoalesced?: boolean;
    resultText?: string;
    ttftMs?: number;
  }) {
    return vi.fn(
      () =>
        (async function* () {
          yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
          yield streamEv({ type: 'message_start', message: {} }, { ttft_ms: opts.ttftMs });
          if (opts.thinkingDeltas) {
            yield streamEv({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '' },
            });
            for (const t of opts.thinkingDeltas)
              yield streamEv({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: t },
              });
            yield streamEv({ type: 'content_block_stop', index: 0 });
          }
          if (opts.textDeltas) {
            yield streamEv({
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'text', text: '' },
            });
            for (const t of opts.textDeltas)
              yield streamEv({
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'text_delta', text: t },
              });
            yield streamEv({ type: 'content_block_stop', index: 1 });
          }
          yield streamEv({
            type: 'message_delta',
            delta: {
              stop_reason: opts.partialStopReason ?? 'end_turn',
              stop_details: opts.stopDetails ?? null,
              stop_sequence: null,
              container: null,
            },
            usage: { output_tokens: 5 },
            context_management: null,
          });
          yield streamEv({ type: 'message_stop' });
          if (!opts.omitCoalesced) {
            const joinedText = opts.coalescedText ?? opts.textDeltas?.join('') ?? '';
            const content = opts.coalescedContent ?? [
              ...(opts.thinkingDeltas
                ? [{ type: 'thinking', thinking: opts.thinkingDeltas.join('') }]
                : []),
              ...(joinedText ? [{ type: 'text', text: joinedText }] : []),
            ];
            yield {
              type: 'assistant' as const,
              uuid: 'a1',
              session_id: 's',
              message: {
                content,
                ...(opts.partialStopReason ? { stop_reason: opts.partialStopReason } : {}),
                ...(opts.stopDetails ? { stop_details: opts.stopDetails } : {}),
              },
            };
          }
          yield {
            type: 'result' as const,
            subtype: 'success' as const,
            stop_reason: 'end_turn',
            ...(opts.resultText !== undefined ? { result: opts.resultText } : {}),
            usage: { input_tokens: 2, output_tokens: 5 },
          };
        })() as unknown
    );
  }

  function makeStreamingClient(query: ReturnType<typeof vi.fn>) {
    return new ClaudeAgentClient(makeDeps(), {
      query: query as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
  }

  it('streams text token-by-token from partial messages (one start/end, many deltas)', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = makeStreamingClient(
      makeStreamingTurnQuery({ textDeltas: ['Hel', 'lo', ' wo', 'rld'], ttftMs: 42 })
    );
    const { chunks, result } = await consume(client, [userMessage('hi')], makeApiDef());
    const types = chunks.map(c => c.type);
    expect(types.filter(t => t === 'content.start')).toHaveLength(1);
    expect(types.filter(t => t === 'content.end')).toHaveLength(1);
    // One content chunk per delta — the coalesced message must NOT add a 5th.
    expect(types.filter(t => t === 'content')).toHaveLength(4);
    expect((result as { textContent: string }).textContent).toBe('Hello world');
    debugSpy.mockRestore();
  });

  it('does not double-render: assembler yields one text block equal to textContent', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = makeStreamingClient(
      makeStreamingTurnQuery({ textDeltas: ['foo ', 'bar ', 'baz'] })
    );
    const { chunks, result } = await consume(client, [userMessage('hi')], makeApiDef());
    const assembler = new StreamingContentAssembler();
    for (const c of chunks) assembler.pushChunk(c);
    const textBlocks = assembler
      .finalize()
      .flatMap(g => g.blocks)
      .filter(b => b.type === 'text') as { type: 'text'; text: string }[];
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).toBe((result as { textContent: string }).textContent);
    expect(textBlocks[0].text).toBe('foo bar baz');
    debugSpy.mockRestore();
  });

  it('degradation (no partials): each per-block assistant message is emitted', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // Older CLI / includePartialMessages not honored: no stream_events at all,
    // just one coalesced `assistant` per finished block. Each must render the old
    // way (partialsActive stays false).
    const query = vi.fn(
      () =>
        (async function* () {
          yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
          yield {
            type: 'assistant' as const,
            uuid: 'a1',
            session_id: 's',
            message: { content: [{ type: 'text', text: 'one' }] },
          };
          yield {
            type: 'assistant' as const,
            uuid: 'a2',
            session_id: 's',
            message: { content: [{ type: 'text', text: 'two' }] },
          };
          yield {
            type: 'result' as const,
            subtype: 'success' as const,
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 2 },
          };
        })() as unknown
    );
    const { chunks, result } = await consume(
      makeStreamingClient(query),
      [userMessage('hi')],
      makeApiDef()
    );
    const contents = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'content' }> => c.type === 'content')
      .map(c => c.content);
    expect(contents).toEqual(['one', 'two']);
    expect((result as { textContent: string }).textContent).toBe('onetwo');
    debugSpy.mockRestore();
  });

  it('filters tool_use chunks from partial messages (the MCP side-channel owns them)', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = makeStreamingClient(
      vi.fn(
        () =>
          (async function* () {
            yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
            yield streamEv({ type: 'message_start', message: {} });
            yield streamEv({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });
            yield streamEv({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'calling' },
            });
            yield streamEv({ type: 'content_block_stop', index: 0 });
            // A bridged tool call appears as a tool_use block in the partial stream.
            yield streamEv({
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 't1', name: 'mcp__gremlin__echo', input: {} },
            });
            yield streamEv({
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"message":"hi"}' },
            });
            yield streamEv({ type: 'content_block_stop', index: 1 });
            yield streamEv({ type: 'message_stop' });
            yield {
              type: 'assistant' as const,
              uuid: 'a1',
              session_id: 's',
              message: {
                content: [
                  { type: 'text', text: 'calling' },
                  {
                    type: 'tool_use',
                    id: 't1',
                    name: 'mcp__gremlin__echo',
                    input: { message: 'hi' },
                  },
                ],
              },
            };
            yield {
              type: 'result' as const,
              subtype: 'success' as const,
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })() as unknown
      )
    );
    const { chunks } = await consume(client, [userMessage('go')], makeApiDef());
    expect(chunks.some(c => c.type === 'tool_use')).toBe(false);
    expect(chunks.filter(c => c.type === 'content')).toHaveLength(1);
    debugSpy.mockRestore();
  });

  it('emits web search start/query from partials and results once from the coalesced message', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = makeStreamingClient(
      vi.fn(
        () =>
          (async function* () {
            yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
            yield streamEv({ type: 'message_start', message: {} });
            yield streamEv({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: {} },
            });
            yield streamEv({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"query":"cats"}' },
            });
            yield streamEv({ type: 'content_block_stop', index: 0 });
            yield streamEv({ type: 'message_stop' });
            yield {
              type: 'assistant' as const,
              uuid: 'a1',
              session_id: 's',
              message: {
                content: [
                  {
                    type: 'server_tool_use',
                    id: 'srv1',
                    name: 'web_search',
                    input: { query: 'cats' },
                  },
                  {
                    type: 'web_search_tool_result',
                    tool_use_id: 'srv1',
                    content: [
                      { type: 'web_search_result', title: 'Cats', url: 'https://cats.example' },
                    ],
                  },
                ],
              },
            };
            yield {
              type: 'result' as const,
              subtype: 'success' as const,
              stop_reason: 'end_turn',
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                server_tool_use: { web_search_requests: 1 },
              },
            };
          })() as unknown
      )
    );
    const { chunks } = await consume(client, [userMessage('cats?')], makeApiDef());
    const types = chunks.map(c => c.type);
    expect(types.filter(t => t === 'web_search.start')).toHaveLength(1);
    expect(types.filter(t => t === 'web_search')).toHaveLength(1);
    expect(types.filter(t => t === 'web_search.result')).toHaveLength(1);
    const query = chunks.find(c => c.type === 'web_search') as Extract<
      StreamChunk,
      { type: 'web_search' }
    >;
    expect(query.query).toBe('cats');
    debugSpy.mockRestore();
  });

  it('surfaces a refusal (with stop_details) as an error, even with no text', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = makeStreamingClient(
      makeStreamingTurnQuery({
        partialStopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'cyber', explanation: 'cannot help with that' },
        coalescedContent: [],
      })
    );
    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { error?: { message: string } };
    expect(r.error?.message).toMatch(/refused — cannot help with that/);
    expect(r.error?.message).toMatch(/cyber/);
    debugSpy.mockRestore();
  });

  it('errors on a refusal that streamed partial text, preserving the text', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = makeStreamingClient(
      makeStreamingTurnQuery({
        textDeltas: ['par', 'tial'],
        partialStopReason: 'refusal',
        stopDetails: { type: 'refusal', category: null, explanation: 'policy' },
      })
    );
    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { error?: { message: string }; textContent: string };
    expect(r.error?.message).toMatch(/refused — policy/);
    expect(r.textContent).toBe('partial');
    debugSpy.mockRestore();
  });

  it('recovers partial streamed text when the coalesced message is empty (cut-off)', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = makeStreamingClient(
      makeStreamingTurnQuery({ textDeltas: ['recov', 'ered'], coalescedContent: [] })
    );
    const { chunks, result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { error?: unknown; textContent: string };
    expect(r.textContent).toBe('recovered');
    expect(r.error).toBeUndefined();
    // Rendered exactly once (no re-emit of resultText over the streamed deltas).
    expect(chunks.filter(c => c.type === 'content.start')).toHaveLength(1);
    debugSpy.mockRestore();
  });

  it('keeps mapper state clean across two partial message cycles in one turn', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const cycle = (text: string, uuid: string) => [
      streamEv({ type: 'message_start', message: {} }),
      streamEv({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      streamEv({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }),
      streamEv({ type: 'content_block_stop', index: 0 }),
      streamEv({ type: 'message_stop' }),
      {
        type: 'assistant' as const,
        uuid,
        session_id: 's',
        message: { content: [{ type: 'text', text }] },
      },
    ];
    const client = makeStreamingClient(
      vi.fn(
        () =>
          (async function* () {
            yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
            for (const m of cycle('one', 'a1')) yield m;
            for (const m of cycle('two', 'a2')) yield m;
            yield {
              type: 'result' as const,
              subtype: 'success' as const,
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 2 },
            };
          })() as unknown
      )
    );
    const { chunks, result } = await consume(client, [userMessage('hi')], makeApiDef());
    expect((result as { textContent: string }).textContent).toBe('onetwo');
    expect(chunks.filter(c => c.type === 'content.start')).toHaveLength(2);
    debugSpy.mockRestore();
  });

  it('enables includePartialMessages in the SDK options', async () => {
    const optsSink: { value?: unknown } = {};
    const query = vi.fn((params: { prompt: unknown; options?: unknown }) => {
      optsSink.value = params.options;
      return (async function* () {
        yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
        yield {
          type: 'result' as const,
          subtype: 'success' as const,
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })() as unknown;
    });
    await consume(
      makeStreamingClient(query as unknown as ReturnType<typeof vi.fn>),
      [userMessage('hi')],
      makeApiDef()
    );
    expect((optsSink.value as Record<string, unknown>).includePartialMessages).toBe(true);
  });

  // --- per-block assistant reconciliation (the real includePartialMessages shape) ---

  /**
   * Scripts the shape the real CLI emits with includePartialMessages: each model
   * turn is one message_start/message_stop pair wrapping the token deltas, PLUS a
   * separate coalesced `assistant` message per finished content block, interleaved
   * with that block's partial deltas. `messages` is a list of Beta messages, each
   * a list of blocks; every block is BOTH partial-streamed AND echoed by its own
   * `assistant` message — so the client must render each exactly once.
   */
  function makePerBlockQuery(opts: {
    messages: Array<Array<{ kind: 'thinking' | 'text'; deltas: string[] }>>;
    resultText?: string;
  }) {
    return vi.fn(
      () =>
        (async function* () {
          let uuidN = 0;
          yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
          for (const blocks of opts.messages) {
            yield streamEv({ type: 'message_start', message: {} });
            let index = 0;
            for (const b of blocks) {
              const joined = b.deltas.join('');
              yield streamEv({
                type: 'content_block_start',
                index,
                content_block:
                  b.kind === 'thinking'
                    ? { type: 'thinking', thinking: '' }
                    : { type: 'text', text: '' },
              });
              for (const d of b.deltas)
                yield streamEv({
                  type: 'content_block_delta',
                  index,
                  delta:
                    b.kind === 'thinking'
                      ? { type: 'thinking_delta', thinking: d }
                      : { type: 'text_delta', text: d },
                });
              // The per-block coalesced `assistant` arrives mid-block (as observed
              // in real traces: right after content_block_start, before _stop).
              yield {
                type: 'assistant' as const,
                uuid: `a${uuidN++}`,
                session_id: 's',
                message: {
                  content: [
                    b.kind === 'thinking'
                      ? { type: 'thinking', thinking: joined }
                      : { type: 'text', text: joined },
                  ],
                },
              };
              yield streamEv({ type: 'content_block_stop', index });
              index += 1;
            }
            yield streamEv({
              type: 'message_delta',
              delta: {
                stop_reason: 'end_turn',
                stop_details: null,
                stop_sequence: null,
                container: null,
              },
              usage: { output_tokens: 5 },
              context_management: null,
            });
            yield streamEv({ type: 'message_stop' });
          }
          yield {
            type: 'result' as const,
            subtype: 'success' as const,
            stop_reason: 'end_turn',
            ...(opts.resultText !== undefined ? { result: opts.resultText } : {}),
            usage: { input_tokens: 2, output_tokens: 5 },
          };
        })() as unknown
    );
  }

  it('renders each per-block assistant message once (no double-render of partials)', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { chunks, result } = await consume(
      makeStreamingClient(
        makePerBlockQuery({
          messages: [
            [
              { kind: 'thinking', deltas: ['rea', 'son'] },
              { kind: 'text', deltas: ['Hel', 'lo'] },
            ],
          ],
          resultText: 'Hello',
        })
      ),
      [userMessage('hi')],
      makeApiDef()
    );
    // The per-block coalesced copies must NOT re-emit over the partials.
    expect(chunks.filter(c => c.type === 'content.start')).toHaveLength(1);
    expect(chunks.filter(c => c.type === 'content')).toHaveLength(2); // two text deltas
    const assembler = new StreamingContentAssembler();
    for (const c of chunks) assembler.pushChunk(c);
    const blocks = assembler.finalize().flatMap(g => g.blocks);
    expect(blocks.map(b => b.type)).toEqual(['thinking', 'text']);
    const text = blocks.find((b): b is { type: 'text'; text: string } => b.type === 'text');
    expect(text?.text).toBe('Hello');
    expect((result as { textContent: string }).textContent).toBe('Hello');
    debugSpy.mockRestore();
  });

  it('keeps interleaved text in separate blocks with the second thinking in the middle', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { chunks, result } = await consume(
      makeStreamingClient(
        makePerBlockQuery({
          messages: [
            [
              { kind: 'thinking', deltas: ['plan one'] },
              { kind: 'text', deltas: ['Answer one. '] },
            ],
            [
              { kind: 'thinking', deltas: ['plan two'] },
              { kind: 'text', deltas: ['Answer two.'] },
            ],
          ],
          resultText: 'Answer one. Answer two.',
        })
      ),
      [userMessage('hi')],
      makeApiDef()
    );
    const assembler = new StreamingContentAssembler();
    for (const c of chunks) assembler.pushChunk(c);
    const blocks = assembler.finalize().flatMap(g => g.blocks);
    // think₁ → text₁ → think₂ → text₂: two separate text blocks, the second
    // thinking between them — NOT both answers merged into one trailing block.
    expect(blocks.map(b => b.type)).toEqual(['thinking', 'text', 'thinking', 'text']);
    const texts = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text);
    expect(texts).toEqual(['Answer one. ', 'Answer two.']);
    expect((result as { textContent: string }).textContent).toBe('Answer one. Answer two.');
    expect((result as { error?: unknown }).error).toBeUndefined();
    debugSpy.mockRestore();
  });

  it('still adopts the result string when no text block exists (thinking-only turn)', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { chunks, result } = await consume(
      makeStreamingClient(
        makeStreamingTurnQuery({ thinkingDeltas: ['think'], resultText: 'final answer' })
      ),
      [userMessage('hi')],
      makeApiDef()
    );
    const r = result as { textContent: string; error?: unknown };
    expect(r.textContent).toBe('final answer');
    expect(r.error).toBeUndefined();
    expect(chunks.filter(c => c.type === 'content.start')).toHaveLength(1);
    debugSpy.mockRestore();
  });
});

describe('classifyTurnError', () => {
  // "Empty turn, no distinguishing signal" baseline; override one field per case.
  const base: TurnOutcomeSignals = {
    textLength: 0,
    thinkingLength: 0,
    sawThinkingBlock: false,
    sawToolUse: false,
    stopReason: undefined,
    assistantStopReason: undefined,
    assistantError: undefined,
    rateLimitStatus: undefined,
    refusalExplanation: undefined,
    refusalCategory: undefined,
    outputTokens: 0,
  };

  it('is undefined for a turn that produced text', () => {
    expect(classifyTurnError({ ...base, textLength: 12 })).toBeUndefined();
  });

  it('is undefined for a turn that produced real thinking content', () => {
    expect(
      classifyTurnError({ ...base, thinkingLength: 50, sawThinkingBlock: true })
    ).toBeUndefined();
  });

  it('surfaces a refusal even when partial text streamed first', () => {
    const err = classifyTurnError({
      ...base,
      textLength: 30,
      assistantStopReason: 'refusal',
      refusalExplanation: 'no',
      refusalCategory: 'cyber',
    });
    expect(err?.message).toBe('claude-agent: refused — no (category: cyber)');
  });

  it('surfaces a hard assistant error on an empty turn', () => {
    expect(classifyTurnError({ ...base, assistantError: 'rate_limit' })?.message).toBe(
      'claude-agent: rate_limit'
    );
  });

  it('surfaces a bad stop_reason (pause_turn) on an empty turn', () => {
    expect(classifyTurnError({ ...base, assistantStopReason: 'pause_turn' })?.message).toBe(
      'claude-agent: turn ended with stop_reason=pause_turn and no output'
    );
  });

  it('surfaces a rejected subscription quota on an empty turn', () => {
    expect(classifyTurnError({ ...base, rateLimitStatus: 'rejected' })?.message).toBe(
      'claude-agent: turn rejected (rate_limit_status=rejected)'
    );
  });

  it('surfaces a thinking-only malfunction (omitted thinking, no text, no tool)', () => {
    const err = classifyTurnError({ ...base, sawThinkingBlock: true, outputTokens: 256 });
    expect(err?.message).toBe(
      'claude-agent: turn produced only thinking and no output (256 output tokens spent)'
    );
  });

  it('does not flag a thinking turn that called a tool (stopReason=tool_use)', () => {
    expect(
      classifyTurnError({
        ...base,
        sawThinkingBlock: true,
        sawToolUse: true,
        stopReason: 'tool_use',
      })
    ).toBeUndefined();
  });

  it('hard assistant error takes precedence over a bad stop_reason', () => {
    expect(
      classifyTurnError({
        ...base,
        assistantError: 'overloaded',
        assistantStopReason: 'max_tokens',
      })?.message
    ).toBe('claude-agent: overloaded');
  });
});

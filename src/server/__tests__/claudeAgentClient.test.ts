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
  describeFallback,
  bridgedToolName,
  toolInputKey,
  extractToolResponseText,
  detectTruncation,
  trimBlockJson,
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

function makeFakeQuery(
  turn: ScriptedTurn,
  optsSink: { value?: unknown } = {},
  promptSink: { value?: unknown; messages?: unknown[] } = {}
) {
  // The signature mirrors `@anthropic-ai/claude-agent-sdk`'s `query`.
  return vi.fn((params: { prompt: unknown; options?: unknown }) => {
    optsSink.value = params.options;
    promptSink.value = params.prompt;
    const iter = (async function* () {
      // Drain an AsyncIterable prompt first, the way the SDK's streamInput
      // consumes it before (or while) the CLI produces output.
      const p = params.prompt;
      if (p !== null && typeof p === 'object' && Symbol.asyncIterator in p) {
        promptSink.messages = [];
        for await (const m of p as AsyncIterable<unknown>) {
          promptSink.messages.push(m);
        }
      }
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

/**
 * Scripts a turn whose assistant message carries a `fallback` block — the SDK
 * handed the request to a different model (`{ from: { model }, to: { model } }`).
 * Optionally precedes it with a text block (the response that model produced).
 */
function makeFallbackQuery(opts: { fromModel?: string; toModel?: string; text?: string } = {}) {
  return vi.fn(
    () =>
      (async function* () {
        yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
        yield {
          type: 'assistant' as const,
          uuid: 'a1',
          session_id: 's',
          message: {
            content: [
              ...(opts.text ? [{ type: 'text', text: opts.text }] : []),
              {
                type: 'fallback',
                ...(opts.fromModel ? { from: { model: opts.fromModel } } : {}),
                ...(opts.toModel ? { to: { model: opts.toModel } } : {}),
              },
            ],
          },
        };
        yield {
          type: 'result' as const,
          subtype: 'success' as const,
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 7 },
        };
      })() as unknown
  );
}

/**
 * Scripts a turn whose assistant message mixes blocks we have no dedicated
 * renderer for (an unrecognized server_tool_use name, a brand-new block type,
 * a non-bridged tool_use) with ones we deliberately skip (a bridged
 * mcp__gremlin__* tool_use — the MCP side channel renders those).
 */
function makeUnknownBlocksQuery() {
  return vi.fn(
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
                id: 'srvtoolu_1',
                name: 'code_execution',
                input: { code: '1+1' },
              },
              {
                type: 'code_execution_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: { stdout: '2' },
              },
              { type: 'tool_use', id: 'toolu_1', name: 'mcp__gremlin__memo', input: {} },
              { type: 'tool_use', id: 'toolu_2', name: 'WebSearch', input: { query: 'best LLM' } },
              { type: 'text', text: 'done' },
            ],
          },
        };
        // Tool results ride back on a user message: one for the non-bridged
        // WebSearch (→ generic render), one for the bridged memo (→ skipped).
        yield {
          type: 'user' as const,
          uuid: 'u1',
          session_id: 's',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_2', content: 'search hits here' },
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'memo saved' },
            ],
          },
        };
        yield {
          type: 'result' as const,
          subtype: 'success' as const,
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 7 },
        };
      })() as unknown
  );
}

async function consume(
  client: ClaudeAgentClient,
  messages: Message<unknown>[],
  apiDef: APIDefinition,
  options: Record<string, unknown> = {},
  // Haiku 4.5 has no effort support — override for effort-sensitive cases.
  modelId = 'claude-haiku-4-5'
) {
  const ac = new AbortController();
  const gen = client.sendMessageStream(messages, modelId, apiDef, {
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
    // The CLI-reported `system:init` session id is authoritative (it differs
    // from the requested id on forked rewinds), so it wins over 'fixed-uuid'.
    expect(r.providerExtra?.claudeAgentSessionId).toBe('sess-1');
    expect(r.providerExtra?.claudeAgentMessageUuid).toBe('asst-uuid-1');
  });

  describe('fallback block', () => {
    it('treatFallbackAsError on: surfaces a neutral model-handoff error, no fallback chunk', async () => {
      const client = new ClaudeAgentClient(makeDeps(), {
        query: makeFallbackQuery({
          fromModel: 'claude-fable-5',
          toModel: 'claude-opus-4-8',
        }) as never,
        sessionDir: () => '/tmp',
        generateSessionId: () => 'u',
      });

      const { chunks, result } = await consume(
        client,
        [userMessage('a request')],
        makeApiDef({ advancedSettings: { treatFallbackAsError: true } })
      );

      expect(chunks.some(c => c.type === 'fallback')).toBe(false);
      const r = result as { error?: { message: string } };
      expect(r.error?.message).toBe(
        'claude-agent: request handled by claude-opus-4-8 instead of claude-fable-5'
      );
      // States the fact only — never speculates about a "risky" prompt.
      expect(r.error?.message).not.toMatch(/risky/i);
    });

    it('treatFallbackAsError off: emits a fallback chunk carrying from/to models, no error', async () => {
      const client = new ClaudeAgentClient(makeDeps(), {
        query: makeFallbackQuery({
          fromModel: 'claude-fable-5',
          toModel: 'claude-opus-4-8',
          text: 'here is the answer',
        }) as never,
        sessionDir: () => '/tmp',
        generateSessionId: () => 'u',
      });

      const { chunks, result } = await consume(client, [userMessage('a request')], makeApiDef());

      const fallback = chunks.find(c => c.type === 'fallback');
      expect(fallback).toEqual({
        type: 'fallback',
        fromModel: 'claude-fable-5',
        toModel: 'claude-opus-4-8',
      });
      const r = result as { error?: unknown; textContent: string };
      expect(r.error).toBeUndefined();
      expect(r.textContent).toBe('here is the answer');
    });
  });

  describe('unknown blocks', () => {
    it('emits unknown_block chunks for unhandled block shapes, skips bridged tool_use', async () => {
      const client = new ClaudeAgentClient(makeDeps(), {
        query: makeUnknownBlocksQuery() as never,
        sessionDir: () => '/tmp',
        generateSessionId: () => 'u',
      });

      const { chunks, result } = await consume(client, [userMessage('run code')], makeApiDef());

      const unknowns = chunks.filter(
        (c): c is Extract<StreamChunk, { type: 'unknown_block' }> => c.type === 'unknown_block'
      );
      expect(unknowns).toHaveLength(4);

      // Unrecognized server tool name — full block dumped as JSON.
      expect(unknowns[0]).toMatchObject({
        blockType: 'server_tool_use',
        name: 'code_execution',
        id: 'srvtoolu_1',
      });
      expect(JSON.parse(unknowns[0].json)).toEqual({
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'code_execution',
        input: { code: '1+1' },
      });

      // Brand-new block type — no name, still surfaced.
      expect(unknowns[1]).toMatchObject({ blockType: 'code_execution_tool_result' });
      expect(unknowns[1].name).toBeUndefined();

      // Non-bridged tool_use — surfaced; the bridged mcp__gremlin__memo is not.
      expect(unknowns[2]).toMatchObject({
        blockType: 'tool_use',
        name: 'WebSearch',
        id: 'toolu_2',
      });
      expect(unknowns.some(c => c.name === 'mcp__gremlin__memo')).toBe(false);

      // Its tool_result (from the SDK user message) — surfaced under the
      // originating tool's name; the bridged memo's result is not.
      expect(unknowns[3]).toMatchObject({
        blockType: 'tool_result',
        name: 'WebSearch',
        id: 'toolu_2',
      });
      expect(JSON.parse(unknowns[3].json)).toMatchObject({ content: 'search hits here' });
      expect(unknowns.filter(c => c.blockType === 'tool_result')).toHaveLength(1);

      const r = result as { error?: unknown; textContent: string };
      expect(r.error).toBeUndefined();
      expect(r.textContent).toBe('done');
    });
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
    // Rewound sends fork so the dead branch stays in the old session file.
    expect((optsSink.value as Record<string, unknown>).forkSession).toBe(true);
    expect((optsSink.value as Record<string, unknown>).sessionId).toBeUndefined();

    // Plain resume (no rewind): same session continued in place, no fork.
    optsSink.value = undefined;
    await consume(client, [userMessage('third')], makeApiDef(), {
      claudeAgentSessionId: 'persisted-uuid',
    });
    expect((optsSink.value as Record<string, unknown>).resume).toBe('persisted-uuid');
    expect((optsSink.value as Record<string, unknown>).resumeSessionAt).toBeUndefined();
    expect((optsSink.value as Record<string, unknown>).forkSession).toBeUndefined();
  });

  it('forwards maxTokens as the CLI output-token env cap', async () => {
    // The client copies process.env, so pin the ambient value out of the way.
    const saved = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    try {
      const optsSink: { value?: unknown } = {};
      const client = new ClaudeAgentClient(makeDeps(), {
        query: makeFakeQuery({ text: 'ok' }, optsSink) as never,
        sessionDir: () => '/tmp',
        generateSessionId: () => 'u',
      });

      await consume(client, [userMessage('hey')], makeApiDef(), { maxTokens: 9000 });
      let env = (optsSink.value as { env: Record<string, string> }).env;
      expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('9000');

      optsSink.value = undefined;
      await consume(client, [userMessage('hey')], makeApiDef(), { maxTokens: 0 });
      env = (optsSink.value as { env: Record<string, string> }).env;
      expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = saved;
    }
  });

  it('deleteProviderSession forwards to the SDK deleteSession with the session dir', async () => {
    const del = vi.fn(async () => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: vi.fn() as never,
      deleteSession: del as never,
      sessionDir: () => '/tmp/sessions',
      generateSessionId: () => 'u',
    });
    await client.deleteProviderSession('old-sess');
    expect(del).toHaveBeenCalledExactlyOnceWith('old-sess', { dir: '/tmp/sessions' });
  });

  it('deleteProviderSession swallows SDK failures (best-effort GC)', async () => {
    const del = vi.fn(async () => {
      throw new Error('No session found');
    });
    const client = new ClaudeAgentClient(makeDeps(), {
      query: vi.fn() as never,
      deleteSession: del as never,
      sessionDir: () => '/tmp/sessions',
      generateSessionId: () => 'u',
    });
    await expect(client.deleteProviderSession('gone')).resolves.toBeUndefined();
  });

  it('maps reasoning controls onto SDK thinking / effort options', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const OPUS = 'claude-opus-4-8'; // supports the full effort ladder

    await consume(
      client,
      [userMessage('hey')],
      makeApiDef(),
      { enableReasoning: true, reasoningBudgetTokens: 4000, reasoningEffort: 'high' },
      OPUS
    );
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
    await consume(
      client,
      [userMessage('hey')],
      makeApiDef(),
      { enableReasoning: true, reasoningBudgetTokens: 0, reasoningEffort: 'high' },
      OPUS
    );
    expect((optsSink.value as Record<string, unknown>).thinking).toBeUndefined();
    expect((optsSink.value as Record<string, unknown>).effort).toBe('high');
  });

  it('opts into thinking.display=summarized when a reasoning summary is selected', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const OPUS = 'claude-opus-4-8';

    // Fixed budget + summary → display rides the enabled config.
    await consume(
      client,
      [userMessage('hey')],
      makeApiDef(),
      { enableReasoning: true, reasoningBudgetTokens: 4000, reasoningSummary: 'auto' },
      OPUS
    );
    expect((optsSink.value as Record<string, unknown>).thinking).toEqual({
      type: 'enabled',
      budgetTokens: 4000,
      display: 'summarized',
    });

    // Adaptive (budget 0) + summary → the explicit adaptive form carries the
    // display opt-in (without a summary, adaptive omits `thinking` entirely —
    // covered by the mapping test above).
    optsSink.value = undefined;
    await consume(
      client,
      [userMessage('hey')],
      makeApiDef(),
      { enableReasoning: true, reasoningBudgetTokens: 0, reasoningSummary: 'detailed' },
      OPUS
    );
    expect((optsSink.value as Record<string, unknown>).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });

    // Reasoning disabled → summary changes nothing.
    optsSink.value = undefined;
    await consume(client, [userMessage('hey')], makeApiDef(), {
      enableReasoning: false,
      reasoningSummary: 'auto',
    });
    expect((optsSink.value as Record<string, unknown>).thinking).toEqual({ type: 'disabled' });

    // Reasoning not configured at all → summary alone doesn't force thinking on.
    optsSink.value = undefined;
    await consume(client, [userMessage('hey')], makeApiDef(), { reasoningSummary: 'auto' });
    expect((optsSink.value as Record<string, unknown>).thinking).toBeUndefined();
  });

  it('clamps effort to what the model accepts', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    // The SDK's EffortLevel has no 'none'/'minimal' — both clamp up to 'low'
    // rather than being passed through or dropped.
    const cases: [string, string, string][] = [
      ['claude-opus-4-8', 'minimal', 'low'],
      ['claude-opus-4-8', 'none', 'low'],
      ['claude-opus-4-8', 'xhigh', 'xhigh'],
      ['claude-opus-4-8', 'max', 'max'],
      // Sonnet 4.6 has no xhigh, so it escalates to max.
      ['claude-sonnet-4-6', 'xhigh', 'max'],
    ];

    for (const [modelId, requested, expected] of cases) {
      optsSink.value = undefined;
      await consume(
        client,
        [userMessage('hey')],
        makeApiDef(),
        { enableReasoning: true, reasoningBudgetTokens: 0, reasoningEffort: requested },
        modelId
      );
      expect((optsSink.value as Record<string, unknown>).effort, `${modelId} ${requested}`).toBe(
        expected
      );
    }
  });

  it('omits effort for a model that does not accept it', async () => {
    const optsSink: { value?: unknown } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, optsSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    // Haiku 4.5 predates the effort parameter — sending it would be rejected.
    await consume(client, [userMessage('hey')], makeApiDef(), {
      enableReasoning: true,
      reasoningBudgetTokens: 0,
      reasoningEffort: 'high',
    });
    expect((optsSink.value as Record<string, unknown>).effort).toBeUndefined();
  });

  it('appends the [1m] suffix to the SDK model id when claudeAgentExtendedContext is set', async () => {
    const optsSink: { value?: unknown } = {};
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFakeQuery({ text: 'ok' }, optsSink) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const ac = new AbortController();
    const gen = client.sendMessageStream([userMessage('hi')], 'claude-opus-4-8', makeApiDef(), {
      signal: ac.signal,
      claudeAgentExtendedContext: true,
    } as Parameters<ClaudeAgentClient['sendMessageStream']>[3]);
    while (!(await gen.next()).done) {
      /* drain */
    }

    expect((optsSink.value as Record<string, unknown>).model).toBe('claude-opus-4-8[1m]');
  });

  it('sends the bare model id when claudeAgentExtendedContext is omitted', async () => {
    const optsSink: { value?: unknown } = {};
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFakeQuery({ text: 'ok' }, optsSink) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    // consume() uses model id 'claude-haiku-4-5' and sets no extended-context flag.
    await consume(client, [userMessage('hi')], makeApiDef());
    expect((optsSink.value as Record<string, unknown>).model).toBe('claude-haiku-4-5');
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
      'claude-fable-5',
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

  it('throws when the last user message has no text, attachments, or files', async () => {
    const client = new ClaudeAgentClient(makeDeps(), {
      query: vi.fn() as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const ac = new AbortController();
    const gen = client.sendMessageStream([userMessage('')], 'claude-haiku-4-5', makeApiDef(), {
      signal: ac.signal,
    } as Parameters<ClaudeAgentClient['sendMessageStream']>[3]);
    await expect(gen.next()).rejects.toThrow(/no user content/);
  });

  it('passes a plain string prompt when the message is text-only', async () => {
    const promptSink: { value?: unknown; messages?: unknown[] } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, {}, promptSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    await consume(client, [userMessage('hello world')], makeApiDef());

    expect(promptSink.value).toBe('hello world');
    expect(promptSink.messages).toBeUndefined();
  });

  it('sends image attachments as content blocks via the streaming-input prompt', async () => {
    const promptSink: { value?: unknown; messages?: unknown[] } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, {}, promptSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const msg: Message<unknown> = {
      ...userMessage('look at these'),
      attachments: [
        { id: 'a1', type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { id: 'a2', type: 'image', mimeType: 'image/jpeg', data: 'BBBB' },
      ],
    };

    await consume(client, [msg], makeApiDef());

    expect(typeof promptSink.value).not.toBe('string');
    expect(promptSink.messages).toHaveLength(1);
    const sdkMsg = promptSink.messages![0] as {
      type: string;
      parent_tool_use_id: unknown;
      message: { role: string; content: unknown[] };
    };
    expect(sdkMsg.type).toBe('user');
    expect(sdkMsg.parent_tool_use_id).toBeNull();
    expect(sdkMsg.message.role).toBe('user');
    expect(sdkMsg.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
      { type: 'text', text: 'look at these' },
    ]);
  });

  it('accepts an attachment-only message with no text', async () => {
    const promptSink: { value?: unknown; messages?: unknown[] } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, {}, promptSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const msg: Message<unknown> = {
      ...userMessage(''),
      attachments: [{ id: 'a1', type: 'image', mimeType: 'image/webp', data: 'CCCC' }],
    };

    await consume(client, [msg], makeApiDef());

    const sdkMsg = promptSink.messages![0] as { message: { content: unknown[] } };
    expect(sdkMsg.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' } },
    ]);
  });

  it('sends separate-block injected files bracketing the text', async () => {
    const promptSink: { value?: unknown; messages?: unknown[] } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, {}, promptSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const msg = userMessage('analyze this');
    msg.content.injectedFiles = [{ path: '/a.ts', content: 'aaa' }];
    msg.content.injectedFilesAfter = [{ path: '/b.ts', content: 'bbb' }];
    msg.content.injectionMode = 'separate-block';

    await consume(client, [msg], makeApiDef());

    const sdkMsg = promptSink.messages![0] as { message: { content: unknown[] } };
    expect(sdkMsg.message.content).toEqual([
      { type: 'text', text: '=== /a.ts ===\naaa' },
      { type: 'text', text: 'analyze this' },
      { type: 'text', text: '=== /b.ts ===\nbbb' },
    ]);
  });

  it('downgrades as-file injected files to separate-block text blocks', async () => {
    const promptSink: { value?: unknown; messages?: unknown[] } = {};
    const fakeQuery = makeFakeQuery({ text: 'ok' }, {}, promptSink);
    const client = new ClaudeAgentClient(makeDeps(), {
      query: fakeQuery as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });
    const msg = userMessage('analyze this');
    msg.content.injectedFiles = [{ path: '/a.ts', content: 'aaa' }];
    msg.content.injectionMode = 'as-file';

    await consume(client, [msg], makeApiDef());

    const sdkMsg = promptSink.messages![0] as { message: { content: { type: string }[] } };
    expect(sdkMsg.message.content.map(b => b.type)).toEqual(['text', 'text']);
    expect(sdkMsg.message.content[0]).toEqual({ type: 'text', text: '=== /a.ts ===\naaa' });
  });

  it('emits document blocks for as-file once the capability table allows it', async () => {
    // The document branch is dormant behind effectiveInjectionMode's as-file
    // allowlist; force the mode through to pin the branch's output shape.
    vi.resetModules();
    vi.doMock('../../shared/services/api/fileInjectionHelper', async importOriginal => {
      const actual =
        await importOriginal<typeof import('../../shared/services/api/fileInjectionHelper')>();
      return { ...actual, effectiveInjectionMode: () => 'as-file' as const };
    });
    try {
      const { buildUserContentBlocks: build } = await import('../claudeAgentClient');
      const msg = userMessage('go');
      msg.content.injectedFiles = [
        { path: '/a.ts', content: 'aaa', preamble: 'PRE', postamble: 'POST' },
      ];
      msg.content.injectionMode = 'as-file';

      expect(build(msg)).toEqual([
        {
          type: 'document',
          source: { type: 'text', data: 'PRE\naaa\nPOST', media_type: 'text/plain' },
          title: '/a.ts',
        },
        { type: 'text', text: 'go' },
      ]);
    } finally {
      vi.doUnmock('../../shared/services/api/fileInjectionHelper');
      vi.resetModules();
    }
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

  // Shared setup for the model-delivery hook tests: an echo tool plus a fake
  // query that runs the tool, then invokes one of the SDK hooks the way the
  // real CLI would after deciding what the model actually received.
  function makeHookDrivenQuery(
    fireHook: (hooks: {
      PostToolUse: Array<{
        hooks: Array<
          (input: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>
        >;
      }>;
      PostToolUseFailure: Array<{
        hooks: Array<
          (input: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>
        >;
      }>;
    }) => Promise<void>
  ) {
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

    const fakeQuery = vi.fn((params: { prompt: unknown; options?: unknown }) => {
      const options = params.options as {
        mcpServers: {
          gremlin: { instance: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer };
        };
        hooks: Parameters<typeof fireHook>[0];
      };
      return (async function* () {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await options.mcpServers.gremlin.instance.connect(serverTransport);
        const sdkSim = new Client({ name: 'sdk-sim', version: '1.0.0' });
        await sdkSim.connect(clientTransport);

        yield { type: 'system' as const, subtype: 'init' as const, session_id: 's' };
        await sdkSim.callTool({ name: 'echo', arguments: { message: 'hi' } });
        await fireHook(options.hooks);
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
    return { client, toolContext };
  }

  const signal = () => new AbortController().signal;

  it('annotates the tool_result block when PostToolUseFailure fires', async () => {
    const { client, toolContext } = makeHookDrivenQuery(hooks =>
      hooks.PostToolUseFailure[0].hooks[0](
        {
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'mcp__gremlin__echo',
          tool_input: { message: 'hi' },
          tool_use_id: 'toolu_x',
          error: 'exceeds max token',
        },
        'toolu_x',
        { signal: signal() }
      ).then(() => undefined)
    );

    const { chunks } = await consume(client, [userMessage('go')], makeApiDef(), {
      toolContext,
      enabledTools: ['echo'],
      toolOptions: {},
    });

    const annotation = chunks.find(c => c.type === 'tool_result_annotation') as Extract<
      StreamChunk,
      { type: 'tool_result_annotation' }
    >;
    expect(annotation).toBeDefined();
    // Correlated back to the bridge's synthetic id, not the model's tool_use_id.
    expect(annotation.tool_use_id).toBe('mcp_gremlin_1');
    expect(annotation.modelDelivery).toEqual({ status: 'error', detail: 'exceeds max token' });
  });

  it('annotates the tool_result block when PostToolUse shows a shorter payload', async () => {
    const { client, toolContext } = makeHookDrivenQuery(hooks =>
      hooks.PostToolUse[0].hooks[0](
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__gremlin__echo',
          tool_input: { message: 'hi' },
          tool_use_id: 'toolu_x',
          // SDK delivered a truncated copy: 'echo' vs the full 'echo:hi'.
          tool_response: { content: [{ type: 'text', text: 'echo' }] },
        },
        'toolu_x',
        { signal: signal() }
      ).then(() => undefined)
    );

    const { chunks } = await consume(client, [userMessage('go')], makeApiDef(), {
      toolContext,
      enabledTools: ['echo'],
      toolOptions: {},
    });

    const annotation = chunks.find(c => c.type === 'tool_result_annotation') as Extract<
      StreamChunk,
      { type: 'tool_result_annotation' }
    >;
    expect(annotation).toBeDefined();
    expect(annotation.tool_use_id).toBe('mcp_gremlin_1');
    expect(annotation.modelDelivery).toEqual({
      status: 'truncated',
      detail: 'model received 4 of 7 chars',
    });
  });

  it('emits no annotation when PostToolUse matches what the bridge sent', async () => {
    const { client, toolContext } = makeHookDrivenQuery(hooks =>
      hooks.PostToolUse[0].hooks[0](
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__gremlin__echo',
          tool_input: { message: 'hi' },
          tool_use_id: 'toolu_x',
          tool_response: { content: [{ type: 'text', text: 'echo:hi' }] },
        },
        'toolu_x',
        { signal: signal() }
      ).then(() => undefined)
    );

    const { chunks } = await consume(client, [userMessage('go')], makeApiDef(), {
      toolContext,
      enabledTools: ['echo'],
      toolOptions: {},
    });

    expect(chunks.some(c => c.type === 'tool_result_annotation')).toBe(false);
  });

  it('surfaces a free-run return tool value on providerExtra', async () => {
    const registry = new ClientSideToolRegistry();
    const returnTool: ClientSideTool = {
      name: 'return',
      claudeAgentBridgeable: true,
      description: 'return a result',
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
    registry.registerAll([returnTool]);
    const toolContext = { toolRegistry: registry } as unknown as ToolContext;

    // The SDK can't be stopped by our return tool, so the turn keeps going
    // after the call (free-run); the value rides back on providerExtra.
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
        await sdkSim.callTool({ name: 'return', arguments: { result: 'the answer' } });
        yield {
          type: 'assistant' as const,
          uuid: 'a1',
          session_id: 's',
          message: { content: [{ type: 'text', text: 'wrapping up' }] },
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

    const { result } = await consume(client, [userMessage('go')], makeApiDef(), {
      toolContext,
      enabledTools: ['return'],
      toolOptions: {},
    });

    const r = result as { providerExtra?: Record<string, unknown> };
    expect(r.providerExtra?.claudeAgentReturnValue).toBe('the answer');
  });

  it('surfaces a DUMMY hook (un)register on providerExtra (last-write-wins)', async () => {
    const registry = new ClientSideToolRegistry();
    const dummyish: ClientSideTool = {
      name: 'dummy',
      claudeAgentBridgeable: true,
      description: '(de)activate a hook',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action'],
      },
      execute: async input =>
        input.action === 'register'
          ? { content: 'on', activeHook: 'h1' }
          : { content: 'off', activeHook: null },
    };
    registry.registerAll([dummyish]);
    const toolContext = { toolRegistry: registry } as unknown as ToolContext;

    // register then unregister within the same turn — the surfaced value is the
    // last one (null = deactivate), and `null` must survive the !== undefined guard.
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
        await sdkSim.callTool({ name: 'dummy', arguments: { action: 'register' } });
        await sdkSim.callTool({ name: 'dummy', arguments: { action: 'unregister' } });
        yield {
          type: 'assistant' as const,
          uuid: 'a1',
          session_id: 's',
          message: { content: [{ type: 'text', text: 'done' }] },
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

    const { result } = await consume(client, [userMessage('go')], makeApiDef(), {
      toolContext,
      enabledTools: ['dummy'],
      toolOptions: {},
    });

    const r = result as { providerExtra?: Record<string, unknown> };
    expect('claudeAgentActiveHook' in (r.providerExtra ?? {})).toBe(true);
    expect(r.providerExtra?.claudeAgentActiveHook).toBeNull();
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

  it('surfaces the assistant max_tokens stop_reason on a mid-text truncated turn', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      // CLAUDE_CODE_MAX_OUTPUT_TOKENS fired mid-answer: assistant message says
      // max_tokens, the session-level result still closes success/end_turn.
      query: makeFailingTurnQuery({
        text: 'partial answer that got cut',
        messageStopReason: 'max_tokens',
      }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { stopReason?: string; error?: { message: string } };
    expect(r.stopReason).toBe('max_tokens');
    // Accept-the-turn convention (matches direct anthropicClient): the partial
    // text stands, downstream reacts to the stop reason.
    expect(r.error).toBeUndefined();
    debugSpy.mockRestore();
  });

  it('does not let a benign assistant tool_use stop_reason mask the session stop_reason', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFailingTurnQuery({ text: 'done', messageStopReason: 'tool_use' }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { stopReason?: string };
    expect(r.stopReason).toBe('end_turn');
    debugSpy.mockRestore();
  });

  it('surfaces a thinking-only turn as an error when treatEmptyOutputAsError is on', async () => {
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

    const apiDef = makeApiDef({ advancedSettings: { treatEmptyOutputAsError: true } });
    const { result } = await consume(client, [userMessage('hi')], apiDef);
    const r = result as { error?: { message: string } };
    expect(r.error?.message).toMatch(/only thinking and no output/);
    debugSpy.mockRestore();
  });

  it('does not error on a thinking-only turn when treatEmptyOutputAsError is off', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = new ClaudeAgentClient(makeDeps(), {
      query: makeFailingTurnQuery({
        rateLimitStatus: 'allowed',
        thinking: { thinking: '', signature: 'sig-abc' },
      }) as never,
      sessionDir: () => '/tmp',
      generateSessionId: () => 'u',
    });

    // Default apiDef has the opt-in off — the judgment call defers to the loop.
    const { result } = await consume(client, [userMessage('hi')], makeApiDef());
    const r = result as { error?: { message: string } };
    expect(r.error).toBeUndefined();
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
    sawFallback: false,
    treatEmptyOutputAsError: false,
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

  it('surfaces a thinking-only malfunction when treatEmptyOutputAsError is on', () => {
    const err = classifyTurnError({
      ...base,
      sawThinkingBlock: true,
      outputTokens: 256,
      treatEmptyOutputAsError: true,
    });
    expect(err?.message).toBe(
      'claude-agent: turn produced only thinking and no output (256 output tokens spent)'
    );
  });

  it('does not flag a thinking-only turn when treatEmptyOutputAsError is off', () => {
    // Same shape as above but opt-in off — left to the loop / verifyHook, matching
    // how the structurally identical no-thinking empty turn is handled.
    expect(
      classifyTurnError({ ...base, sawThinkingBlock: true, outputTokens: 256 })
    ).toBeUndefined();
  });

  it('does not flag a notice-only fallback turn as empty output', () => {
    // treatFallbackAsError off → the fallback rendered as an inline notice, which
    // is real output, so an otherwise-empty turn must not be reclassified.
    expect(classifyTurnError({ ...base, sawFallback: true })).toBeUndefined();
  });

  it('still surfaces a hard error on an empty turn even with treatEmptyOutputAsError off', () => {
    // Hard-failure branches recover real signals and stay unconditional.
    expect(classifyTurnError({ ...base, assistantError: 'overloaded' })?.message).toBe(
      'claude-agent: overloaded'
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

  it('is undefined for a truncated turn that produced text (accept-the-turn convention)', () => {
    // max_tokens + partial text is not a turn error — the truthful stopReason
    // rides StreamResult instead, driving the minion abnormal-stop rewind and
    // the Truncated badge.
    expect(
      classifyTurnError({ ...base, textLength: 30, assistantStopReason: 'max_tokens' })
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

describe('describeFallback', () => {
  it('names both models when known', () => {
    expect(describeFallback('claude-fable-5', 'claude-opus-4-8')).toBe(
      'claude-agent: request handled by claude-opus-4-8 instead of claude-fable-5'
    );
  });

  it('names just the target when the source is unknown', () => {
    expect(describeFallback(undefined, 'claude-opus-4-8')).toBe(
      'claude-agent: request handled by claude-opus-4-8'
    );
  });

  it('falls back to a generic statement when neither model is known', () => {
    expect(describeFallback()).toBe('claude-agent: request handled by a different model');
  });
});

describe('trimBlockJson', () => {
  it('pretty-prints small blocks in full', () => {
    expect(trimBlockJson({ type: 'x', input: { a: 1 } })).toBe(
      JSON.stringify({ type: 'x', input: { a: 1 } }, null, 2)
    );
  });

  it('caps oversized blocks and reports the overflow', () => {
    const trimmed = trimBlockJson({ payload: 'y'.repeat(5000) }, 100);
    expect(trimmed.length).toBeLessThan(150);
    expect(trimmed.startsWith('{\n  "payload"')).toBe(true);
    expect(trimmed).toMatch(/… \(\+\d+ more chars\)$/);
  });

  it('never throws on unstringifiable input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(trimBlockJson(cyclic)).toBe('[object Object]');
    expect(trimBlockJson(undefined)).toBe('undefined');
  });
});

describe('model-delivery detection helpers', () => {
  describe('bridgedToolName', () => {
    it('strips the mcp__gremlin__ prefix', () => {
      expect(bridgedToolName('mcp__gremlin__filesystem')).toBe('filesystem');
    });

    it('returns null for non-bridged tools', () => {
      expect(bridgedToolName('WebSearch')).toBeNull();
      expect(bridgedToolName('mcp__other__filesystem')).toBeNull();
    });
  });

  describe('toolInputKey', () => {
    it('is stable for equal inputs and distinct for different ones', () => {
      expect(toolInputKey({ a: 1, b: 2 })).toBe(toolInputKey({ a: 1, b: 2 }));
      expect(toolInputKey({ a: 1 })).not.toBe(toolInputKey({ a: 2 }));
    });

    it('handles undefined/null without throwing', () => {
      expect(toolInputKey(undefined)).toBe('null');
      expect(toolInputKey(null)).toBe('null');
    });
  });

  describe('extractToolResponseText', () => {
    it('returns a bare string as-is', () => {
      expect(extractToolResponseText('hello')).toBe('hello');
    });

    it('joins text from an MCP CallToolResult content array', () => {
      expect(
        extractToolResponseText({
          content: [
            { type: 'text', text: 'foo' },
            { type: 'text', text: 'bar' },
          ],
        })
      ).toBe('foobar');
    });

    it('reads a string content field', () => {
      expect(extractToolResponseText({ content: 'baz' })).toBe('baz');
    });

    it('falls back to JSON for unrecognized shapes', () => {
      expect(extractToolResponseText({ other: 1 })).toBe('{"other":1}');
    });
  });

  describe('detectTruncation', () => {
    it('flags a strictly shorter received payload as truncated', () => {
      expect(detectTruncation('full result', 'full')).toEqual({
        status: 'truncated',
        detail: 'model received 4 of 11 chars',
      });
    });

    it('returns null when the payloads match', () => {
      expect(detectTruncation('same', 'same')).toBeNull();
    });

    it('returns null when received is longer (not a truncation)', () => {
      expect(detectTruncation('short', 'short plus more')).toBeNull();
    });
  });
});

import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { APIDefinition } from '../../../protocol/types';
import {
  applyCacheBreakpoints,
  buildAnthropicBetas,
  buildBedrockClientOptions,
  findLastAssistantMessageIdx,
  findPreviousUserMessageIdx,
  parseBedrockEndpoint,
  placeCacheControlOnMessage,
  validateAnthropicResponse,
} from '../anthropicClient';

describe('applyCacheBreakpoints', () => {
  it('should skip empty text blocks when placing breakpoints', () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Real content' },
          { type: 'text', text: '' },
        ],
      },
    ];
    applyCacheBreakpoints(messages);

    const content = messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    // Breakpoint should be on the non-empty text block, not the empty one
    expect(content[0]).toHaveProperty('cache_control');
    expect(content[1]).not.toHaveProperty('cache_control');
  });

  it('should skip whitespace-only text blocks', () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: '   ' },
        ],
      },
    ];
    applyCacheBreakpoints(messages);

    const content = messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    expect(content[0]).toHaveProperty('cache_control');
    expect(content[1]).not.toHaveProperty('cache_control');
  });

  it('should skip message when all blocks are empty or thinking', () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Cacheable' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking' as 'text', text: '' },
          { type: 'text', text: '' },
        ],
      },
    ];
    applyCacheBreakpoints(messages);

    // Second message skipped, first message gets breakpoint
    const first = messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    const second = messages[1].content as Anthropic.Beta.BetaContentBlockParam[];
    expect(first[0]).toHaveProperty('cache_control');
    expect(second[0]).not.toHaveProperty('cache_control');
    expect(second[1]).not.toHaveProperty('cache_control');
  });

  it('should place breakpoint on tool_use block after empty text', () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'test', input: {} },
          { type: 'text', text: '' },
        ],
      },
    ];
    applyCacheBreakpoints(messages);

    const content = messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    expect(content[0]).toHaveProperty('cache_control');
    expect(content[1]).not.toHaveProperty('cache_control');
  });
});

describe('placeCacheControlOnMessage', () => {
  it('places cache_control on last eligible block', () => {
    const msg: Anthropic.Beta.BetaMessageParam = {
      role: 'user',
      content: [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ],
    };
    expect(placeCacheControlOnMessage(msg)).toBe(true);
    const content = msg.content as Anthropic.Beta.BetaContentBlockParam[];
    expect(content[1]).toHaveProperty('cache_control');
    expect(content[0]).not.toHaveProperty('cache_control');
  });

  it('returns false for string content', () => {
    const msg: Anthropic.Beta.BetaMessageParam = {
      role: 'user',
      content: 'plain string',
    };
    expect(placeCacheControlOnMessage(msg)).toBe(false);
  });

  it('skips messages that already have cache_control', () => {
    const msg: Anthropic.Beta.BetaMessageParam = {
      role: 'user',
      content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }],
    };
    expect(placeCacheControlOnMessage(msg)).toBe(false);
  });

  it('skips thinking and empty text blocks', () => {
    const msg: Anthropic.Beta.BetaMessageParam = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Real' },
        { type: 'thinking' as 'text', text: 'thought' },
        { type: 'text', text: '' },
      ],
    };
    expect(placeCacheControlOnMessage(msg)).toBe(true);
    const content = msg.content as Anthropic.Beta.BetaContentBlockParam[];
    expect(content[0]).toHaveProperty('cache_control');
  });

  it('returns false when no eligible block exists', () => {
    const msg: Anthropic.Beta.BetaMessageParam = {
      role: 'assistant',
      content: [
        { type: 'thinking' as 'text', text: 'thought' },
        { type: 'text', text: '  ' },
      ],
    };
    expect(placeCacheControlOnMessage(msg)).toBe(false);
  });

  it('omits ttl when called with default (5m)', () => {
    const msg: Anthropic.Beta.BetaMessageParam = {
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    };
    placeCacheControlOnMessage(msg);
    const block = (msg.content as Anthropic.Beta.BetaContentBlockParam[])[0] as {
      cache_control: { type: string; ttl?: string };
    };
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
  });

  it("emits ttl: '1h' when called with '1h'", () => {
    const msg: Anthropic.Beta.BetaMessageParam = {
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    };
    placeCacheControlOnMessage(msg, '1h');
    const block = (msg.content as Anthropic.Beta.BetaContentBlockParam[])[0] as {
      cache_control: { type: string; ttl?: string };
    };
    expect(block.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it("omits ttl when called with '5m' (default behavior, smaller payload)", () => {
    const msg: Anthropic.Beta.BetaMessageParam = {
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    };
    placeCacheControlOnMessage(msg, '5m');
    const block = (msg.content as Anthropic.Beta.BetaContentBlockParam[])[0] as {
      cache_control: { type: string; ttl?: string };
    };
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('applyCacheBreakpoints with startIdx', () => {
  it('restricts breakpoints to messages at/after startIdx', () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'msg-0' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'msg-1' }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as 'text',
            text: 'anchored',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'msg-3' }] },
      { role: 'user', content: [{ type: 'text', text: 'msg-4' }] },
    ];
    // startIdx=3 means only msg[3] and msg[4] are eligible
    applyCacheBreakpoints(messages, 3);

    const msg0 = messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    const msg1 = messages[1].content as Anthropic.Beta.BetaContentBlockParam[];
    const msg3 = messages[3].content as Anthropic.Beta.BetaContentBlockParam[];
    const msg4 = messages[4].content as Anthropic.Beta.BetaContentBlockParam[];

    // Messages before startIdx untouched
    expect(msg0[0]).not.toHaveProperty('cache_control');
    expect(msg1[0]).not.toHaveProperty('cache_control');

    // Only the last eligible message gets the breakpoint
    expect(msg4[0]).toHaveProperty('cache_control');
    expect(msg3[0]).not.toHaveProperty('cache_control');
  });

  it('places 0 breakpoints when startIdx is past all messages', () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'msg-0' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'anchored', cache_control: { type: 'ephemeral' } }],
      },
    ];
    // startIdx past end — no sliding breakpoints placed
    applyCacheBreakpoints(messages, 2);

    const msg0 = messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    expect(msg0[0]).not.toHaveProperty('cache_control');
    // Anchor's pre-existing cache_control remains
    const msg1 = messages[1].content as Anthropic.Beta.BetaContentBlockParam[];
    expect(msg1[0]).toHaveProperty('cache_control');
  });

  it("propagates ttl: '1h' to the breakpoint it places", () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'msg-0' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'msg-1' }] },
    ];
    applyCacheBreakpoints(messages, 0, '1h');
    const last = messages[1].content as Anthropic.Beta.BetaContentBlockParam[];
    expect((last[0] as { cache_control: { ttl?: string } }).cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });
});

describe('buildAnthropicBetas', () => {
  it('always includes interleaved-thinking', () => {
    const betas = buildAnthropicBetas({});
    expect(betas).toContain('interleaved-thinking-2025-05-14');
  });

  it('includes web-fetch beta when web search is enabled', () => {
    const betas = buildAnthropicBetas({ webSearchEnabled: true });
    expect(betas).toContain('web-fetch-2025-09-10');
  });

  it('does not include web-fetch beta when web search is disabled', () => {
    const betas = buildAnthropicBetas({ webSearchEnabled: false });
    expect(betas).not.toContain('web-fetch-2025-09-10');
  });

  it('includes context-management beta when memory tool is enabled', () => {
    const betas = buildAnthropicBetas({ enabledTools: ['memory'] });
    expect(betas).toContain('context-management-2025-06-27');
  });

  it('includes context-management beta when thinkingKeepTurns is set', () => {
    const betas = buildAnthropicBetas({ thinkingKeepTurns: 2 });
    expect(betas).toContain('context-management-2025-06-27');
  });

  it('includes context-1m beta when extendedContext is true', () => {
    const betas = buildAnthropicBetas({ extendedContext: true });
    expect(betas).toContain('context-1m-2025-08-07');
  });

  it('does not include context-1m beta when extendedContext is false', () => {
    const betas = buildAnthropicBetas({ extendedContext: false });
    expect(betas).not.toContain('context-1m-2025-08-07');
  });

  it('does not include context-1m beta when extendedContext is undefined', () => {
    const betas = buildAnthropicBetas({});
    expect(betas).not.toContain('context-1m-2025-08-07');
  });

  it('includes all betas when all options are enabled', () => {
    const betas = buildAnthropicBetas({
      webSearchEnabled: true,
      enabledTools: ['memory'],
      thinkingKeepTurns: 3,
      extendedContext: true,
    });
    expect(betas).toContain('interleaved-thinking-2025-05-14');
    expect(betas).toContain('web-fetch-2025-09-10');
    expect(betas).toContain('context-management-2025-06-27');
    expect(betas).toContain('context-1m-2025-08-07');
    expect(betas).toHaveLength(4);
  });
});

describe('validateAnthropicResponse', () => {
  it('passes with valid cache read activity', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 },
        [{ type: 'text' }]
      )
    ).not.toThrow();
  });

  it('passes with valid cache write activity', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 },
        [{ type: 'text' }]
      )
    ).not.toThrow();
  });

  it('throws on zero cache activity with >4096 input tokens', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        [{ type: 'text' }]
      )
    ).toThrow('Cache enforcement failed');
  });

  it('throws when cache fields are null', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        [{ type: 'text' }]
      )
    ).toThrow('Cache enforcement failed');
  });

  it('passes when input tokens are <=4096', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 4096, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        [{ type: 'text' }]
      )
    ).not.toThrow();
  });

  it('passes when thinking blocks have valid signatures', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
        [{ type: 'thinking', signature: 'abc123signaturedata' }, { type: 'text' }]
      )
    ).not.toThrow();
  });

  it('throws when thinking blocks have empty signatures', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
        [{ type: 'thinking', signature: '' }, { type: 'text' }]
      )
    ).toThrow('Thinking signature check failed');
  });

  it('throws when thinking blocks have no signature field', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
        [{ type: 'thinking' }, { type: 'text' }]
      )
    ).toThrow('Thinking signature check failed');
  });

  it('passes when no thinking blocks exist', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
        [{ type: 'text' }, { type: 'redacted_thinking' }]
      )
    ).not.toThrow();
  });

  it('only checks thinking blocks, not redacted_thinking', () => {
    expect(() =>
      validateAnthropicResponse(
        { input_tokens: 5000, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
        [{ type: 'thinking', signature: 'valid' }, { type: 'redacted_thinking' }]
      )
    ).not.toThrow();
  });
});

describe('findPreviousUserMessageIdx', () => {
  const userMsg = (text: string): Anthropic.Beta.BetaMessageParam => ({
    role: 'user',
    content: [{ type: 'text', text }],
  });
  const asstMsg = (text: string): Anthropic.Beta.BetaMessageParam => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });
  const toolUseMsg = (id: string): Anthropic.Beta.BetaMessageParam => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 't', input: {} }],
  });
  const toolResultMsg = (id: string): Anthropic.Beta.BetaMessageParam => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
  });

  it('returns the user message before the latest in a user/assistant/user flow', () => {
    const messages = [userMsg('first'), asstMsg('reply'), userMsg('second')];
    expect(findPreviousUserMessageIdx(messages)).toBe(0);
  });

  it('skips tool_result user-role messages when finding the previous real user message', () => {
    // Typical agentic loop: user, assistant(tool_use), user(tool_result),
    // assistant(final), user(new turn). Previous real user = index 0.
    const messages = [
      userMsg('first real'),
      toolUseMsg('tu_1'),
      toolResultMsg('tu_1'),
      asstMsg('final reply'),
      userMsg('latest real'),
    ];
    expect(findPreviousUserMessageIdx(messages)).toBe(0);
  });

  it('returns -1 when only one real user message exists', () => {
    const messages = [userMsg('only')];
    expect(findPreviousUserMessageIdx(messages)).toBe(-1);
  });

  it('returns -1 when only one real user exists alongside tool_result messages', () => {
    const messages = [userMsg('only real'), toolUseMsg('tu_1'), toolResultMsg('tu_1')];
    expect(findPreviousUserMessageIdx(messages)).toBe(-1);
  });

  it('returns -1 when no user messages exist', () => {
    const messages = [asstMsg('a'), asstMsg('b')];
    expect(findPreviousUserMessageIdx(messages)).toBe(-1);
  });

  it('respects startIdx — never returns indices before the anchor', () => {
    // user@0 would be the previous, but startIdx excludes it. Only user@2 is left ⇒ -1.
    const messages = [userMsg('pre-anchor'), asstMsg('anchored'), userMsg('latest')];
    expect(findPreviousUserMessageIdx(messages, 1)).toBe(-1);
  });
});

describe('findLastAssistantMessageIdx', () => {
  const userMsg = (text: string): Anthropic.Beta.BetaMessageParam => ({
    role: 'user',
    content: [{ type: 'text', text }],
  });
  const asstMsg = (text: string): Anthropic.Beta.BetaMessageParam => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });

  it('returns the last assistant message index in mixed arrays', () => {
    const messages = [userMsg('u1'), asstMsg('a1'), userMsg('u2'), asstMsg('a2'), userMsg('u3')];
    expect(findLastAssistantMessageIdx(messages)).toBe(3);
  });

  it('returns -1 when no assistant messages exist', () => {
    const messages = [userMsg('only')];
    expect(findLastAssistantMessageIdx(messages)).toBe(-1);
  });

  it('respects startIdx — never returns indices before the anchor', () => {
    const messages = [asstMsg('pre-anchor'), userMsg('u'), userMsg('latest')];
    expect(findLastAssistantMessageIdx(messages, 1)).toBe(-1);
  });
});

describe('parseBedrockEndpoint', () => {
  it('detects the "bedrock:region" shorthand and lets the SDK build the URL', () => {
    expect(parseBedrockEndpoint('bedrock:us-east-2')).toEqual({
      isBedrock: true,
      region: 'us-east-2',
      url: undefined,
    });
  });

  it('detects a full bedrock-runtime URL and keeps it as the baseURL', () => {
    const url = 'https://bedrock-runtime.us-west-2.amazonaws.com';
    expect(parseBedrockEndpoint(url)).toEqual({ isBedrock: true, region: 'us-west-2', url });
  });

  it('treats a non-Bedrock baseUrl as a passthrough', () => {
    expect(parseBedrockEndpoint('https://api.anthropic.com')).toEqual({
      isBedrock: false,
      region: 'us-east-1',
      url: 'https://api.anthropic.com',
    });
  });
});

describe('buildBedrockClientOptions', () => {
  const def = (apiKey: string): APIDefinition => ({
    id: 'd',
    apiType: 'anthropic',
    name: 'Bedrock Claude',
    baseUrl: 'bedrock:us-west-2',
    apiKey,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('passes the key via the native apiKey option and never sets skipAuth', () => {
    const opts = buildBedrockClientOptions(
      def('bedrock-key'),
      parseBedrockEndpoint('bedrock:us-west-2')
    );
    expect(opts.apiKey).toBe('bedrock-key');
    expect(opts.awsRegion).toBe('us-west-2');
    // Regression guard: skipAuth deletes the Authorization header → 403 "Authorization header is missing".
    expect('skipAuth' in opts).toBe(false);
    expect('defaultHeaders' in opts).toBe(false);
  });

  it('omits apiKey when no key is set so the SDK can fall back to SigV4', () => {
    const opts = buildBedrockClientOptions(def(''), parseBedrockEndpoint('bedrock:us-west-2'));
    expect('apiKey' in opts).toBe(false);
  });

  it('forwards a full bedrock-runtime URL as baseURL', () => {
    const url = 'https://bedrock-runtime.eu-central-1.amazonaws.com';
    const opts = buildBedrockClientOptions(def('k'), parseBedrockEndpoint(url));
    expect(opts.baseURL).toBe(url);
  });
});

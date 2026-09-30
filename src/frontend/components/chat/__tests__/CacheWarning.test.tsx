import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import CacheWarning from '../CacheWarning';
import { useApiDefinitions, useModels } from '../../../hooks/useApp';
import type { Message, APIDefinition, Model } from '../../../../shared/protocol/types';

// CacheWarning reads API definitions and cached models from the app context
vi.mock('../../../hooks/useApp', () => ({ useApiDefinitions: vi.fn(), useModels: vi.fn() }));

const MINUTE = 60 * 1000;
const NOW = new Date('2026-09-29T12:00:00Z').getTime();

const anthropicApiDef: APIDefinition = {
  id: 'api-1',
  apiType: 'anthropic',
  name: 'Anthropic',
  baseUrl: '',
  apiKey: 'test-key',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const openAIApiDef: APIDefinition = {
  id: 'api-2',
  apiType: 'chatgpt',
  name: 'OpenAI',
  baseUrl: '',
  apiKey: 'test-key',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const sonnet = {
  id: 'claude-3-5-sonnet',
  name: 'claude-3-5-sonnet',
  apiType: 'anthropic',
  matchedMode: 'exact',
  inputPrice: 3.0,
  outputPrice: 15.0,
  cacheReadPrice: 0.3,
  cacheWritePrice: 3.75,
  contextWindow: 200000,
} as Model;

function message(
  ageMinutes: number,
  overrides: { modelFamily?: string; contextWindowUsage?: number; id?: string } = {}
): Message<unknown> {
  return {
    id: overrides.id ?? 'msg-1',
    role: 'assistant',
    content: {
      type: 'text',
      content: 'Hello',
      modelFamily: overrides.modelFamily ?? 'anthropic',
    },
    timestamp: new Date(NOW - ageMinutes * MINUTE),
    metadata: { contextWindowUsage: overrides.contextWindowUsage ?? 10000 },
  } as Message<unknown>;
}

function renderWarning(
  messages: Message<unknown>[],
  apiDefId: string | null = 'api-1',
  modelId: string | null = 'claude-3-5-sonnet'
) {
  const view = render(
    <CacheWarning messages={messages} currentApiDefId={apiDefId} currentModelId={modelId} />
  );
  // The expiry timer fires for an already-expired message on the next tick
  act(() => {
    vi.advanceTimersByTime(0);
  });
  return view;
}

describe('CacheWarning', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.mocked(useApiDefinitions).mockReturnValue([anthropicApiDef, openAIApiDef]);
    vi.mocked(useModels).mockReturnValue(
      new Map([['api-1', [sonnet]]]) as unknown as ReturnType<typeof useModels>
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing without messages', () => {
    const { container } = renderWarning([]);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on a non-Anthropic API', () => {
    const { container } = renderWarning(
      [message(10, { modelFamily: 'chatgpt' })],
      'api-2',
      'gpt-4'
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while the last Anthropic message is recent', () => {
    const { container } = renderWarning([message(0)]);
    expect(container.firstChild).toBeNull();
  });

  it('warns when the last message is older than 5 minutes', () => {
    renderWarning([message(6)]);
    expect(screen.getByText(/Cache likely expired/i)).toBeInTheDocument();
    expect(screen.getByText(/Next message will cost at least/i)).toBeInTheDocument();
  });

  it('warns when the last message came from another provider', () => {
    renderWarning([message(0, { modelFamily: 'chatgpt' })]);
    expect(screen.getByText(/Cache likely expired/i)).toBeInTheDocument();
  });

  it('prices the rewrite at the cache write price', () => {
    renderWarning([message(6, { contextWindowUsage: 100000 })]);
    // 100000 tokens / 1M * $3.75 = $0.375
    expect(screen.getByText(/\$0\.38/)).toBeInTheDocument();
  });

  it('renders nothing when the context window usage is 0', () => {
    const { container } = renderWarning([message(6, { contextWindowUsage: 0 })]);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing without an API definition or model', () => {
    expect(renderWarning([message(6)], null).container.firstChild).toBeNull();
    expect(renderWarning([message(6)], 'api-1', null).container.firstChild).toBeNull();
  });

  it('appears on its own when the cache expires while the chat sits open', () => {
    renderWarning([message(3)]);
    expect(screen.queryByText(/Cache likely expired/i)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2 * MINUTE + 1);
    });

    expect(screen.getByText(/Cache likely expired/i)).toBeInTheDocument();
  });

  it('clears when a new message arrives', () => {
    const { rerender } = renderWarning([message(6)]);
    expect(screen.getByText(/Cache likely expired/i)).toBeInTheDocument();

    rerender(
      <CacheWarning
        messages={[message(6), message(0, { id: 'msg-2' })]}
        currentApiDefId="api-1"
        currentModelId="claude-3-5-sonnet"
      />
    );

    expect(screen.queryByText(/Cache likely expired/i)).not.toBeInTheDocument();
  });
});

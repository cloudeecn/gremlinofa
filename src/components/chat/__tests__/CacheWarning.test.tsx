import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CacheWarning from '../CacheWarning';
import { storage } from '../../../services/storage';
import type { Message, APIDefinition } from '../../../types';
import { APIType, MessageRole } from '../../../types';

// Mock storage
vi.mock('../../../services/storage', () => ({
  storage: {
    getAPIDefinition: vi.fn(),
  },
}));

describe('CacheWarning', () => {
  const mockAnthropicApiDef: APIDefinition = {
    id: 'api-1',
    apiType: APIType.ANTHROPIC,
    name: 'Anthropic',
    baseUrl: '',
    apiKey: 'test-key',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockOpenAIApiDef: APIDefinition = {
    id: 'api-2',
    apiType: APIType.CHATGPT,
    name: 'OpenAI',
    baseUrl: '',
    apiKey: 'test-key',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not render when there are no messages', async () => {
    vi.mocked(storage.getAPIDefinition).mockResolvedValue(mockAnthropicApiDef);

    const { container } = render(
      <CacheWarning messages={[]} currentApiDefId="api-1" currentModelId="claude-3-5-sonnet" />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('should not render when not using Anthropic API', async () => {
    vi.mocked(storage.getAPIDefinition).mockResolvedValue(mockOpenAIApiDef);

    const recentMessage: Message<unknown> = {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: 'Hello',
        modelFamily: APIType.CHATGPT,
      },
      timestamp: new Date(),
      metadata: {
        contextWindowUsage: 1000,
      },
    };

    const { container } = render(
      <CacheWarning messages={[recentMessage]} currentApiDefId="api-2" currentModelId="gpt-4" />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('should not render when last message is recent and from Anthropic', async () => {
    vi.mocked(storage.getAPIDefinition).mockResolvedValue(mockAnthropicApiDef);

    const recentMessage: Message<unknown> = {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: 'Hello',
        modelFamily: APIType.ANTHROPIC,
      },
      timestamp: new Date(), // Just now
      metadata: {
        contextWindowUsage: 1000,
      },
    };

    const { container } = render(
      <CacheWarning
        messages={[recentMessage]}
        currentApiDefId="api-1"
        currentModelId="claude-3-5-sonnet"
      />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('should render warning when last message is older than 5 minutes', async () => {
    vi.mocked(storage.getAPIDefinition).mockResolvedValue(mockAnthropicApiDef);

    const oldTimestamp = new Date();
    oldTimestamp.setMinutes(oldTimestamp.getMinutes() - 6); // 6 minutes ago

    const oldMessage: Message<unknown> = {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: 'Hello',
        modelFamily: APIType.ANTHROPIC,
      },
      timestamp: oldTimestamp,
      metadata: {
        contextWindowUsage: 10000,
      },
    };

    render(
      <CacheWarning
        messages={[oldMessage]}
        currentApiDefId="api-1"
        currentModelId="claude-3-5-sonnet"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Cache likely expired/i)).toBeInTheDocument();
      expect(screen.getByText(/Next message will cost at least/i)).toBeInTheDocument();
    });
  });

  it('should render warning when last message is not from Anthropic', async () => {
    vi.mocked(storage.getAPIDefinition).mockResolvedValue(mockAnthropicApiDef);

    const recentMessage: Message<unknown> = {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: 'Hello',
        modelFamily: APIType.CHATGPT, // Different provider
      },
      timestamp: new Date(),
      metadata: {
        contextWindowUsage: 10000,
      },
    };

    render(
      <CacheWarning
        messages={[recentMessage]}
        currentApiDefId="api-1"
        currentModelId="claude-3-5-sonnet"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Cache likely expired/i)).toBeInTheDocument();
    });
  });

  it('should calculate cost correctly using cache write price', async () => {
    vi.mocked(storage.getAPIDefinition).mockResolvedValue(mockAnthropicApiDef);

    const oldTimestamp = new Date();
    oldTimestamp.setMinutes(oldTimestamp.getMinutes() - 6);

    const oldMessage: Message<unknown> = {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: 'Hello',
        modelFamily: APIType.ANTHROPIC,
      },
      timestamp: oldTimestamp,
      metadata: {
        contextWindowUsage: 100000, // 100k tokens
      },
    };

    render(
      <CacheWarning
        messages={[oldMessage]}
        currentApiDefId="api-1"
        currentModelId="claude-3-5-sonnet" // cacheWritePrice = $3.75/1M
      />
    );

    await waitFor(() => {
      // 100000 tokens / 1M * $3.75 = $0.375
      expect(screen.getByText(/\$0\.38/)).toBeInTheDocument(); // Rounded to 2 decimals
    });
  });

  it('should not render when context window usage is 0', async () => {
    vi.mocked(storage.getAPIDefinition).mockResolvedValue(mockAnthropicApiDef);

    const oldTimestamp = new Date();
    oldTimestamp.setMinutes(oldTimestamp.getMinutes() - 6);

    const oldMessage: Message<unknown> = {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: 'Hello',
        modelFamily: APIType.ANTHROPIC,
      },
      timestamp: oldTimestamp,
      metadata: {
        contextWindowUsage: 0, // No context
      },
    };

    const { container } = render(
      <CacheWarning
        messages={[oldMessage]}
        currentApiDefId="api-1"
        currentModelId="claude-3-5-sonnet"
      />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('should not render when currentApiDefId is null', async () => {
    const recentMessage: Message<unknown> = {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: 'Hello',
        modelFamily: APIType.ANTHROPIC,
      },
      timestamp: new Date(),
      metadata: {
        contextWindowUsage: 1000,
      },
    };

    const { container } = render(
      <CacheWarning
        messages={[recentMessage]}
        currentApiDefId={null}
        currentModelId="claude-3-5-sonnet"
      />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('should not render when currentModelId is null', async () => {
    const recentMessage: Message<unknown> = {
      id: 'msg-1',
      role: MessageRole.ASSISTANT,
      content: {
        type: 'text',
        content: 'Hello',
        modelFamily: APIType.ANTHROPIC,
      },
      timestamp: new Date(),
      metadata: {
        contextWindowUsage: 1000,
      },
    };

    const { container } = render(
      <CacheWarning messages={[recentMessage]} currentApiDefId="api-1" currentModelId={null} />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });
});

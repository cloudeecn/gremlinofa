import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ToolResultBubble from '../ToolResultBubble';
import type { Message } from '../../../types';

// Mock ToolResultView
vi.mock('../ToolResultView', () => ({
  default: () => <div data-testid="tool-result-view" />,
}));

function createToolResultMessage(overrides?: {
  metadata?: Message<unknown>['metadata'];
}): Message<unknown> {
  return {
    id: 'msg_1',
    role: 'user',
    content: {
      type: 'text',
      content: '',
      renderingContent: [
        {
          category: 'backstage',
          blocks: [
            {
              type: 'tool_result',
              name: 'memory',
              tool_use_id: 'tu_1',
              content: 'File created',
              icon: '🧠',
              status: 'complete',
            },
          ],
        },
      ],
    },
    timestamp: new Date('2025-01-01T12:00:00Z'),
    ...overrides,
  };
}

describe('ToolResultBubble', () => {
  it('shows cost metadata when messageCost > 0', () => {
    const message = createToolResultMessage({
      metadata: {
        inputTokens: 5000,
        outputTokens: 2000,
        messageCost: 0.042,
      },
    });

    render(<ToolResultBubble message={message} />);

    expect(screen.getByText(/\$0\.042/)).toBeInTheDocument();
    expect(screen.getByText(/↑5000/)).toBeInTheDocument();
    expect(screen.getByText(/↓2000/)).toBeInTheDocument();
  });

  it('hides cost metadata when no metadata', () => {
    const message = createToolResultMessage();
    render(<ToolResultBubble message={message} />);

    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('hides cost metadata when messageCost is 0', () => {
    const message = createToolResultMessage({
      metadata: { messageCost: 0 },
    });
    render(<ToolResultBubble message={message} />);

    expect(screen.queryByText(/\$0\.000/)).not.toBeInTheDocument();
  });

  it('formats large token counts with k suffix', () => {
    const message = createToolResultMessage({
      metadata: {
        inputTokens: 15000,
        outputTokens: 8000,
        messageCost: 0.1,
      },
    });

    render(<ToolResultBubble message={message} />);

    expect(screen.getByText(/↑15\.0k/)).toBeInTheDocument();
    expect(screen.getByText(/↓8000/)).toBeInTheDocument();
  });
});

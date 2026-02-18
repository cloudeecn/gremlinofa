import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolResultView from '../ToolResultView';
import { MinionChatOverlayContext } from '../MinionChatOverlayContext';
import type { ToolResultRenderBlock, RenderingBlockGroup } from '../../../types/content';

// Mock BackstageView
vi.mock('../BackstageView', () => ({
  default: ({ blocks }: { blocks: unknown[] }) => (
    <div data-testid="backstage-view">Backstage: {blocks.length} blocks</div>
  ),
}));

// Mock TextGroupView
vi.mock('../TextGroupView', () => ({
  default: ({ blocks }: { blocks: { type: string; text: string }[] }) => (
    <div data-testid="text-group-view">{blocks.map(b => b.text).join('')}</div>
  ),
}));

// Mock useApp to provide apiDefinitions
vi.mock('../../../hooks/useApp', () => ({
  useApp: () => ({
    apiDefinitions: [
      {
        id: 'api_1',
        apiType: 'anthropic',
        name: 'Anthropic',
        icon: '✨',
        baseUrl: '',
        apiKey: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'api_2',
        apiType: 'chatgpt',
        name: 'OpenAI',
        baseUrl: '',
        apiKey: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  }),
}));

const mockViewMinionChat = vi.fn();

/** Wrap component with overlay context for View Chat button support */
function renderWithOverlay(ui: React.ReactElement) {
  return render(
    <MinionChatOverlayContext.Provider value={{ viewMinionChat: mockViewMinionChat }}>
      {ui}
    </MinionChatOverlayContext.Provider>
  );
}

describe('ToolResultView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('simple tool result (no renderingGroups)', () => {
    const simpleBlock: ToolResultRenderBlock = {
      type: 'tool_result',
      name: 'memory',
      tool_use_id: 'tu_1',
      content: 'File created at /memories/notes.md',
      icon: '🧠',
    };

    it('renders tool icon without name text', () => {
      render(<ToolResultView block={simpleBlock} />);
      expect(screen.getByText('🧠')).toBeInTheDocument();
      expect(screen.queryByText('memory')).not.toBeInTheDocument();
    });

    it('starts collapsed', () => {
      render(<ToolResultView block={simpleBlock} />);
      expect(screen.getByText('▶')).toBeInTheDocument();
      expect(screen.queryByText('File created at /memories/notes.md')).not.toBeInTheDocument();
    });

    it('expands on click to show content', () => {
      render(<ToolResultView block={simpleBlock} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('▼')).toBeInTheDocument();
      expect(screen.getByText('File created at /memories/notes.md')).toBeInTheDocument();
    });

    it('uses renderedContent when available', () => {
      const block: ToolResultRenderBlock = {
        ...simpleBlock,
        renderedContent: 'Rendered: File created',
      };
      render(<ToolResultView block={block} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Rendered: File created')).toBeInTheDocument();
    });

    it('shows error styling when is_error', () => {
      const errorBlock: ToolResultRenderBlock = {
        type: 'tool_result',
        name: 'javascript',
        tool_use_id: 'tu_2',
        content: 'SyntaxError: unexpected token',
        is_error: true,
      };
      render(<ToolResultView block={errorBlock} />);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-red-600');
    });

    it('shows default error icon when is_error and no icon', () => {
      const errorBlock: ToolResultRenderBlock = {
        type: 'tool_result',
        name: 'javascript',
        tool_use_id: 'tu_2',
        content: 'Error',
        is_error: true,
      };
      render(<ToolResultView block={errorBlock} />);
      expect(screen.getByText('❌')).toBeInTheDocument();
    });

    it('shows default success icon when no icon', () => {
      const block: ToolResultRenderBlock = {
        type: 'tool_result',
        name: 'memory',
        tool_use_id: 'tu_1',
        content: 'ok',
      };
      render(<ToolResultView block={block} />);
      expect(screen.getByText('✅')).toBeInTheDocument();
    });
  });

  describe('complex tool result (with renderingGroups)', () => {
    const infoGroup: RenderingBlockGroup = {
      category: 'backstage',
      blocks: [{ type: 'tool_info', input: 'Analyze this code', chatId: 'minion_abc' }],
    };

    const backstageGroup: RenderingBlockGroup = {
      category: 'backstage',
      blocks: [{ type: 'thinking', thinking: 'Let me analyze...' }],
      isToolGenerated: true,
    };

    const textGroup: RenderingBlockGroup = {
      category: 'text',
      blocks: [{ type: 'text', text: 'Some intermediate output' }],
      isToolGenerated: true,
    };

    const complexBlock: ToolResultRenderBlock = {
      type: 'tool_result',
      name: 'minion',
      tool_use_id: 'tu_3',
      content: 'Task completed successfully',
      icon: '🤖',
      status: 'complete',
      renderingGroups: [infoGroup, backstageGroup, textGroup],
    };

    it('renders collapsible header with icon only', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);
      expect(screen.getByText('🤖')).toBeInTheDocument();
      expect(screen.queryByText('minion')).not.toBeInTheDocument();
    });

    it('starts collapsed when status is complete', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);
      expect(screen.getByText('▶')).toBeInTheDocument();
      expect(screen.queryByTestId('backstage-view')).not.toBeInTheDocument();
    });

    it('starts collapsed even when status is running', () => {
      const runningBlock: ToolResultRenderBlock = { ...complexBlock, status: 'running' };
      renderWithOverlay(<ToolResultView block={runningBlock} />);
      // Collapsed by default — shows ▶ not ▼
      expect(screen.getByText('▶')).toBeInTheDocument();
    });

    it('shows last activity preview when collapsed', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);
      // Preview shows last text from activity groups
      expect(screen.getByText('Some intermediate output')).toBeInTheDocument();
    });

    it('shows chatId in header when no preview text', () => {
      // Only tool_info group, no activity groups → chatId shown as fallback
      const infoOnlyBlock: ToolResultRenderBlock = {
        ...complexBlock,
        renderingGroups: [infoGroup],
      };
      renderWithOverlay(<ToolResultView block={infoOnlyBlock} />);
      expect(screen.getByText('minion_abc')).toBeInTheDocument();
    });

    it('toggles expansion on header click', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);

      // Initially collapsed
      expect(screen.queryByTestId('backstage-view')).not.toBeInTheDocument();

      // Click to expand
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));
      expect(screen.getByTestId('backstage-view')).toBeInTheDocument();

      // Click to collapse
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));
      expect(screen.queryByTestId('backstage-view')).not.toBeInTheDocument();
    });

    it('shows tool_info input in blue box when expanded', () => {
      const { container } = renderWithOverlay(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      const blueBox = container.querySelector('.border-blue-300');
      expect(blueBox).toBeInTheDocument();
      expect(screen.getByText('Analyze this code')).toBeInTheDocument();
    });

    it('shows green result box when complete and not error', () => {
      const { container } = renderWithOverlay(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      const greenBox = container.querySelector('.border-green-300');
      expect(greenBox).toBeInTheDocument();
      expect(screen.getByText('Task completed successfully')).toBeInTheDocument();
    });

    it('shows red result box when is_error', () => {
      const errorBlock: ToolResultRenderBlock = {
        ...complexBlock,
        is_error: true,
        content: 'Minion failed',
      };
      const { container } = renderWithOverlay(<ToolResultView block={errorBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      const redBox = container.querySelector('.border-red-300');
      expect(redBox).toBeInTheDocument();
      expect(screen.getByText('Minion failed')).toBeInTheDocument();
    });

    it('does not show result box when running', () => {
      const runningBlock: ToolResultRenderBlock = {
        ...complexBlock,
        status: 'running',
        content: '',
      };
      const { container } = renderWithOverlay(<ToolResultView block={runningBlock} />);

      // Auto-expanded when running, should not have green/red box
      const greenBox = container.querySelector('.border-green-300');
      const redBox = container.querySelector('.border-red-300');
      expect(greenBox).not.toBeInTheDocument();
      expect(redBox).not.toBeInTheDocument();
    });

    it('renders activity groups (backstage and text)', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      expect(screen.getByTestId('backstage-view')).toBeInTheDocument();
      expect(screen.getByTestId('text-group-view')).toBeInTheDocument();
    });

    it('shows View Chat button when chatId and overlay context are present', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      const viewButton = screen.getByText('💬 View Chat');
      expect(viewButton).toBeInTheDocument();
      expect(viewButton.tagName).toBe('BUTTON');
    });

    it('calls overlay context when View Chat is clicked', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));
      fireEvent.click(screen.getByText('💬 View Chat'));

      expect(mockViewMinionChat).toHaveBeenCalledWith('minion_abc');
    });

    it('hides View Chat when overlay context is not provided', () => {
      // Render without overlay context (e.g., inside MinionChatView itself)
      render(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      expect(screen.queryByText('💬 View Chat')).not.toBeInTheDocument();
    });

    it('shows Copy JSON button', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      expect(screen.getByText('📋 Copy JSON')).toBeInTheDocument();
    });

    it('copies JSON to clipboard on button click', async () => {
      const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
      Object.assign(navigator, { clipboard: mockClipboard });

      renderWithOverlay(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));
      fireEvent.click(screen.getByText('📋 Copy JSON'));

      expect(mockClipboard.writeText).toHaveBeenCalledWith(JSON.stringify(complexBlock, null, 2));
    });

    it('handles clipboard error gracefully', () => {
      const mockClipboard = {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      };
      Object.assign(navigator, { clipboard: mockClipboard });

      renderWithOverlay(<ToolResultView block={complexBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      expect(() => fireEvent.click(screen.getByText('📋 Copy JSON'))).not.toThrow();
    });

    it('hides View Chat when no chatId', () => {
      const noChatIdBlock: ToolResultRenderBlock = {
        ...complexBlock,
        renderingGroups: [
          {
            category: 'backstage',
            blocks: [{ type: 'tool_info', input: 'task text' }],
          },
        ],
      };
      renderWithOverlay(<ToolResultView block={noChatIdBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      expect(screen.queryByText('💬 View Chat')).not.toBeInTheDocument();
      expect(screen.getByText('📋 Copy JSON')).toBeInTheDocument();
    });

    it('works without tool_info block', () => {
      const noInfoBlock: ToolResultRenderBlock = {
        ...complexBlock,
        renderingGroups: [backstageGroup, textGroup],
      };
      const { container } = renderWithOverlay(<ToolResultView block={noInfoBlock} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      // No blue box
      const blueBox = container.querySelector('.border-blue-300');
      expect(blueBox).not.toBeInTheDocument();

      // Activity groups still render
      expect(screen.getByTestId('backstage-view')).toBeInTheDocument();
    });

    it('uses default icon when block has no icon', () => {
      const noIconBlock: ToolResultRenderBlock = {
        ...complexBlock,
        icon: undefined,
      };
      renderWithOverlay(<ToolResultView block={noIconBlock} />);
      // Default icon for complex results is 🤖
      expect(screen.getByText('🤖')).toBeInTheDocument();
    });

    it('shows cost in header when tokenTotals has non-zero cost', () => {
      const costBlock: ToolResultRenderBlock = {
        ...complexBlock,
        tokenTotals: {
          inputTokens: 5000,
          outputTokens: 2000,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          webSearchCount: 0,
          cost: 0.042,
          costUnreliable: false,
        },
      };
      renderWithOverlay(<ToolResultView block={costBlock} />);
      expect(screen.getByText('$0.042')).toBeInTheDocument();
    });

    it('hides cost when tokenTotals has zero cost', () => {
      const zeroCostBlock: ToolResultRenderBlock = {
        ...complexBlock,
        tokenTotals: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          webSearchCount: 0,
          cost: 0,
          costUnreliable: false,
        },
      };
      renderWithOverlay(<ToolResultView block={zeroCostBlock} />);
      expect(screen.queryByText('$0.000')).not.toBeInTheDocument();
    });

    it('hides cost when no tokenTotals', () => {
      renderWithOverlay(<ToolResultView block={complexBlock} />);
      expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
    });

    it('shows displayName instead of persona in header', () => {
      const blockWithDisplayName: ToolResultRenderBlock = {
        ...complexBlock,
        renderingGroups: [
          {
            category: 'backstage',
            blocks: [
              {
                type: 'tool_info',
                input: 'task',
                chatId: 'minion_abc',
                persona: 'coder',
                displayName: 'Code Reviewer',
              },
            ],
          },
          backstageGroup,
        ],
      };
      renderWithOverlay(<ToolResultView block={blockWithDisplayName} />);
      expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
      expect(screen.queryByText('coder')).not.toBeInTheDocument();
    });

    it('shows persona when no displayName', () => {
      const blockWithPersona: ToolResultRenderBlock = {
        ...complexBlock,
        renderingGroups: [
          {
            category: 'backstage',
            blocks: [
              {
                type: 'tool_info',
                input: 'task',
                chatId: 'minion_abc',
                persona: 'coder',
              },
            ],
          },
          backstageGroup,
        ],
      };
      renderWithOverlay(<ToolResultView block={blockWithPersona} />);
      expect(screen.getByText('coder')).toBeInTheDocument();
    });

    it('shows settings info line with model and API icon when expanded', () => {
      const blockWithSettings: ToolResultRenderBlock = {
        ...complexBlock,
        renderingGroups: [
          {
            category: 'backstage',
            blocks: [
              {
                type: 'tool_info',
                input: 'task',
                chatId: 'minion_abc',
                persona: 'coder',
                apiDefinitionId: 'api_1',
                modelId: 'claude-3-5-sonnet',
              },
            ],
          },
          backstageGroup,
        ],
      };
      renderWithOverlay(<ToolResultView block={blockWithSettings} />);
      fireEvent.click(screen.getByRole('button', { name: /🤖/ }));

      // API icon from mocked apiDefinitions (api_1 has icon '✨')
      expect(screen.getByText('✨')).toBeInTheDocument();
      // Model ID displayed
      expect(screen.getByText('claude-3-5-sonnet')).toBeInTheDocument();
    });
  });
});

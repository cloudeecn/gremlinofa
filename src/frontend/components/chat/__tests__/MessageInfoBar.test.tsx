import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MessageInfoBar from '../MessageInfoBar';

vi.mock('../../../lib/messageFormatters', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../lib/messageFormatters')>()),
  formatTimestamp: (date: Date) => date.toISOString().split('T')[0],
}));

const timestamp = new Date('2026-09-10T12:00:00Z');

function trigger() {
  return screen.getByRole('button', { name: 'Message details' });
}

describe('MessageInfoBar', () => {
  it('shows timestamp, model and usage on the trigger row', () => {
    render(
      <MessageInfoBar
        timestamp={timestamp}
        model={{ requested: 'gpt-5', served: 'gpt-5' }}
        contextText="12.5k/200k"
        cost={0.0123}
        actions={<button title="Act">⚡</button>}
      />
    );

    const row = trigger();
    expect(row).toHaveTextContent('2026-09-10');
    expect(row).toHaveTextContent('gpt-5');
    expect(row).toHaveTextContent('12.5k/200k $0.012');
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows "-" instead of the requested id when the provider reported no model', () => {
    render(<MessageInfoBar timestamp={timestamp} model={{ requested: 'gpt-5' }} actions={null} />);

    const modelEl = screen.getByTestId('info-bar-model');
    expect(modelEl).toHaveTextContent('-');
    expect(modelEl).not.toHaveTextContent('gpt-5');
    expect(modelEl).not.toHaveClass('text-red-600');
    expect(modelEl).toHaveAttribute('title', 'gpt-5 requested, provider reported no model');
  });

  it('shows "-" with no title when neither id is known but the segment is requested', () => {
    render(<MessageInfoBar timestamp={timestamp} model={{}} actions={null} />);

    const modelEl = screen.getByTestId('info-bar-model');
    expect(modelEl).toHaveTextContent('-');
    expect(modelEl).not.toHaveAttribute('title');
  });

  it('reveals actions and token detail only after the trigger is clicked', async () => {
    render(
      <MessageInfoBar
        timestamp={timestamp}
        tokens={{ inputTokens: 100, outputTokens: 50, reasoningTokens: 10, webSearchCount: 2 }}
        actions={<button title="Act">⚡</button>}
      />
    );

    expect(screen.queryByTitle('Act')).not.toBeInTheDocument();
    expect(screen.queryByText(/↑100/)).not.toBeInTheDocument();

    await userEvent.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTitle('Act')).toBeInTheDocument();
    expect(screen.getByText('↑100 ↓(50, R:10) 🔍2')).toBeInTheDocument();

    await userEvent.click(trigger());
    expect(screen.queryByTitle('Act')).not.toBeInTheDocument();
  });

  it('prefers the served model and marks a mismatch red with both ids in the title', () => {
    render(
      <MessageInfoBar
        timestamp={timestamp}
        model={{ requested: 'gpt-5', served: 'gpt-5-2026-08-01' }}
        actions={null}
      />
    );

    const modelEl = screen.getByTestId('info-bar-model');
    expect(modelEl).toHaveTextContent('gpt-5-2026-08-01');
    expect(modelEl).toHaveClass('text-red-600');
    expect(modelEl).toHaveAttribute('title', 'gpt-5 → gpt-5-2026-08-01');
  });

  it('does not mark a matching served model', () => {
    render(
      <MessageInfoBar
        timestamp={timestamp}
        model={{ requested: 'claude-opus-5', served: 'claude-opus-5' }}
        actions={null}
      />
    );

    const modelEl = screen.getByTestId('info-bar-model');
    expect(modelEl).not.toHaveClass('text-red-600');
    expect(modelEl).toHaveAttribute('title', 'claude-opus-5');
  });

  it('truncates long model ids to 16 characters', () => {
    render(
      <MessageInfoBar
        timestamp={timestamp}
        model={{ requested: 'claude-fable-5-1-20260901', served: 'claude-fable-5-1-20260901' }}
        actions={null}
      />
    );

    const modelEl = screen.getByTestId('info-bar-model');
    expect(modelEl).toHaveTextContent('claude-fable-5-…');
    expect(modelEl).toHaveAttribute('title', 'claude-fable-5-1-20260901');
  });

  it('omits the model segment when no model prop is given', () => {
    render(<MessageInfoBar timestamp={timestamp} actions={null} />);

    expect(screen.queryByTestId('info-bar-model')).not.toBeInTheDocument();
    expect(trigger().textContent).not.toContain('|');
  });

  it('right-aligns both rows for align="end"', async () => {
    render(<MessageInfoBar timestamp={timestamp} align="end" actions={<span>act</span>} />);

    expect(trigger().parentElement).toHaveClass('justify-end');
    await userEvent.click(trigger());
    expect(screen.getByText('act').parentElement).toHaveClass('justify-end');
  });

  it('shows quick actions on the trigger row, before expanding', () => {
    render(
      <MessageInfoBar
        timestamp={timestamp}
        actions={<span>expanded-only</span>}
        quickActions={<button type="button">quick</button>}
      />
    );

    expect(screen.getByRole('button', { name: 'quick' })).toBeInTheDocument();
    expect(screen.queryByText('expanded-only')).not.toBeInTheDocument();
    expect(trigger().parentElement).toContainElement(screen.getByRole('button', { name: 'quick' }));
  });

  it('renders the badge at the tail of the trigger row', () => {
    render(
      <MessageInfoBar
        timestamp={timestamp}
        badge={<span data-testid="badge">max_tokens</span>}
        actions={null}
      />
    );

    expect(trigger()).toContainElement(screen.getByTestId('badge'));
  });
});

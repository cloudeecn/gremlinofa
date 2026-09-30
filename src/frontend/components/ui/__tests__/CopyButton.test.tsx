import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import CopyButton from '../CopyButton';
import { copyText } from '../../../lib/clipboard';

vi.mock('../../../lib/clipboard', () => ({ copyText: vi.fn() }));

async function click(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
  });
}

describe('CopyButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies the text it is given on click, not before', async () => {
    vi.mocked(copyText).mockResolvedValue(true);
    const getText = vi.fn(() => 'payload');
    render(<CopyButton getText={getText} label="📋" title="Copy message" />);
    expect(getText).not.toHaveBeenCalled();

    await click(screen.getByRole('button', { name: 'Copy message' }));

    expect(copyText).toHaveBeenCalledWith('payload');
  });

  it('shows ✓, then goes back to its label', async () => {
    vi.mocked(copyText).mockResolvedValue(true);
    render(<CopyButton getText={() => 'x'} label="📋" title="Copy message" />);

    await click(screen.getByRole('button'));
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveTextContent('✓');

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole('button', { name: 'Copy message' })).toHaveTextContent('📋');
  });

  it('shows ✗ when the copy fails', async () => {
    vi.mocked(copyText).mockResolvedValue(false);
    render(<CopyButton getText={() => 'x'} label="📋" title="Copy message" />);

    await click(screen.getByRole('button'));

    expect(screen.getByRole('button', { name: 'Copy failed' })).toHaveTextContent('✗');
  });

  it('does not let the click reach a clickable parent', async () => {
    vi.mocked(copyText).mockResolvedValue(true);
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <CopyButton getText={() => 'x'} label="📋" title="Copy" />
      </div>
    );

    await click(screen.getByRole('button'));

    expect(onParentClick).not.toHaveBeenCalled();
  });
});

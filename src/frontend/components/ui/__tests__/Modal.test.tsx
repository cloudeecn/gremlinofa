import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Modal from '../Modal';

describe('Modal', () => {
  it('renders nothing while closed', () => {
    render(
      <Modal isOpen={false} onClose={vi.fn()}>
        content
      </Modal>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a labelled modal dialog that takes focus', () => {
    render(
      <Modal isOpen onClose={vi.fn()} ariaLabel="Settings">
        <button>inside</button>
      </Modal>
    );
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
  });

  it('closes on Escape and on the backdrop', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal isOpen onClose={onClose}>
        content
      </Modal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(container.ownerDocument.querySelector('.bg-black\\/50')!);

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes only the inner modal of a nested pair', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const { rerender } = render(
      <Modal isOpen onClose={closeOuter} ariaLabel="outer">
        outer
      </Modal>
    );
    rerender(
      <>
        <Modal isOpen onClose={closeOuter} ariaLabel="outer">
          outer
        </Modal>
        <Modal isOpen onClose={closeInner} ariaLabel="inner">
          inner
        </Modal>
      </>
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(closeInner).toHaveBeenCalled();
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it('keeps its bottom padding on devices without a safe-area inset', () => {
    render(
      <Modal isOpen onClose={vi.fn()}>
        content
      </Modal>
    );
    const wrapper = screen.getByRole('dialog').parentElement!;
    expect(wrapper).not.toHaveClass('safe-area-inset-bottom');
    expect(wrapper.className).toContain('pb-[max(1rem,env(safe-area-inset-bottom))]');
  });
});

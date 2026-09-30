import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeleteOlderThanModal from '../DeleteOlderThanModal';
import type { AttachmentInfo, AttachmentSection } from '../../../shared/protocol/types';

const DAY_MS = 24 * 60 * 60 * 1000;

function sectionWithAgesInDays(ages: number[]): AttachmentSection {
  return {
    chatId: 'chat_1',
    chatName: 'Chat',
    chatTimestamp: new Date(),
    projectId: 'p1',
    projectName: 'Project',
    projectIcon: '📁',
    attachments: ages.map(
      (age, i) =>
        ({ id: `att_${i}`, timestamp: new Date(Date.now() - age * DAY_MS) }) as AttachmentInfo
    ),
  };
}

const sections = [sectionWithAgesInDays([1, 4, 10, 30])];
const daysInput = () => screen.getByLabelText('Delete attachments older than') as HTMLInputElement;

describe('DeleteOlderThanModal', () => {
  it('lets the day count be cleared and retyped', async () => {
    const user = userEvent.setup();
    render(
      <DeleteOlderThanModal isOpen onClose={vi.fn()} onDelete={vi.fn()} sections={sections} />
    );
    expect(daysInput().value).toBe('7');
    expect(screen.getByText('2')).toBeInTheDocument();

    await user.type(daysInput(), '{Backspace}3');
    expect(daysInput().value).toBe('3');
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('raises a zero day count to 1 on blur', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => 0);
    render(
      <DeleteOlderThanModal isOpen onClose={vi.fn()} onDelete={onDelete} sections={sections} />
    );

    await user.clear(daysInput());
    await user.type(daysInput(), '0');
    await user.tab();
    expect(daysInput().value).toBe('1');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(1);
  });

  it('previews what Delete will remove while the day field holds an out-of-range draft', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => 3);
    // Ages kept clear of the 1- and 7-day cutoffs so the counts can't flake
    const spacedSections = [sectionWithAgesInDays([0.5, 2, 10, 30])];
    render(
      <DeleteOlderThanModal
        isOpen
        onClose={vi.fn()}
        onDelete={onDelete}
        sections={spacedSections}
      />
    );
    expect(screen.getByText('2')).toBeInTheDocument();

    await user.clear(daysInput());
    await user.type(daysInput(), '0');
    // Below min: the field shows the draft, the preview already counts 1 day
    expect(daysInput().value).toBe('0');
    expect(screen.getByText('3')).toBeInTheDocument();

    // No Tab first: the click's own blur is what settles the field
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(1);
  });

  it('ignores the backdrop and Escape while deleting', async () => {
    let finishDelete: (count: number) => void = () => {};
    const onDelete = vi.fn(
      () =>
        new Promise<number>(resolve => {
          finishDelete = resolve;
        })
    );
    const onClose = vi.fn();
    render(
      <DeleteOlderThanModal isOpen onClose={onClose} onDelete={onDelete} sections={sections} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    expect(screen.getByText('Deleting...')).toBeInTheDocument();

    fireEvent.click(document.querySelector<HTMLElement>('.bg-black\\/50')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      finishDelete(2);
    });
    expect(screen.getByText('Attachments Deleted')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

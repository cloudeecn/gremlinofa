import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentSection as AttachmentSectionType } from '../../../shared/protocol/types';
import { AttachmentSection } from '../AttachmentSection';
import { AttachmentManagerView } from '../AttachmentManagerView';

vi.mock('../../client', () => ({
  gremlinClient: {
    getAllAttachmentSections: vi.fn(),
    getAttachments: vi.fn(),
    deleteAttachment: vi.fn(),
    updateMessageAttachmentIds: vi.fn(),
    deleteAttachmentsOlderThan: vi.fn(),
  },
}));

import { gremlinClient } from '../../client';

interface CapturedObserver {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  target: Element | null;
}

const makeSection = (chatId: string): AttachmentSectionType => ({
  chatId,
  chatName: `Chat ${chatId}`,
  chatTimestamp: new Date('2024-01-15'),
  projectId: 'proj_1',
  projectName: 'Project One',
  projectIcon: '📁',
  attachments: [
    { id: `${chatId}_att_1`, messageId: `${chatId}_msg_1`, timestamp: new Date('2024-01-10') },
  ],
});

describe('AttachmentSection', () => {
  let observers: CapturedObserver[];

  const fireVisibility = (observer: CapturedObserver, isIntersecting: boolean) =>
    act(() => {
      observer.callback(
        [{ isIntersecting, target: observer.target } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private captured: CapturedObserver;
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.captured = { callback, options, target: null };
          observers.push(this.captured);
        }
        observe(element: Element) {
          this.captured.target = element;
        }
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps one observer across re-renders and reports its chatId', () => {
    const onVisibilityChange = vi.fn();
    const scrollRoot = document.createElement('div');
    const props = {
      section: makeSection('chat_1'),
      loadedData: undefined,
      selectedIds: new Set<string>(),
      onToggleSelection: vi.fn(),
      onSelectAll: vi.fn(),
      onDeselectAll: vi.fn(),
      onVisibilityChange,
      scrollRoot,
    };

    const { rerender } = render(<AttachmentSection {...props} />);
    rerender(<AttachmentSection {...props} selectedIds={new Set(['chat_1_att_1'])} />);
    rerender(
      <AttachmentSection
        {...props}
        loadedData={[
          {
            id: 'chat_1_att_1',
            messageId: 'chat_1_msg_1',
            timestamp: new Date('2024-01-10'),
            mimeType: 'image/png',
            data: 'x',
          },
        ]}
      />
    );

    expect(observers).toHaveLength(1);
    expect(observers[0].options?.root).toBe(scrollRoot);

    fireVisibility(observers[0], true);
    expect(onVisibilityChange).toHaveBeenCalledWith('chat_1', true);
  });

  it('passes its chatId to select-all', () => {
    const onSelectAll = vi.fn();
    render(
      <AttachmentSection
        section={makeSection('chat_1')}
        loadedData={undefined}
        selectedIds={new Set()}
        onToggleSelection={vi.fn()}
        onSelectAll={onSelectAll}
        onDeselectAll={vi.fn()}
        onVisibilityChange={vi.fn()}
        scrollRoot={null}
      />
    );

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onSelectAll).toHaveBeenCalledWith('chat_1');
  });

  describe('inside AttachmentManagerView', () => {
    const sections = ['chat_a', 'chat_b', 'chat_c'].map(makeSection);

    beforeEach(() => {
      vi.mocked(gremlinClient.getAllAttachmentSections).mockResolvedValue(sections);
      vi.mocked(gremlinClient.getAttachments).mockImplementation(async messageId => [
        {
          id: messageId.replace('_msg_', '_att_'),
          type: 'image',
          mimeType: 'image/png',
          data: 'x',
        },
      ]);
    });

    it('does not recreate observers when the view re-renders', async () => {
      render(<AttachmentManagerView />);
      await waitFor(() => expect(observers).toHaveLength(sections.length));

      // The scroller is the observer root, so rootMargin measures against it
      const root = observers[0].options?.root;
      expect(root).toBeInstanceOf(HTMLElement);
      expect((root as HTMLElement).className).toContain('overflow-y-auto');

      // Loading data and changing the selection both re-render the view
      for (const observer of observers) fireVisibility(observer, true);
      await waitFor(() => expect(screen.getAllByAltText('Attachment')).toHaveLength(3));
      fireEvent.click(screen.getAllByRole('checkbox')[0]);
      await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument());

      expect(observers).toHaveLength(sections.length);
      expect(gremlinClient.getAttachments).toHaveBeenCalledTimes(sections.length);
    });
  });
});

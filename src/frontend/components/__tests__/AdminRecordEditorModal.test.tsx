import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdminRecordEditorModal from '../AdminRecordEditorModal';

vi.mock('../../client', () => ({
  gremlinClient: {
    adminGetRecord: vi.fn(),
    adminSaveRecord: vi.fn(),
  },
}));

vi.mock('../../lib/alerts', () => ({
  showAlert: vi.fn(),
  showDestructiveConfirm: vi.fn().mockResolvedValue(true),
}));

import { gremlinClient } from '../../client';

describe('AdminRecordEditorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Restores the JSON.parse spies even when an assertion fails first
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const loadRecord = async () => {
    vi.mocked(gremlinClient.adminGetRecord).mockResolvedValue({
      json: '{"name":"Broken Chat"}',
      compressed: false,
      encrypted: true,
      timestamp: '2026-08-22T00:00:00.000Z',
    });
    const view = render(
      <AdminRecordEditorModal isOpen onClose={vi.fn()} hasRunningLoops={false} />
    );
    fireEvent.change(screen.getByPlaceholderText('record id'), {
      target: { value: 'chat_1' },
    });
    fireEvent.click(screen.getByText('Load'));
    await waitFor(() => expect(document.querySelector('textarea')).toBeTruthy());
    return view;
  };

  it('loads and pretty-prints the record JSON', async () => {
    await loadRecord();
    expect(gremlinClient.adminGetRecord).toHaveBeenCalledWith('chats', 'chat_1');
    const textarea = document.querySelector('textarea')!;
    expect(textarea.value).toBe('{\n  "name": "Broken Chat"\n}');
    expect(screen.getByText('encrypted')).toBeTruthy();
  });

  it('disables save while the edited JSON is invalid', async () => {
    await loadRecord();
    const textarea = document.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '{broken' } });
    expect(screen.getByText(/Invalid JSON/)).toBeTruthy();
    expect((screen.getByText('Overwrite Record') as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * Records every "Invalid JSON" box React commits, including ones a later
   * render removes before any assertion could see them.
   */
  const watchInvalidJsonWarnings = () => {
    const warnings: string[] = [];
    const collect = (mutations: MutationRecord[]) => {
      for (const mutation of mutations) {
        const touched =
          mutation.type === 'characterData' ? [mutation.target] : [...mutation.addedNodes];
        for (const node of touched) {
          if (node.textContent?.includes('Invalid JSON')) warnings.push(node.textContent);
        }
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      collect(observer.takeRecords());
      observer.disconnect();
      return warnings;
    };
  };

  it('never flags a freshly loaded record as invalid', async () => {
    const stopWatching = watchInvalidJsonWarnings();
    await loadRecord();
    expect(stopWatching()).toEqual([]);
  });

  it('does not validate a newly loaded record against the previous text', async () => {
    await loadRecord();
    const textarea = document.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '{broken' } });
    expect(screen.getByText(/Invalid JSON/)).toBeTruthy();

    vi.mocked(gremlinClient.adminGetRecord).mockResolvedValue({
      json: '{"name":"Other Chat"}',
      compressed: false,
      encrypted: true,
    });
    const parseSpy = vi.spyOn(JSON, 'parse');
    const stopWatching = watchInvalidJsonWarnings();
    fireEvent.change(screen.getByPlaceholderText('record id'), { target: { value: 'chat_2' } });
    fireEvent.click(screen.getByText('Load'));
    await waitFor(() => expect(document.querySelector('textarea')!.value).toContain('Other Chat'));

    expect(stopWatching()).toEqual([]);
    expect(parseSpy).not.toHaveBeenCalledWith('{broken');
  });

  it('does not re-parse the JSON on unrelated re-renders or while closed', async () => {
    const onClose = vi.fn();
    const { rerender } = await loadRecord();
    const parseSpy = vi.spyOn(JSON, 'parse');

    rerender(<AdminRecordEditorModal isOpen onClose={onClose} hasRunningLoops />);
    rerender(<AdminRecordEditorModal isOpen onClose={onClose} hasRunningLoops={false} />);
    rerender(<AdminRecordEditorModal isOpen={false} onClose={onClose} hasRunningLoops />);
    rerender(<AdminRecordEditorModal isOpen={false} onClose={onClose} hasRunningLoops={false} />);

    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('saves compacted JSON after confirmation', async () => {
    vi.mocked(gremlinClient.adminSaveRecord).mockResolvedValue(undefined);
    await loadRecord();
    const textarea = document.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '{ "name": "Fixed" }' } });
    fireEvent.click(screen.getByText('Overwrite Record'));
    await waitFor(() =>
      expect(gremlinClient.adminSaveRecord).toHaveBeenCalledWith(
        'chats',
        'chat_1',
        '{"name":"Fixed"}'
      )
    );
  });

  it('blocks saving while loops are running', async () => {
    vi.mocked(gremlinClient.adminGetRecord).mockResolvedValue({
      json: '{}',
      compressed: false,
      encrypted: true,
    });
    render(<AdminRecordEditorModal isOpen onClose={vi.fn()} hasRunningLoops={true} />);
    fireEvent.change(screen.getByPlaceholderText('record id'), {
      target: { value: 'chat_1' },
    });
    fireEvent.click(screen.getByText('Load'));
    await waitFor(() => expect(document.querySelector('textarea')).toBeTruthy());
    expect((screen.getByText('Overwrite Record') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Stop all running loops/)).toBeTruthy();
  });
});

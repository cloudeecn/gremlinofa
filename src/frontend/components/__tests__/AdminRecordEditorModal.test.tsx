import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  const loadRecord = async () => {
    vi.mocked(gremlinClient.adminGetRecord).mockResolvedValue({
      json: '{"name":"Broken Chat"}',
      compressed: false,
      encrypted: true,
      timestamp: '2026-08-22T00:00:00.000Z',
    });
    render(<AdminRecordEditorModal isOpen onClose={vi.fn()} hasRunningLoops={false} />);
    fireEvent.change(screen.getByPlaceholderText('record id'), {
      target: { value: 'chat_1' },
    });
    fireEvent.click(screen.getByText('Load'));
    await waitFor(() => expect(document.querySelector('textarea')).toBeTruthy());
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import ChatInput from '../ChatInput';
import type { ChatInputHandle, ChatInputProps } from '../types';
import type { MessageAttachment } from '../../../../shared/protocol/types';

const touch = vi.hoisted(() => ({ isTouch: false }));
vi.mock('../../../hooks/useIsTouchDevice', () => ({ useIsTouchDevice: () => touch.isTouch }));

const attachment: MessageAttachment = {
  id: 'att_1',
  type: 'image',
  mimeType: 'image/png',
  data: 'AAAA',
};

function props(overrides: Partial<ChatInputProps> = {}): ChatInputProps {
  return {
    value: '',
    onChange: vi.fn(),
    onSend: vi.fn(),
    sendDisabled: false,
    attachments: [],
    onFilesAdded: vi.fn(),
    onRemoveAttachment: vi.fn(),
    ...overrides,
  };
}

const textarea = () => screen.getByRole('textbox', { name: 'Message' });
const pressEnter = () => fireEvent.keyDown(textarea(), { key: 'Enter' });

function paste(files: File[], text = '') {
  const event = createEvent.paste(textarea(), {
    clipboardData: { files, items: [], getData: () => text },
  });
  fireEvent(textarea(), event);
  return event;
}

describe('ChatInput', () => {
  beforeEach(() => {
    touch.isTouch = false;
  });

  it('keeps the textarea and 📎 usable while a reply runs; Stop takes Send’s place', () => {
    const onRequestSoftStop = vi.fn();
    render(<ChatInput {...props({ value: 'next', sendDisabled: true, onRequestSoftStop })} />);

    expect(textarea()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Attach images' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop after current step' }));
    expect(onRequestSoftStop).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('Enter does not send while sending is blocked', () => {
    const onSend = vi.fn();
    render(<ChatInput {...props({ value: 'next', sendDisabled: true, onSend })} />);
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Enter sends whatever the Send button would: text, images only, or pending tools only', () => {
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput {...props({ value: 'hi', onSend })} />);
    pressEnter();

    rerender(<ChatInput {...props({ attachments: [attachment], onSend })} />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    pressEnter();

    rerender(<ChatInput {...props({ hasPendingToolCalls: true, onSend })} />);
    expect(screen.getByRole('button', { name: 'Resolve pending tool calls' })).toBeEnabled();
    pressEnter();

    expect(onSend).toHaveBeenCalledTimes(3);
  });

  it('Enter with nothing to send does nothing', () => {
    const onSend = vi.fn();
    render(<ChatInput {...props({ value: '   ', onSend })} />);
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('Enter inserts a newline on touch screens', () => {
    touch.isTouch = true;
    const onSend = vi.fn();
    render(<ChatInput {...props({ value: 'hi', onSend })} />);
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('attaches a pasted screenshot', () => {
    const onFilesAdded = vi.fn();
    render(<ChatInput {...props({ onFilesAdded })} />);
    const image = new File(['png'], 'shot.png', { type: 'image/png' });

    const event = paste([image]);

    expect(onFilesAdded).toHaveBeenCalledWith([image]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('lets the text of a rich paste through alongside its image', () => {
    const onFilesAdded = vi.fn();
    render(<ChatInput {...props({ onFilesAdded })} />);

    const event = paste([new File(['png'], 'img.png', { type: 'image/png' })], 'caption');

    expect(onFilesAdded).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves a plain text paste alone', () => {
    const onFilesAdded = vi.fn();
    render(<ChatInput {...props({ onFilesAdded })} />);

    const event = paste([], 'just text');

    expect(onFilesAdded).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('checks files dropped elsewhere through the ref, reporting rejects inline', () => {
    const onFilesAdded = vi.fn();
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput {...props({ onFilesAdded, ref })} />);
    const image = new File(['png'], 'shot.png', { type: 'image/png' });

    act(() =>
      ref.current!.addFiles([image, new File(['x'], 'doc.pdf', { type: 'application/pdf' })])
    );

    expect(onFilesAdded).toHaveBeenCalledWith([image]);
    expect(screen.getByText('Only image files are allowed')).toBeInTheDocument();
  });

  it('keeps focus in the textarea when Send is clicked', () => {
    render(<ChatInput {...props({ value: 'hi' })} />);
    const mouseDown = createEvent.mouseDown(screen.getByRole('button', { name: 'Send message' }));
    fireEvent(screen.getByRole('button', { name: 'Send message' }), mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
  });

  it('puts focus back in the textarea when a reply ends and nothing else has it', () => {
    const { rerender } = render(<ChatInput {...props({ sendDisabled: true })} />);
    expect(document.activeElement).toBe(document.body);

    rerender(<ChatInput {...props({ sendDisabled: false })} />);

    expect(textarea()).toHaveFocus();
  });

  it('does not grab focus on touch screens (it would pop the keyboard)', () => {
    touch.isTouch = true;
    const { rerender } = render(<ChatInput {...props({ sendDisabled: true })} />);

    rerender(<ChatInput {...props({ sendDisabled: false })} />);

    expect(textarea()).not.toHaveFocus();
  });

  it('does not take focus from another control', () => {
    const { rerender } = render(
      <>
        <button>elsewhere</button>
        <ChatInput {...props({ sendDisabled: true })} />
      </>
    );
    screen.getByRole('button', { name: 'elsewhere' }).focus();

    rerender(
      <>
        <button>elsewhere</button>
        <ChatInput {...props({ sendDisabled: false })} />
      </>
    );

    expect(screen.getByRole('button', { name: 'elsewhere' })).toHaveFocus();
  });

  it('lets the textarea grow taller on desktop', () => {
    render(<ChatInput {...props()} />);
    expect(textarea()).toHaveClass('max-h-[120px]', 'md:max-h-[40dvh]');
  });
});

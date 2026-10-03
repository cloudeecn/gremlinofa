import { describe, it, expect, vi } from 'vitest';
import { createRef, useState, type RefObject } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../DropdownMenu';

function TestMenu({
  onAction = () => {},
  buttonRef,
}: {
  onAction?: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [isOn, setIsOn] = useState(false);
  return (
    <div>
      <p>Outside</p>
      <DropdownMenu label="Test menu" icon="⋯" buttonRef={buttonRef}>
        <DropdownMenuItem checked={isOn} onSelect={() => setIsOn(prev => !prev)}>
          Toggle
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon="🗑️" destructive disabled onSelect={() => {}}>
          Disabled
        </DropdownMenuItem>
        <DropdownMenuItem icon="🏠" onSelect={onAction}>
          Action
        </DropdownMenuItem>
      </DropdownMenu>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Test menu' });

describe('DropdownMenu', () => {
  it('opens and closes from its trigger', () => {
    render(<TestMenu />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Test menu' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();

    fireEvent.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes after an action item, which runs once', () => {
    const onAction = vi.fn();
    render(<TestMenu onAction={onAction} />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Action' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open on a checkbox item and reports its state', () => {
    render(<TestMenu />);
    fireEvent.click(trigger());

    const toggle = screen.getByRole('menuitemcheckbox', { name: 'Toggle' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);

    expect(screen.getByRole('menuitemcheckbox', { name: 'Toggle' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'Toggle' })).toHaveTextContent('✓');
  });

  it('ignores a disabled item', () => {
    render(<TestMenu />);
    fireEvent.click(trigger());

    const disabled = screen.getByRole('menuitem', { name: 'Disabled' });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the trigger', () => {
    render(<TestMenu />);
    fireEvent.click(trigger());

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('closes on a press outside, not on one inside', () => {
    render(<TestMenu />);
    fireEvent.click(trigger());

    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('Outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves between enabled items with the arrow keys, Home and End', () => {
    render(<TestMenu />);
    fireEvent.click(trigger());
    const menu = screen.getByRole('menu');
    const toggle = screen.getByRole('menuitemcheckbox', { name: 'Toggle' });
    const action = screen.getByRole('menuitem', { name: 'Action' });

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(toggle).toHaveFocus();
    // Skips the disabled item
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(action).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(toggle).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(action).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(toggle).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(action).toHaveFocus();
  });

  it("uses the caller's ref for the trigger", () => {
    const buttonRef = createRef<HTMLButtonElement>();
    render(<TestMenu buttonRef={buttonRef} />);
    expect(buttonRef.current).toBe(trigger());
  });
});

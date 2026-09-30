import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NumberInput from '../NumberInput';

function Harness({
  initial = 5,
  min,
  max,
  onCommit = () => {},
}: {
  initial?: number;
  min?: number;
  max?: number;
  onCommit?: (value: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <NumberInput
        aria-label="Amount"
        value={value}
        min={min}
        max={max}
        integer
        onChange={next => {
          onCommit(next);
          setValue(next);
        }}
      />
      <output data-testid="committed">{value}</output>
      <button type="button" onClick={() => setValue(42)}>
        Reset elsewhere
      </button>
    </>
  );
}

const input = () => screen.getByLabelText('Amount') as HTMLInputElement;
const committed = () => screen.getByTestId('committed').textContent;

describe('NumberInput', () => {
  it('lets the field be cleared and retyped', async () => {
    const user = userEvent.setup();
    render(<Harness initial={5} />);

    await user.clear(input());
    expect(input().value).toBe('');
    expect(committed()).toBe('5');

    await user.type(input(), '7');
    expect(input().value).toBe('7');
    expect(committed()).toBe('7');
  });

  it('backspace then type replaces the number instead of appending to it', async () => {
    const user = userEvent.setup();
    render(<Harness initial={5} />);

    await user.type(input(), '{Backspace}8');
    expect(input().value).toBe('8');
    expect(committed()).toBe('8');
  });

  it('commits an out-of-range draft clamped while typing and shows the clamp on blur', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness initial={5} max={10} onCommit={onCommit} />);

    await user.clear(input());
    await user.type(input(), '99');
    // The text stays as typed, but the committed value is already what blur
    // will settle to
    expect(input().value).toBe('99');
    expect(committed()).toBe('10');
    expect(onCommit).not.toHaveBeenCalledWith(99);

    await user.tab();
    expect(input().value).toBe('10');
    expect(committed()).toBe('10');
    expect(onCommit).toHaveBeenLastCalledWith(10);
  });

  it('clamps up to min', async () => {
    const user = userEvent.setup();
    render(<Harness initial={20000} min={10000} />);

    await user.clear(input());
    await user.type(input(), '60');
    expect(input().value).toBe('60');
    expect(committed()).toBe('10000');

    await user.tab();
    expect(input().value).toBe('10000');
    expect(committed()).toBe('10000');
  });

  it('keeps the last commit while the draft does not parse, and reverts to it on blur', async () => {
    const user = userEvent.setup();
    render(<Harness initial={5} min={1} />);

    await user.clear(input());
    await user.type(input(), '0');
    expect(committed()).toBe('1');

    await user.clear(input());
    expect(committed()).toBe('1');
    await user.tab();
    expect(input().value).toBe('1');
  });

  it('reverts an empty field to the current value on blur', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness initial={5} onCommit={onCommit} />);

    await user.clear(input());
    await user.tab();
    expect(input().value).toBe('5');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('truncates a fraction in integer mode', async () => {
    const user = userEvent.setup();
    render(<Harness initial={5} />);

    await user.clear(input());
    await user.type(input(), '3.7');
    await user.tab();
    expect(input().value).toBe('3');
    expect(committed()).toBe('3');
  });

  it('shows a value that changes from outside while not focused', async () => {
    const user = userEvent.setup();
    render(<Harness initial={5} />);

    await user.click(screen.getByRole('button', { name: 'Reset elsewhere' }));
    expect(input().value).toBe('42');
  });

  it('passes id, className, aria-* and disabled through', () => {
    render(
      <NumberInput
        id="n"
        className="w-20"
        aria-describedby="hint"
        disabled
        value={1}
        onChange={() => {}}
      />
    );
    const el = screen.getByRole('spinbutton');
    expect(el).toHaveAttribute('id', 'n');
    expect(el).toHaveClass('w-20');
    expect(el).toHaveAttribute('aria-describedby', 'hint');
    expect(el).toBeDisabled();
  });
});

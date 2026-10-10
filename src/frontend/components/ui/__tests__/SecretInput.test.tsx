import { describe, it, expect, vi } from 'vitest';
import { useState, type FormEvent } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SecretInput from '../SecretInput';

function Harness({ onCommit = () => {} }: { onCommit?: (value: string) => void }) {
  const [value, setValue] = useState('hunter2');
  return (
    <>
      <label htmlFor="secret">API password</label>
      <SecretInput
        id="secret"
        label="API password"
        value={value}
        onChange={next => {
          onCommit(next);
          setValue(next);
        }}
      />
    </>
  );
}

const input = () => screen.getByLabelText('API password') as HTMLInputElement;

describe('SecretInput', () => {
  it('starts masked and opts out of saved-login autofill', () => {
    render(<Harness />);

    expect(input().type).toBe('password');
    expect(input().value).toBe('hunter2');
    expect(input().autocomplete).toBe('new-password');
  });

  it('reveals and hides the value with an accessible toggle', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Show API password' }));
    expect(input().type).toBe('text');

    await user.click(screen.getByRole('button', { name: 'Hide API password' }));
    expect(input().type).toBe('password');
  });

  it('reports typed text through onChange', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onCommit={onCommit} />);

    await user.clear(input());
    await user.type(input(), 'swordfish');

    expect(input().value).toBe('swordfish');
    expect(onCommit).toHaveBeenLastCalledWith('swordfish');
  });

  it('does not submit an enclosing form', async () => {
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    const user = userEvent.setup();
    render(
      <form onSubmit={onSubmit}>
        <SecretInput aria-label="Token" label="Token" value="" onChange={() => {}} />
      </form>
    );

    await user.click(screen.getByRole('button', { name: 'Show Token' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

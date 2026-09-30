import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { AlertProvider } from '../AlertProvider';
import { useAlert } from '../../hooks/useAlert';

type Kind = 'alert' | 'confirm' | 'destructive';

function Trigger({ kind }: { kind: Kind }) {
  const { showAlert, showConfirm, showDestructiveConfirm } = useAlert();
  const [result, setResult] = useState('pending');
  const open = async () => {
    if (kind === 'alert') {
      await showAlert('Heads up', 'Something happened');
      setResult('dismissed');
    } else {
      const confirmed = await (kind === 'confirm' ? showConfirm : showDestructiveConfirm)(
        'Delete chat?',
        'This cannot be undone.',
        'Delete'
      );
      setResult(String(confirmed));
    }
  };
  return (
    <>
      <button onClick={open}>open</button>
      <span data-testid="result">{result}</span>
    </>
  );
}

function renderTrigger(kind: Kind) {
  render(
    <AlertProvider>
      <Trigger kind={kind} />
    </AlertProvider>
  );
  const opener = screen.getByRole('button', { name: 'open' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('AlertProvider dialogs', () => {
  it('is an alertdialog labelled by its title and described by its message', () => {
    renderTrigger('confirm');

    const dialog = screen.getByRole('alertdialog', { name: 'Delete chat?' });
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('wraps unbreakable tokens in the message, so a long chat name stays inside the dialog', () => {
    renderTrigger('confirm');
    expect(screen.getByText('This cannot be undone.')).toHaveClass('break-words');
  });

  it('starts a destructive confirm on Cancel, so Enter cannot delete', () => {
    renderTrigger('destructive');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('starts a normal confirm on its confirm button', () => {
    renderTrigger('confirm');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('Escape cancels a confirm and returns focus to the opener', async () => {
    const opener = renderTrigger('destructive');

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('result')).toHaveTextContent('false');
    expect(opener).toHaveFocus();
  });

  it('Escape dismisses an alert', async () => {
    renderTrigger('alert');
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(screen.getByTestId('result')).toHaveTextContent('dismissed');
  });

  it('keeps the context value when a dialog opens and closes', async () => {
    const values: unknown[] = [];
    function Probe() {
      values.push(useAlert());
      return null;
    }
    render(
      <AlertProvider>
        <Trigger kind="alert" />
        <Probe />
      </AlertProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });

    // Probe renders once: the provider's dialog state changes don't reach it
    expect(values).toHaveLength(1);
  });
});

describe('AlertProvider queue', () => {
  function QueueTrigger({ run }: { run: (dialogs: ReturnType<typeof useAlert>) => Promise<void> }) {
    const dialogs = useAlert();
    return <button onClick={() => void run(dialogs)}>run</button>;
  }

  function renderQueue(run: (dialogs: ReturnType<typeof useAlert>) => Promise<void>) {
    render(
      <AlertProvider>
        <QueueTrigger run={run} />
      </AlertProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'run' }));
  }

  const ok = () =>
    act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });

  it('shows two alerts opened in the same tick one after the other, settling both', async () => {
    const settled: string[] = [];
    renderQueue(async ({ showAlert }) => {
      void showAlert('First', 'one').then(() => settled.push('first'));
      void showAlert('Second', 'two').then(() => settled.push('second'));
    });

    expect(screen.getByRole('alertdialog', { name: 'First' })).toBeInTheDocument();
    await ok();
    expect(screen.getByRole('alertdialog', { name: 'Second' })).toBeInTheDocument();
    await ok();

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(settled).toEqual(['first', 'second']);
  });

  it('shows an alert opened right after the previous one was dismissed', async () => {
    let done = false;
    renderQueue(async ({ showAlert }) => {
      await showAlert('First', 'one');
      await showAlert('Second', 'two');
      done = true;
    });

    await ok();
    expect(screen.getByRole('alertdialog', { name: 'Second' })).toBeInTheDocument();
    await ok();
    expect(done).toBe(true);
  });

  it('resolves queued confirms with their own answers', async () => {
    const answers: boolean[] = [];
    renderQueue(async ({ showConfirm }) => {
      void showConfirm('Keep?', 'first').then(answer => answers.push(answer));
      void showConfirm('Drop?', 'second').then(answer => answers.push(answer));
    });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));

    expect(answers).toEqual([true, false]);
  });

  it('settles a dialog once under a double click', async () => {
    const settled: string[] = [];
    renderQueue(async ({ showAlert }) => {
      void showAlert('First', 'one').then(() => settled.push('first'));
      void showAlert('Second', 'two').then(() => settled.push('second'));
    });

    const button = screen.getByRole('button', { name: 'OK' });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(screen.getByRole('alertdialog', { name: 'Second' })).toBeInTheDocument();
    expect(settled).toEqual(['first']);
  });
});

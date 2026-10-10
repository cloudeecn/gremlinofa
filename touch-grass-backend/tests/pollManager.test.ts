import { beforeEach, describe, expect, it } from 'vitest';
import { createPollRegistry, type PollRegistry } from '../src/pollManager.js';

describe('createPollRegistry', () => {
  let polls: PollRegistry;
  beforeEach(() => {
    polls = createPollRegistry();
  });

  it('wakes every waiter on a request and only that request', async () => {
    const first = polls.waitForOutcome('req-a', 5000);
    const second = polls.waitForOutcome('req-a', 5000);
    const other = polls.waitForOutcome('req-b', 5000);
    expect(polls.countWaiters('req-a')).toBe(2);

    expect(polls.notifyAnswered('req-a', 'yes')).toBe(2);
    expect(await first.promise).toEqual({ kind: 'answered', content: 'yes' });
    expect(await second.promise).toEqual({ kind: 'answered', content: 'yes' });
    expect(polls.countWaiters('req-a')).toBe(0);
    expect(polls.countWaiters('req-b')).toBe(1);

    other.cancel();
  });

  it('reports expired and gone outcomes', async () => {
    const expired = polls.waitForOutcome('req-c', 5000);
    polls.notifyExpired('req-c', 'cancelled');
    expect(await expired.promise).toEqual({ kind: 'expired', reason: 'cancelled' });

    const gone = polls.waitForOutcome('req-d', 5000);
    polls.notifyGone('req-d');
    expect(await gone.promise).toEqual({ kind: 'gone' });
  });

  it('times out and removes itself', async () => {
    const wait = polls.waitForOutcome('req-e', 20);
    expect(await wait.promise).toEqual({ kind: 'timeout' });
    expect(polls.countWaiters('req-e')).toBe(0);
  });

  it('cancel settles as detached and leaves other waiters alone', async () => {
    const leaving = polls.waitForOutcome('req-f', 5000);
    const staying = polls.waitForOutcome('req-f', 5000);

    leaving.cancel();
    leaving.cancel();
    expect(await leaving.promise).toEqual({ kind: 'detached' });
    expect(polls.countWaiters('req-f')).toBe(1);

    expect(polls.notifyAnswered('req-f', 'ok')).toBe(1);
    expect(await staying.promise).toEqual({ kind: 'answered', content: 'ok' });
  });

  it('returns 0 when nobody is waiting', () => {
    expect(polls.notifyAnswered('nobody', 'hello')).toBe(0);
    expect(polls.countWaiters()).toBe(0);
  });

  it('cancelAll releases its own waiters for good and leaves other registries alone', async () => {
    const neighbor = createPollRegistry();
    const held = [polls.waitForOutcome('req-g', 5000), polls.waitForOutcome('req-h', 5000)];
    const elsewhere = neighbor.waitForOutcome('req-g', 5000);

    expect(polls.cancelAll()).toBe(2);
    for (const wait of held) {
      expect(await wait.promise).toEqual({ kind: 'shutdown' });
    }
    expect(await polls.waitForOutcome('late', 5000).promise).toEqual({ kind: 'shutdown' });
    expect(polls.countWaiters()).toBe(0);

    expect(neighbor.countWaiters('req-g')).toBe(1);
    expect(neighbor.notifyAnswered('req-g', 'still here')).toBe(1);
    expect(await elsewhere.promise).toEqual({ kind: 'answered', content: 'still here' });
  });
});

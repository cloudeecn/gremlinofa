import { describe, it, expect } from 'vitest';
import { withTreeLock } from '../treeLock';

describe('withTreeLock', () => {
  it('serializes concurrent operations on the same projectId', async () => {
    const order: number[] = [];

    const op = (id: number, delay: number) =>
      withTreeLock('proj1', async () => {
        order.push(id);
        await new Promise(r => setTimeout(r, delay));
        order.push(id * 10);
      });

    // Start three operations concurrently
    await Promise.all([op(1, 30), op(2, 10), op(3, 5)]);

    // FIFO: op1 runs to completion, then op2, then op3
    expect(order).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it('allows parallel operations on different projectIds', async () => {
    const order: string[] = [];

    const op = (proj: string, id: string, delay: number) =>
      withTreeLock(proj, async () => {
        order.push(`${id}-start`);
        await new Promise(r => setTimeout(r, delay));
        order.push(`${id}-end`);
      });

    await Promise.all([op('projA', 'a', 30), op('projB', 'b', 10)]);

    // Both start immediately (different projects, no contention)
    expect(order[0]).toBe('a-start');
    expect(order[1]).toBe('b-start');
    // b finishes first (shorter delay)
    expect(order[2]).toBe('b-end');
    expect(order[3]).toBe('a-end');
  });

  it('releases lock when function throws', async () => {
    const order: number[] = [];

    const failing = withTreeLock('proj-err', async () => {
      order.push(1);
      throw new Error('boom');
    });

    await expect(failing).rejects.toThrow('boom');

    // Lock should be released — next operation proceeds immediately
    await withTreeLock('proj-err', async () => {
      order.push(2);
    });

    expect(order).toEqual([1, 2]);
  });

  it('returns the value from the wrapped function', async () => {
    const result = await withTreeLock('proj-ret', async () => 42);
    expect(result).toBe(42);
  });

  it('maintains FIFO order under contention', async () => {
    const order: number[] = [];
    const count = 10;

    const ops = Array.from({ length: count }, (_, i) =>
      withTreeLock('proj-fifo', async () => {
        order.push(i);
      })
    );

    await Promise.all(ops);
    expect(order).toEqual(Array.from({ length: count }, (_, i) => i));
  });
});

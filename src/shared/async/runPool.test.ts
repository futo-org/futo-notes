import { describe, it, expect } from 'vitest';
import { runPool } from './runPool';

describe('runPool', () => {
  it('handles empty input without running the worker', async () => {
    let calls = 0;
    await runPool([], 8, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it('invokes the worker once per item with its index', async () => {
    const seen: Array<[number, number]> = [];
    await runPool([10, 20, 30, 40], 2, async (item, index) => {
      seen.push([item, index]);
    });
    seen.sort((a, b) => a[1] - b[1]);
    expect(seen).toEqual([
      [10, 0],
      [20, 1],
      [30, 2],
      [40, 3],
    ]);
  });

  it('caps concurrency at the pool size', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runPool(items, 4, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('caps pool size at the number of items when concurrency is larger', async () => {
    let active = 0;
    let maxActive = 0;
    await runPool([1, 2], 16, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('treats concurrency <= 0 as 1 worker', async () => {
    let maxActive = 0;
    let active = 0;
    await runPool([1, 2, 3], 0, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    expect(maxActive).toBe(1);
  });

  it('rejects when a worker throws', async () => {
    await expect(
      runPool([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

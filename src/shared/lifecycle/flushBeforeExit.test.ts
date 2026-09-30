import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushPendingSaveBeforeExit, registerExitFlushSource } from './flushBeforeExit';

describe('flushPendingSaveBeforeExit', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves at once when nothing is registered', async () => {
    await expect(flushPendingSaveBeforeExit()).resolves.toBeUndefined();
  });

  it('waits for the registered save', async () => {
    let done = false;
    const unregister = registerExitFlushSource({
      flushSave: async () => {
        await Promise.resolve();
        done = true;
      },
    });
    await flushPendingSaveBeforeExit();
    unregister();
    expect(done).toBe(true);
  });

  it('gives up on a save that never finishes after 3 s, and on one that throws', async () => {
    vi.useFakeTimers();
    const unregister = registerExitFlushSource({ flushSave: () => new Promise<void>(() => {}) });
    const hung = flushPendingSaveBeforeExit();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(hung).resolves.toBeUndefined();
    unregister();

    const failing = registerExitFlushSource({
      flushSave: async () => {
        throw new Error('disk full');
      },
    });
    await expect(flushPendingSaveBeforeExit()).resolves.toBeUndefined();
    failing();
  });

  it('forgets a source that was replaced', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const unregisterFirst = registerExitFlushSource({ flushSave: first });
    const unregisterSecond = registerExitFlushSource({ flushSave: second });
    unregisterFirst();
    await flushPendingSaveBeforeExit();
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    unregisterSecond();
  });

  it('waits past the race for a write that is still running, up to 15 s', async () => {
    vi.useFakeTimers();
    let writing = true;
    let finish!: () => void;
    const unregister = registerExitFlushSource({
      isSavePending: () => writing,
      flushSave: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            writing = false;
            resolve();
          };
        }),
    });
    let done = false;
    const drained = flushPendingSaveBeforeExit().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(false);
    finish();
    await drained;
    expect(done).toBe(true);

    writing = true;
    const stuck = flushPendingSaveBeforeExit();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(stuck).resolves.toBeUndefined();
    unregister();
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import { createBench } from './block-drag-bench/bench';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reports a stalled compositor during editor startup instead of awaiting the host timeout', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 7),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const bench = createBench({ view: () => null, setContent: vi.fn() });
  const outcome = Promise.race([
    bench.runPlan({}).then(
      () => 'completed',
      (error) => error.message,
    ),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2500)),
  ]);
  await vi.advanceTimersByTimeAsync(2500);
  expect(await outcome).toMatch(/no animation frame.*locked|no animation frame.*occluded/i);
});

it('returns the delivered frame time and cancels its timeout after success', async () => {
  const { nextBenchFrame } = await import('./frame-clock');
  vi.useFakeTimers();
  let deliver;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback) => {
      deliver = callback;
      return 8;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const pending = nextBenchFrame();
  deliver(17);
  expect(await pending).toBe(17);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels the pending frame when the compositor stalls', async () => {
  const { nextBenchFrame } = await import('./frame-clock');
  vi.useFakeTimers();
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 9),
  );
  const cancel = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancel);
  const outcome = nextBenchFrame().catch((error) => error);
  await vi.advanceTimersByTimeAsync(1200);
  expect(await outcome).toBeInstanceOf(Error);
  expect(cancel).toHaveBeenCalledWith(9);
});

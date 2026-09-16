// @vitest-environment jsdom
/*
 * Regression test for pipeline 36487's `test` job: 11 uncaught
 * `ReferenceError: removeEventListener is not defined` exceptions, each
 * attributed to whatever file happened to be running ~3s after some OTHER
 * file built a real Milkdown editor. See `noLeakedCtxTimers.ts`'s header for
 * the full mechanism. This drives the same `@milkdown/ctx` primitives a real
 * `Editor` does (with a short timeout instead of the fixed 3000ms default,
 * so the test is fast) rather than a full `Editor.make()`, to isolate the
 * timer leak from everything else a real editor does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Clock, Container, Ctx, createTimer } from '@milkdown/ctx';

import { withoutLeakedCtxTimers } from './noLeakedCtxTimers';

/** What vitest's jsdom-environment teardown does to this global between test files. */
function simulateJsdomTeardown(): () => void {
  const real = globalThis.removeEventListener;
  // @ts-expect-error simulating environment teardown, not a real unset
  delete globalThis.removeEventListener;
  return () => {
    globalThis.removeEventListener = real;
  };
}

async function settleAndDoneOneGate(ctx: Ctx, timeoutMs: number) {
  const gate = createTimer('ProbeGate', timeoutMs);
  ctx.record(gate);
  const waitPromise = ctx.wait(gate); // Timer#start(): addEventListener + setTimeout(timeoutMs)
  ctx.done(gate); // resolves waitPromise via the CustomEvent branch, well before timeoutMs
  await waitPromise;
  ctx.clearTimer(gate); // exactly what editor.destroy() calls — forgets Clock bookkeeping only
}

describe('withoutLeakedCtxTimers', () => {
  let restoreGlobals: (() => void) | undefined;
  let uncaught: unknown[];
  let onUncaught: (err: unknown) => void;

  afterEach(() => {
    restoreGlobals?.();
    restoreGlobals = undefined;
    process.off('uncaughtException', onUncaught);
  });

  it('documents the bug: an unwrapped ctx gate leaks a native timer that throws once its global is gone', async () => {
    const ctx = new Ctx(new Container(), new Clock());
    await settleAndDoneOneGate(ctx, 30);

    uncaught = [];
    onUncaught = (err) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    restoreGlobals = simulateJsdomTeardown();

    await new Promise((resolve) => setTimeout(resolve, 80)); // past the 30ms deadline

    expect(uncaught).toHaveLength(1);
    expect(String((uncaught[0] as Error).message)).toContain('removeEventListener is not defined');
  });

  it('fixes it: wrapping the gate cancels the native timer so nothing fires later', async () => {
    const ctx = new Ctx(new Container(), new Clock());
    await withoutLeakedCtxTimers(() => settleAndDoneOneGate(ctx, 30));

    uncaught = [];
    onUncaught = (err) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    restoreGlobals = simulateJsdomTeardown();

    await new Promise((resolve) => setTimeout(resolve, 80)); // past the same 30ms deadline

    expect(uncaught).toEqual([]);
  });
});

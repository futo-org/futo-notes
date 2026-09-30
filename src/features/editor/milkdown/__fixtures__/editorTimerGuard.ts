/*
 * Guards against a second `MilkdownEditor` test-teardown leak, the sibling of
 * `noLeakedCtxTimers.ts` (RC-66: MR !360's `test` job failed on an unhandled
 * `ReferenceError: Element is not defined` although all 2831 tests passed).
 *
 * The mechanism: `MilkdownEditor.svelte` nudges `@milkdown/plugin-block`'s
 * hover handle with a synthetic `pointermove` on every selection change
 * (`nudgeBlockHandle`). The plugin runs its hit-test through a lodash-es
 * `throttle(…, 200)`, so a burst of caret moves leaves ONE trailing call
 * pending on a native timer that nothing owns — the throttle is private to the
 * plugin's `BlockService`, `editor.destroy()` never reaches it, and neither
 * does unmounting the component. When it fires it evaluates the bare global
 * `Element` (`elementFromPoint(…) instanceof Element`). That is harmless while
 * the file's jsdom environment is alive; if the file has finished, vitest's
 * environment teardown has deleted the global and the call throws — reported
 * against whichever file the worker is running by then, which is why the same
 * suite passes for days and then fails one job. (jsdom can measure a caret only
 * inside an EMPTY paragraph, so the nudge only takes effect for tests that
 * put the caret there — dividerCaret.test.ts's `---` cases do, every time.)
 *
 * The fix is to make sure the test never leaves a native timer behind:
 * `guardEditorTimers()` (call it once at the top of a test file that mounts
 * `MilkdownEditor.svelte`) records every `setTimeout` a test schedules and
 * cancels whatever is still pending when the test ends. By then every
 * assertion has run, so a debounce whose only job was to notify a component
 * that is about to be discarded has nothing left to say.
 */
import { afterEach, beforeEach } from 'vitest';

export interface EditorTimerTracker {
  /** Timers scheduled since tracking began and neither fired nor cleared yet. */
  readonly pending: Set<ReturnType<typeof setTimeout>>;
  restore: () => void;
}

/** Starts recording every `setTimeout` from here on; pair with `cancelStrayEditorTimers`. */
export function trackEditorTimers(): EditorTimerTracker {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id: ReturnType<typeof setTimeout> = realSetTimeout(
      ((...callArgs: unknown[]) => {
        pending.delete(id);
        (handler as (...a: unknown[]) => void)(...callArgs);
      }) as never,
      timeout,
      ...args,
    );
    pending.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) pending.delete(id);
    realClearTimeout(id);
  }) as typeof clearTimeout;
  return {
    pending,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** Stops recording and cancels every timer that is still pending. */
export function cancelStrayEditorTimers(tracker: EditorTimerTracker): void {
  tracker.restore();
  for (const id of tracker.pending) clearTimeout(id);
  tracker.pending.clear();
}

/** Registers the per-test guard. Call once, at module scope, in the test file. */
export function guardEditorTimers(): void {
  let tracker: EditorTimerTracker | undefined;
  beforeEach(() => {
    tracker = trackEditorTimers();
  });
  afterEach(() => {
    if (tracker) cancelStrayEditorTimers(tracker);
    tracker = undefined;
  });
}

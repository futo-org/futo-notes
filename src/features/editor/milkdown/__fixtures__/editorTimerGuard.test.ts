// @vitest-environment jsdom
/*
 * RC-66 (MR !360, pipeline 37111): the `test` job failed on an unhandled
 * `ReferenceError: Element is not defined` although every test passed. The
 * stack was `@milkdown/plugin-block` lib/index.js:166 (the pointermove hover
 * hit-test) via lodash-es `throttle`, reported against whatever file happened
 * to be running — see `editorTimerGuard.ts` for the mechanism.
 *
 * This drives a REAL `MilkdownEditor` the way `dividerCaret.test.ts` does: two
 * caret moves inside the throttle window, so the second pointermove nudge is
 * left as a pending 200 ms trailing call. The first case is the bug, the
 * second is the guard that fixes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { withoutLeakedCtxTimers } from './noLeakedCtxTimers';
import { cancelStrayEditorTimers, trackEditorTimers } from './editorTimerGuard';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

interface EditorHandle {
  getProseMirrorView: () => EditorView | null;
}

const MilkdownEditor = (await import('../MilkdownEditor.svelte')).default;

/** What vitest's jsdom-environment teardown does to these globals between files. */
function simulateJsdomTeardown(): () => void {
  const real = globalThis.Element;
  // @ts-expect-error simulating environment teardown, not a real unset
  delete globalThis.Element;
  return () => {
    globalThis.Element = real;
  };
}

/** Mounts a real editor and leaves a throttled hover call pending. */
async function mountAndLeaveHoverPending(): Promise<EditorHandle> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  // jsdom has no hit testing; the leading call needs an answer (not a throw).
  document.elementFromPoint = () => null;
  const handle = await withoutLeakedCtxTimers(async () => {
    const mounted = mount(MilkdownEditor, {
      target,
      props: { content: '', onchange: () => {} },
    }) as unknown as EditorHandle;
    await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull(), {
      timeout: 30_000,
    });
    return mounted;
  });
  const view = handle.getProseMirrorView()!;
  // Each selection move onto an EMPTY paragraph (the one place jsdom can
  // measure a caret, so the nudge does not bail out) sends a synthetic
  // pointermove: the first runs the throttled hit-test immediately, the rest
  // are deferred to one trailing call 200 ms out.
  view.dispatch(view.state.tr.split(1));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
  return handle;
}

describe('a real editor leaves a pending block-hover throttle call (RC-66)', () => {
  let restoreGlobals: (() => void) | undefined;
  let uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);

  afterEach(() => {
    restoreGlobals?.();
    restoreGlobals = undefined;
    process.off('uncaughtException', onUncaught);
  });

  async function outliveTeardown(): Promise<void> {
    uncaught = [];
    process.on('uncaughtException', onUncaught);
    restoreGlobals = simulateJsdomTeardown();
    await new Promise((resolve) => setTimeout(resolve, 350)); // past the 200 ms window
  }

  it('documents the bug: unguarded, the trailing call throws once `Element` is gone', async () => {
    await mountAndLeaveHoverPending();

    await outliveTeardown();

    expect(uncaught.map((e) => String((e as Error).message))).toContain('Element is not defined');
  });

  it('fixes it: cancelling the tracked timers leaves nothing to fire after teardown', async () => {
    const tracker = trackEditorTimers();
    const handle = await mountAndLeaveHoverPending();
    await unmount(handle as never);
    cancelStrayEditorTimers(tracker);

    await outliveTeardown();

    expect(uncaught).toEqual([]);
  });
});

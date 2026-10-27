// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { undo } from '@milkdown/kit/prose/history';
import { MilkdownEditor } from './__fixtures__/milkdownEditorHarness';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';
import { guardEditorTimers } from './__fixtures__/editorTimerGuard';

guardEditorTimers();

it('uses current callbacks and read-only state without replacing the view or its history', async () => {
  const first = vi.fn<(content: string) => void>();
  const current = vi.fn<(content: string) => void>();
  const callbacks = new SvelteMap([['change', first]]);
  const flags = new SvelteSet<string>();
  const target = document.createElement('div');
  document.body.appendChild(target);
  document.elementFromPoint = () => null;

  const editor = await withoutLeakedCtxTimers(async () => {
    const mounted = mount(MilkdownEditor, {
      target,
      props: {
        get onchange() {
          return callbacks.get('change');
        },
        get readonly() {
          return flags.has('readonly');
        },
      },
    });
    await vi.waitFor(() => expect(mounted.getProseMirrorView()).not.toBeNull());
    return mounted;
  });
  try {
    editor.openNote('note-a', 'body\n');
    const view = editor.getProseMirrorView()!;
    view.dispatch(view.state.tr.insertText(' edited', 5));
    await vi.waitFor(() => expect(first.mock.lastCall?.[0]).toBe('body edited\n'));
    first.mockClear();

    flushSync(() => {
      callbacks.set('change', current);
      flags.add('readonly');
    });
    expect(editor.getProseMirrorView()).toBe(view);
    expect(view.dom.getAttribute('contenteditable')).toBe('false');
    view.dispatch(view.state.tr.insertText('refused', 1));
    expect(editor.getContent()).toBe('body edited\n');

    flushSync(() => flags.delete('readonly'));
    expect(editor.getProseMirrorView()).toBe(view);
    expect(view.dom.getAttribute('contenteditable')).toBe('true');
    expect(undo(view.state, view.dispatch)).toBe(true);
    await vi.waitFor(() => expect(current.mock.lastCall?.[0]).toBe('body\n'));
    expect(first).not.toHaveBeenCalled();
  } finally {
    await unmount(editor);
    target.remove();
  }
});

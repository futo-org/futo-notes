import { beforeEach, expect, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { withoutLeakedCtxTimers } from './noLeakedCtxTimers';
import { guardEditorTimers } from './editorTimerGuard';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

/**
 * Markdown whose parse throws. Real notes that do this exist — a table cell
 * that opened a wikilink token it could not close was one, fixed in d402d0aa —
 * but none is guaranteed to survive the next parser fix, and the contract has
 * to hold for the NEXT one. So the throw is injected at the one call the
 * component makes to parse a note (parseNote.ts).
 */
export const POISONED = '# a note this build cannot parse\n\nbody\n';

vi.mock('../parseNote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parseNote')>();
  return {
    ...actual,
    parseNote: (editor: unknown, markdown: string) => {
      if (markdown === POISONED) {
        throw new Error('Cannot close tableHeader: a different token (wikilink) is open');
      }
      return (actual.parseNote as (...args: unknown[]) => unknown)(editor, markdown);
    },
  };
});

vi.mock('@futo-notes/editor/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@futo-notes/editor/markdown')>();
  return {
    ...actual,
    createCachedSerializer: (...args: Parameters<typeof actual.createCachedSerializer>) => {
      const serializer = actual.createCachedSerializer(...args);
      return {
        ...serializer,
        serialize: (...values: Parameters<typeof serializer.serialize>) => {
          if (failSerialization) throw new Error('injected serializer failure');
          return serializer.serialize(...values);
        },
      };
    },
  };
});

export interface EditorHandle {
  openNote: (noteId: string, text: string) => void;
  setContent: (noteId: string, text: string) => void;
  retarget: (fromId: string, toId: string) => void;
  applyEdit: (text: string) => void;
  insertMarkdown: (text: string) => void;
  getContent: () => string | undefined;
  flush: (token: string) => void;
  hasFocus: () => boolean;
  getProseMirrorView: () => import('@milkdown/kit/prose/view').EditorView | null;
}

export let changes: string[] = [];
export let failures: { token: string; reason: string }[] = [];
let failSerialization = false;

/** Makes the next serializations throw (the `createCachedSerializer` mock above). */
export function setFailSerialization(value: boolean): void {
  failSerialization = value;
}
export let target: HTMLElement;
export let handle: EditorHandle;

/**
 * Imported here, at module scope, NOT inside `mountEditor()`. Loading this
 * component pulls in the whole Milkdown/ProseMirror graph, and the module
 * cache means that cost is paid exactly once either way — but inside the
 * `beforeEach` it is charged to that hook's timeout, and on a shared CI runner
 * it does not fit: pipeline 36190 timed out 8 of 10 hooks at 10s, and 36192
 * timed out the first 3 at 30s while every test after them ran in ~70ms. At
 * module scope the same work is part of collection, which is not budgeted.
 * `vi.mock` calls are hoisted above this, so the mocks still apply.
 */
export const MilkdownEditor = (await import('../MilkdownEditor.svelte')).default;

/** Mounts a fresh editor and waits for Milkdown's async `create()` to land. */
export async function mountEditor(): Promise<void> {
  changes = [];
  failures = [];
  failSerialization = false;
  target = document.createElement('div');
  document.body.appendChild(target);
  await withoutLeakedCtxTimers(async () => {
    handle = mount(MilkdownEditor, {
      target,
      props: {
        content: '',
        onflushfailed: (_ref: unknown, token: string, reason: string) =>
          failures.push({ token, reason }),
        onchange: (content: string) => {
          changes.push(content);
        },
      },
    }) as unknown as EditorHandle;
    await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull());
  });
}

export function editable(): HTMLElement {
  const element = target.querySelector('.ProseMirror');
  if (!(element instanceof HTMLElement)) throw new Error('no editable');
  return element;
}

/** The change notification is debounced by 200 ms (documentChanges.ts). */
export function afterChangeDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 350));
}

/**
 * Empty the document as a user does — one transaction over the whole thing.
 * Dispatched through the live view rather than `applyEdit`, which is the host's
 * own edit path and reports itself synchronously; the point of these cases is
 * the USER's transaction, which reaches the host only through the debounce.
 */
export function clearDocument(): void {
  const view = handle.getProseMirrorView();
  if (!view) throw new Error('no ProseMirror view');
  view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
}

/** Mounts a fresh editor before each test of the calling file and unmounts it after. */
export function useMountedEditor(): void {
  // RC-66: no native timer may outlive a test (see the guard's header).
  guardEditorTimers();

  beforeEach(async () => {
    document.body.innerHTML = '';
    // @milkdown/plugin-block hit-tests the block under the pointer on every
    // synthetic pointermove the caret dispatches; jsdom has no hit testing.
    document.elementFromPoint = () => null;
    await mountEditor();
    return async () => {
      await unmount(handle as never);
    };
  });
}

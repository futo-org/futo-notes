// @vitest-environment jsdom
/**
 * The editor's data-safety contract: what it reports for a note it is NOT
 * holding.
 *
 * 2026-09-03 DATA LOSS. Three notes in a live vault were overwritten with 0
 * bytes. Two of them were open while a hot-module reload replaced this
 * component — the new instance mounts EMPTY under a session that still holds
 * the note. The third had markdown the parser threw on, which left the editor
 * with an empty document and the reader with a blank page. In all three the
 * component answered `getContent()` with `''`, the save pipeline read that as
 * "the user deleted everything", and the Rust store truncated the file
 * (`flush_draft` writes whatever it is given when the base still matches disk).
 *
 * The rule these lock: an empty document the editor never loaded is never
 * reported as the note. → docs/spec/editor.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';

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
const POISONED = '# a note this build cannot parse\n\nbody\n';

vi.mock('./parseNote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parseNote')>();
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

interface EditorHandle {
  openNote: (text: string) => void;
  setContent: (text: string) => void;
  applyEdit: (text: string) => void;
  getContent: () => string | undefined;
  hasFocus: () => boolean;
  getProseMirrorView: () => import('@milkdown/kit/prose/view').EditorView | null;
}

let changes: string[] = [];
let target: HTMLElement;
let handle: EditorHandle;

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
const MilkdownEditor = (await import('./MilkdownEditor.svelte')).default;

/** Mounts a fresh editor and waits for Milkdown's async `create()` to land. */
async function mountEditor(): Promise<void> {
  changes = [];
  target = document.createElement('div');
  document.body.appendChild(target);
  await withoutLeakedCtxTimers(async () => {
    handle = mount(MilkdownEditor, {
      target,
      props: {
        content: '',
        onchange: (content: string) => {
          changes.push(content);
        },
      },
    }) as unknown as EditorHandle;
    await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull());
  });
}

function editable(): HTMLElement {
  const element = target.querySelector('.ProseMirror');
  if (!(element instanceof HTMLElement)) throw new Error('no editable');
  return element;
}

/** The change notification is debounced by 200 ms (documentChanges.ts). */
function afterChangeDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 350));
}

/**
 * Empty the document as a user does — one transaction over the whole thing.
 * Dispatched through the live view rather than `applyEdit`, which is the host's
 * own edit path and reports itself synchronously; the point of these cases is
 * the USER's transaction, which reaches the host only through the debounce.
 */
function clearDocument(): void {
  const view = handle.getProseMirrorView();
  if (!view) throw new Error('no ProseMirror view');
  view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
}

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

describe('an editor holding no note', () => {
  it('reports nothing at all, not an empty note', () => {
    // A freshly mounted component — which is what a hot reload, a `{#key}`, or
    // an `{#if}` around the editor leaves behind while a note is open. `''`
    // here is what the save pipeline wrote over three real notes.
    expect(handle.getContent()).toBeUndefined();
  });

  it('reports an empty string once a brand-new note has been opened', () => {
    handle.openNote('');
    expect(handle.getContent()).toBe('');
  });
});

/**
 * The other half of the same contract: an empty document the user MADE is a
 * deletion, and has to reach the host as one.
 *
 * The save pipeline refuses to write `''` over a note whose emptying it never
 * heard about (`noteSessionChanges.editorLostTheNote`) — deliberately, because
 * a blank editor is indistinguishable from a cleared one at that layer. This
 * component is where the two ARE distinguishable, so a clear that goes
 * unreported here is a deletion the user cannot make at all.
 */
describe('a note the user clears', () => {
  it('reports the empty document', async () => {
    handle.openNote('delete me\n');
    await afterChangeDebounce();

    clearDocument();
    await afterChangeDebounce();

    expect(changes).toEqual(['']);
    expect(handle.getContent()).toBe('');
  });

  it('reports it even when the clear lands in the same window as the load', async () => {
    // The shape that dropped the deletion outright. Change detection used to
    // come from `@milkdown/plugin-listener`, which stays silent whenever the
    // settled document matches its own baseline — and its baseline was still
    // the PRISTINE EMPTY document, because the load's callback had been
    // coalesced away by this very edit. A cleared note is exactly that
    // document, so the clear was reported as "nothing changed": no `change`,
    // no save, and the note came back on the next open.
    handle.openNote('delete me\n');
    clearDocument();
    await afterChangeDebounce();

    expect(changes).toEqual(['']);
  });

  it('reports what was typed when the user clears and starts over', async () => {
    handle.openNote('the old body\n');
    clearDocument();
    const view = handle.getProseMirrorView();
    view?.dispatch(view.state.tr.insertText('x', 1));
    await afterChangeDebounce();

    expect(changes).toEqual(['x\n']);
  });
});

describe('a note whose parse throws', () => {
  it('reports the host bytes it was given, never the empty document', () => {
    handle.openNote(POISONED);

    expect(editable().textContent).toBe('');
    expect(handle.getContent()).toBe(POISONED);
  });

  it('emits no change, so nothing reaches the save queue', async () => {
    handle.openNote(POISONED);
    await afterChangeDebounce();

    expect(changes).toEqual([]);
  });

  it('says so, and goes read-only rather than showing a blank editable page', async () => {
    handle.openNote(POISONED);
    await tick();

    expect(target.querySelector('[role="alert"]')?.textContent).toContain('could not be displayed');
    expect(editable().getAttribute('contenteditable')).toBe('false');
  });

  it('refuses chrome edits computed from a document it never loaded', () => {
    handle.openNote(POISONED);
    handle.applyEdit('#tag\n\nsomething else\n');

    expect(handle.getContent()).toBe(POISONED);
    expect(changes).toEqual([]);
  });

  it('recovers completely when the next note parses', async () => {
    handle.openNote(POISONED);
    await tick();
    handle.openNote('# fine\n\nbody\n');
    await tick();

    expect(handle.getContent()).toBe('# fine\n\nbody\n');
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(editable().getAttribute('contenteditable')).toBe('true');
  });
});

describe('the focus signal the external-change coordinator reads', () => {
  /*
   * `hasFocus()` answers "is the user typing HERE, right now" — the question
   * that decides whether an external file change may be adopted into the open
   * editor (docs/spec/sync.md "External filesystem changes to the open note
   * mirror disk"; the focused verdict is DeferAdopt in
   * crates/futo-notes-sync/src/open_note.rs). The caret staying parked in the
   * editable is not that: a backgrounded window keeps its activeElement, so an
   * answer built on the caret alone reports a typist who left hours ago and
   * the IDE-style mirror never fires again.
   */
  it('reports unfocused while the window itself is not focused', () => {
    editable().focus();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(handle.hasFocus()).toBe(false);
  });

  it('reports focused when the caret is in the editor and the window has focus', () => {
    editable().focus();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(handle.hasFocus()).toBe(true);
  });

  it('reports unfocused when the window has focus but the caret is elsewhere', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(handle.hasFocus()).toBe(false);
  });
});

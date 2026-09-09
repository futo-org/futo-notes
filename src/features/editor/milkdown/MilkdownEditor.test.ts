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
  getProseMirrorView: () => import('@milkdown/kit/prose/view').EditorView | null;
}

let changes: string[] = [];
let target: HTMLElement;
let handle: EditorHandle;

/** Mounts a fresh editor and waits for Milkdown's async `create()` to land. */
async function mountEditor(): Promise<void> {
  const MilkdownEditor = (await import('./MilkdownEditor.svelte')).default;
  changes = [];
  target = document.createElement('div');
  document.body.appendChild(target);
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

// The 30s hook timeout (vitest defaults to 10s) is for the mount below: it
// builds a whole Milkdown editor per test, ~0.7s locally and ~8-10s on a
// shared CI runner. In pipeline 36190 one test squeezed in at 8153ms while
// eight others tripped the 10s limit in the same run — the hook is slow, not
// hung. Same runner `vitest.config.ts` already caps maxWorkers for (PKT-20).
beforeEach(async () => {
  document.body.innerHTML = '';
  // @milkdown/plugin-block hit-tests the block under the pointer on every
  // synthetic pointermove the caret dispatches; jsdom has no hit testing.
  document.elementFromPoint = () => null;
  await mountEditor();
  return async () => {
    await unmount(handle as never);
  };
}, 30_000);

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

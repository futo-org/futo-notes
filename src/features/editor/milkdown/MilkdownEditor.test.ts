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
import { describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import {
  POISONED,
  changes,
  failures,
  target,
  handle,
  editable,
  afterChangeDebounce,
  clearDocument,
  setFailSerialization,
  useMountedEditor,
} from './__fixtures__/milkdownEditorHarness';

useMountedEditor();

describe('an editor holding no note', () => {
  it('reports nothing at all, not an empty note', () => {
    // A freshly mounted component — which is what a hot reload, a `{#key}`, or
    // an `{#if}` around the editor leaves behind while a note is open. `''`
    // here is what the save pipeline wrote over three real notes.
    expect(handle.getContent()).toBeUndefined();
  });

  it('reports an empty string once a brand-new note has been opened', () => {
    handle.openNote('test-note', '');
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
    handle.openNote('test-note', 'delete me\n');
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
    handle.openNote('test-note', 'delete me\n');
    clearDocument();
    await afterChangeDebounce();

    expect(changes).toEqual(['']);
  });

  it('reports what was typed when the user clears and starts over', async () => {
    handle.openNote('test-note', 'the old body\n');
    clearDocument();
    const view = handle.getProseMirrorView();
    view?.dispatch(view.state.tr.insertText('x', 1));
    await afterChangeDebounce();

    expect(changes).toEqual(['x\n']);
  });
});

describe('a note whose parse throws', () => {
  it('reports the host bytes it was given, never the empty document', () => {
    handle.openNote('test-note', POISONED);

    expect(editable().textContent).toBe('');
    expect(handle.getContent()).toBe(POISONED);
  });

  it('emits no change, so nothing reaches the save queue', async () => {
    handle.openNote('test-note', POISONED);
    await afterChangeDebounce();

    expect(changes).toEqual([]);
  });

  it('says so, and goes read-only rather than showing a blank editable page', async () => {
    handle.openNote('test-note', POISONED);
    await tick();

    expect(target.querySelector('[role="alert"]')?.textContent).toContain('could not be displayed');
    expect(editable().getAttribute('contenteditable')).toBe('false');
  });

  it('refuses chrome edits computed from a document it never loaded', () => {
    handle.openNote('test-note', POISONED);
    handle.applyEdit('#tag\n\nsomething else\n');

    expect(handle.getContent()).toBe(POISONED);
    expect(changes).toEqual([]);
  });

  it('recovers completely when the next note parses', async () => {
    handle.openNote('test-note', POISONED);
    await tick();
    handle.openNote('test-note', '# fine\n\nbody\n');
    await tick();

    expect(handle.getContent()).toBe('# fine\n\nbody\n');
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(editable().getAttribute('contenteditable')).toBe('true');
  });
});

describe('flush failures never invent a body', () => {
  it('reports a never-loaded document as noDocument', () => {
    handle.flush('never-loaded');
    expect(failures).toEqual([{ token: 'never-loaded', reason: 'noDocument' }]);
    expect(changes).toEqual([]);
  });
  it('reports a failed load instead of publishing a blank body', () => {
    handle.openNote('test-note', POISONED);
    handle.flush('failed-load');
    expect(failures).toEqual([{ token: 'failed-load', reason: 'loadFailed' }]);
    expect(changes).toEqual([]);
  });
  it('reports serializer failure and preserves an unreported edit for retry', () => {
    handle.openNote('test-note', 'base');
    const view = handle.getProseMirrorView()!;
    view.dispatch(view.state.tr.insertText('typed', 1));
    setFailSerialization(true);
    handle.flush('failed-serializer');
    expect(failures).toEqual([{ token: 'failed-serializer', reason: 'serializer' }]);
    expect(changes).toEqual([]);
    setFailSerialization(false);
    handle.flush('retry');
    expect(changes).toEqual(['typedbase\n']);
  });
});

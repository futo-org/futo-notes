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
import { undo } from '@milkdown/kit/prose/history';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';
import { guardEditorTimers } from './__fixtures__/editorTimerGuard';

// RC-66: no native timer may outlive a test (see the guard's header).
guardEditorTimers();

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

interface EditorHandle {
  openNote: (noteId: string, text: string) => void;
  setContent: (noteId: string, text: string) => void;
  applyEdit: (text: string) => void;
  insertMarkdown: (text: string) => void;
  getContent: () => string | undefined;
  flush: (token: string) => void;
  hasFocus: () => boolean;
  getProseMirrorView: () => import('@milkdown/kit/prose/view').EditorView | null;
}

let changes: string[] = [];
let failures: { token: string; reason: string }[] = [];
let failSerialization = false;
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

/**
 * A chrome edit that lands while a large note is still streaming
 * (progressiveLoad.ts).
 *
 * The desktop tag bar reads the note with `getContent()` — which never hands
 * back a prefix, so it gets the WHOLE note — computes new markdown from it,
 * and hands the whole document back through `applyEdit`. If the in-flight
 * progressive load is still running when that replace lands, the chunks still
 * queued append onto the REPLACED document and the note ends up holding its
 * tail TWICE. The doubled document then reaches `onchange` and is written to
 * disk. Reproduced on a 502-line note by changing one tag while it opened.
 *
 * Deterministic because progressive open applies chunk 0 in the calling task
 * and schedules everything after it: a call made in the same task as the open
 * is, by construction, mid-stream.
 */
describe('a chrome edit during a progressive open', () => {
  /** 601 lines — past the 400-line threshold, so the load chunks. */
  const STREAMING_NOTE =
    Array.from({ length: 300 }, (_, i) => `Body paragraph ${i}.`).join('\n\n') +
    '\n\nThe unique final paragraph.\n';

  /** What the tag bar computes: the whole note with a tag line in front. */
  const TAGGED = `#recipes\n\n${STREAMING_NOTE}`;

  const FINAL_PARAGRAPH = /The unique final paragraph\./gu;

  function countFinalParagraphs(text: string | undefined): number {
    return text?.match(FINAL_PARAGRAPH)?.length ?? 0;
  }

  /** Long enough for every queued chunk to have had its idle slice. */
  function afterStreamSettles(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 500));
  }

  /**
   * The note is genuinely mid-stream at this point — asserted, not assumed. A
   * planner change that loaded this fixture whole would leave every assertion
   * after it passing while exercising nothing (AGENTS.md M11). Chunk 0's
   * budget is 80 lines, so it carries ~40 of the 301 blocks and the final
   * paragraph is nowhere near it yet.
   */
  function expectMidStream(): void {
    const mounted = editable().children.length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(200);
    expect(countFinalParagraphs(editable().textContent ?? '')).toBe(0);
  }

  it('does not append the streaming tail on top of the replaced document', async () => {
    handle.openNote('test-note', STREAMING_NOTE);
    // Mid-stream by construction — nothing has yielded since the open.
    expectMidStream();
    handle.applyEdit(TAGGED);

    await afterStreamSettles();

    expect(countFinalParagraphs(handle.getContent())).toBe(1);
    expect(countFinalParagraphs(editable().textContent ?? '')).toBe(1);
    expect(handle.getContent()).toContain('#recipes');
  });

  it('never reports a doubled note to the host', async () => {
    handle.openNote('test-note', STREAMING_NOTE);
    expectMidStream();
    handle.applyEdit(TAGGED);

    await afterStreamSettles();
    await afterChangeDebounce();

    for (const change of changes) expect(countFinalParagraphs(change)).toBeLessThan(2);
    expect(countFinalParagraphs(changes.at(-1))).toBe(1);
    expect(changes.at(-1)).toContain('#recipes');
  });

  /**
   * Why the pending load is SETTLED rather than discarded. A chrome edit is
   * one undoable step, so Ctrl-Z lands on whatever the document held when the
   * replace ran. Abandon the stream first and that is the half-loaded prefix —
   * undo would truncate the note, and the truncation goes straight to
   * `onchange` and the save queue. Discarding trades a doubled note for a
   * shortened one.
   */
  it('leaves undo on the complete note, not the half-loaded prefix', async () => {
    handle.openNote('test-note', STREAMING_NOTE);
    expectMidStream();
    handle.applyEdit(TAGGED);

    const view = handle.getProseMirrorView();
    if (!view) throw new Error('no ProseMirror view');
    undo(view.state, view.dispatch);
    await afterStreamSettles();

    expect(countFinalParagraphs(handle.getContent())).toBe(1);
    expect(handle.getContent()).not.toContain('#recipes');
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

/**
 * RC-38: micromark strips a leading U+FEFF, so Milkdown's remarkMarker read the
 * character BEFORE each `*`/`_` run and re-spelled every emphasis in the note.
 * `openNote` goes through parseNote, but the desktop tag bar's `applyEdit`
 * called Milkdown's own `replaceAll`, which did not — and reports the result
 * to the host synchronously, so the corruption was saved.
 */
describe('a note that starts with a byte order mark', () => {
  const BODY = 'Intro **b** and _it_ x**y**z\n';
  /* What a save writes for BODY: the house style spells italics `*`. */
  const SAVED = 'Intro **b** and *it* x**y**z\n';

  it('keeps its emphasis when the tag bar rewrites the document', () => {
    handle.openNote('test-note', `\ufeff${BODY}`);
    expect(handle.getContent()).toBe(`\ufeff${BODY}`);

    handle.applyEdit(`${handle.getContent()}\n#tag\n`);

    expect(changes.at(-1)).toBe(`${SAVED}\n#tag\n`);
    expect(handle.getContent()).toBe(`${SAVED}\n#tag\n`);
  });

  it('keeps its emphasis when the BOM is doubled, and echoes the host bytes on open', () => {
    const note = `\ufeff\ufeff${BODY}`;
    handle.openNote('test-note', note);
    expect(handle.getContent()).toBe(note);

    handle.applyEdit(`${note}\n#tag\n`);

    expect(changes.at(-1)).toBe(`${SAVED}\n#tag\n`);
  });
});

/**
 * The other two doors a string reaches the parser through without `parseNote`
 * (FB-8 follow-up): Milkdown's own `insert` action, and the `defaultValueCtx`
 * the engine is created with. Each strips the leading BOM itself
 * (`stripLeadingBoms`); nothing else pins either call, so removing one strip
 * would have kept the whole suite green while re-opening RC-38 through it.
 */
describe('the BOM strip on the parser doors other than openNote', () => {
  const BODY = 'Intro **b** and _it_ x**y**z\n';

  it('insertMarkdown keeps the emphasis of markdown that starts with a BOM', () => {
    handle.openNote('test-note', '');
    handle.insertMarkdown(`\ufeff${BODY}`);

    // The house style spells italics `*`.
    expect(handle.getContent()).toBe('Intro **b** and *it* x**y**z\n');
  });

  it('a note handed to the engine as its initial value keeps its emphasis', async () => {
    const mounted = document.createElement('div');
    document.body.appendChild(mounted);
    /* `applyExternal` replaces this document with a parseNote'd copy the moment
     * the engine is up, so only the instant BEFORE that — `onenginemounted` —
     * shows what `defaultValueCtx` built. Every mark's source spelling: `*` or `_`. */
    let markers: string[] | null = null;
    let initial!: EditorHandle;
    await withoutLeakedCtxTimers(async () => {
      initial = mount(MilkdownEditor, {
        target: mounted,
        props: {
          content: `\ufeff${BODY}`,
          onchange: () => {},
          onenginemounted: () => {
            const found: string[] = [];
            initial.getProseMirrorView()!.state.doc.descendants((node) => {
              for (const mark of node.marks) found.push(`${mark.type.name}:${mark.attrs.marker}`);
            });
            markers = found;
          },
        },
      }) as unknown as EditorHandle;
      await vi.waitFor(() => expect(markers).not.toBeNull());
    });

    expect(markers).toEqual(['strong:*', 'emphasis:_', 'strong:*']);
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
    failSerialization = true;
    handle.flush('failed-serializer');
    expect(failures).toEqual([{ token: 'failed-serializer', reason: 'serializer' }]);
    expect(changes).toEqual([]);
    failSerialization = false;
    handle.flush('retry');
    expect(changes).toEqual(['typedbase\n']);
  });
});

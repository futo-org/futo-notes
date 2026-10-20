// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { undo } from '@milkdown/kit/prose/history';
import {
  changes,
  handle,
  editable,
  afterChangeDebounce,
  useMountedEditor,
} from './__fixtures__/milkdownEditorHarness';

useMountedEditor();

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
   * budget is a screen and a half of jsdom's 768 px window (48 lines,
   * `firstChunkLinesForViewport`), so it carries ~24 of the 301 blocks and the
   * final paragraph is nowhere near it yet.
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

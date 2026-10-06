/*
 * The load path: how host content becomes the editor's document — whole, or
 * progressively for a note large enough to stream (progressiveLoad.ts) — and
 * how a load that throws is recorded rather than shown as an empty note.
 *
 * Everything it changes lives on the editor's DocumentSession; it reports the
 * load through `ondocumentloaded`, and hands the finished document to the
 * serialization loop to warm and, if the user edited the first viewport while
 * the tail was streaming, to report.
 */
import type { Editor } from '@milkdown/kit/core';
import { Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { DocumentRef } from '@futo-notes/editor';
import { FRONTMATTER_NODE } from '@futo-notes/editor/milkdown-compat';
import type { DocumentSession } from './documentSession.svelte';
import { dismissLinkPrompt } from './linkPrompt';
import { planMarkdownChunks, type MarkdownChunkOptions } from './markdownChunks';
import { parseNote } from './parseNote';
import {
  OPEN_COMPLETE_MEASURE,
  OPEN_INTERACTIVE_MEASURE,
  appendChunkContent,
  chunkShouldHaveContent,
  isEffectivelyEmpty,
  markOpenStart,
  measureOpen,
  scheduleIdleSlice,
  startProgressiveLoad,
} from './progressiveLoad';
import type { SerializationLoop } from './serializationLoop';

/** The component props the load path reports through. A getter: each read is the CURRENT prop. */
export interface DocumentLoadProps {
  readonly ondocumentloaded?: (ref: DocumentRef, source: 'load' | 'external') => void;
}

export interface DocumentLoadDeps {
  getEditor: () => Editor | null;
  pmView: () => ProseView | null;
  emitFormatState: () => void;
  /** Re-asks the view for its `editable` prop (MilkdownEditor.svelte). */
  refreshEditable: () => void;
  props: DocumentLoadProps;
}

export type DocumentLoad = ReturnType<typeof createDocumentLoad>;

/**
 * Replaces the whole document with `parsed`, OUTSIDE the undo history.
 *
 * This is Milkdown's `replaceAll` body with one addition, and the addition is
 * data safety: content that arrives from OUTSIDE the editor — a note open, a
 * sync adopt, a host content push — must not be something Ctrl-Z can take
 * back. Applied as an ordinary transaction, one undo after a peer's version
 * landed restored the version it superseded and handed that to autosave,
 * writing the stale note over the fresh one. `addToHistory: false` keeps the
 * load off the stack; the user's own earlier edits stay undoable, rebased
 * over it by prosemirror-history the way the CodeMirror editor's
 * `EXTERNAL_CONTENT_OPTS` did. It also means documentChanges.ts never reports
 * the load itself — correct, since a load is never an edit.
 * → docs/spec/editor.md "Saving & rename", tests/editor-embed-milkdown.spec.ts
 *
 * A focused editable's DOM caret is let go first; ProseMirror puts it back
 * once the new document's DOM exists. Left in place, it sits in the block
 * being rewritten, and WebKit pays for every child written or removed
 * around it: the Selection's live range is re-indexed per removal, and the
 * writing-suggestions pass walks to the caret's child index per element
 * built — O(n²) in a block's inline children. Measured on WebKit, a 100 KB
 * paragraph dense with marks opened in 9 s with the caret in place and in
 * 1.4 s without. (ProseMirror's own measuring Range is the other boundary
 * that used to sit there; patches/prosemirror-view parks it.)
 * → tests/editor-open-large-paragraph.spec.ts
 */
function loadParsedDocument(view: ProseView, parsed: ProseNode): void {
  if (view.hasFocus() && !view.composing) view.dom.ownerDocument.getSelection()?.removeAllRanges();
  const { state } = view;
  view.dispatch(
    state.tr
      .replace(0, state.doc.content.size, new Slice(parsed.content, 0, 0))
      .setMeta('addToHistory', false),
  );
}

/**
 * An empty paragraph at the end of a parsed chunk is the chunk's own unless
 * it is the schema's: a chunk that is nothing but front matter gets one from
 * `createAndFill`, because the doc's content is `frontmatter? block+` and the
 * front matter is not a block. That one belongs to the FINISHED document's
 * shape, not to this chunk, and the whole-document parse never has it (the
 * body's first block satisfies `block+`). Measured: four corpus notes with
 * front matter opened one blank line longer chunked than whole before this.
 */
function endsWithOwnEmptyParagraph(node: ProseNode): boolean {
  const last = node.lastChild;
  if (last === null || last.type.name !== 'paragraph' || last.content.size !== 0) return false;
  const isFrontmatterFiller =
    node.childCount === 2 && node.firstChild?.type.name === FRONTMATTER_NODE;
  return !isFrontmatterFiller;
}

/** The streamed chunks of one progressive open, applied in order. */
function createChunkApplier(getEditor: () => Editor | null, pmView: () => ProseView | null) {
  /**
   * Whether the last chunk applied ended in an empty paragraph of its OWN — a
   * `<br />` placeholder an older build wrote as its final block. The next
   * append must then keep the live document's trailing empty paragraph rather
   * than treat it as the `trailing` plugin's (see `appendChunkContent`).
   */
  let previousChunkEndedEmpty = false;

  /**
   * Mounts the first chunk, replacing whatever the editor held.
   *
   * Guarded exactly like every later chunk: a first chunk the plugin chain eats
   * would otherwise be dropped silently, and it is the one the user is looking
   * at. Parsed here rather than through `applyWholeDocument` so the parsed
   * chunk is in hand for the guard and for `previousChunkEndedEmpty`; the
   * replace itself is the same non-undoable one (`loadParsedDocument`).
   */
  function applyFirstChunk(markdown: string): boolean {
    const editor = getEditor();
    const view = pmView();
    if (!editor || !view) return false;
    try {
      const parsed = parseNote(editor, markdown);
      if (!parsed) return false;
      if (chunkShouldHaveContent(markdown) && isEffectivelyEmpty(parsed)) return false;
      loadParsedDocument(view, parsed);
      previousChunkEndedEmpty = endsWithOwnEmptyParagraph(parsed);
      return true;
    } catch (error) {
      // Same contract as `appendParsedChunk`: a throw aborts back to a whole
      // -document load, which is where a genuine parse failure is recorded.
      console.warn('MilkdownEditor: first chunk parse failed', error);
      return false;
    }
  }

  /**
   * Parses one streamed chunk and appends it, with the empty paragraphs the
   * seam before it stands for. Returns false if the parse failed, which aborts
   * the stream back to a whole-document load rather than silently dropping the
   * rest of the note.
   */
  function appendParsedChunk(markdown: string, leadingEmptyParagraphs: number): boolean {
    const editor = getEditor();
    const view = pmView();
    if (!editor || !view) return false;
    try {
      const parsed = parseNote(editor, markdown);
      if (!parsed) return false;
      // Real markdown that parses to nothing has been eaten by the plugin
      // chain; appending it would drop that slice of the note.
      if (chunkShouldHaveContent(markdown) && isEffectivelyEmpty(parsed)) return false;
      appendChunkContent(view, parsed, {
        leadingEmptyParagraphs,
        consumeTrailingPlaceholder: !previousChunkEndedEmpty,
      });
      previousChunkEndedEmpty = endsWithOwnEmptyParagraph(parsed);
      return true;
    } catch (error) {
      console.warn('MilkdownEditor: chunk parse failed', error);
      return false;
    }
  }

  return { applyFirstChunk, appendParsedChunk };
}

export function createDocumentLoad(
  session: DocumentSession,
  serialization: SerializationLoop,
  deps: DocumentLoadDeps,
) {
  const { getEditor, pmView, emitFormatState, refreshEditable, props } = deps;
  const { cancelChangeNotification, startPriming, stopPriming, readSerialized, postChange } =
    serialization;
  const { applyFirstChunk, appendParsedChunk } = createChunkApplier(getEditor, pmView);

  /** Record the live document as the host's note `text`, without serializing it. */
  function noteLoaded(text: string): void {
    session.hostMarkdown = text;
    session.loadedDoc = pmView()?.state.doc ?? null;
    session.liveDoc = null;
    session.liveMarkdown = null;
    // Warm the block cache in the background so the FIRST edit's debounce
    // never meets an unprimed document.
    startPriming();
  }

  /**
   * Loads the whole document in one parse — what every ordinary note does.
   *
   * Returns false if the parse threw. The caller records that as a failed load
   * (`loadFailed`); the host's bytes stay the answer to `getContent()`, so a
   * note this build cannot parse is shown as unreadable rather than emptied.
   */
  function applyWholeDocument(text: string): boolean {
    const editor = getEditor();
    const view = pmView();
    if (!editor || !view) return false;
    try {
      const parsed = parseNote(editor, text);
      if (!parsed) return false;
      loadParsedDocument(view, parsed);
    } catch (error) {
      console.error('MilkdownEditor: could not parse this note', error);
      return false;
    }
    noteLoaded(text);
    return true;
  }

  /**
   * Whether the user has changed the document since the current load began.
   *
   * Asked of `isReportableDocumentChange`, the one definition of a user edit:
   * the editor's own housekeeping carries `addToHistory: false` — the preset
   * re-stamps heading ids in a 125-step transaction after content lands, and
   * a "any document change that isn't ours" test would misread that as typing
   * and rewrite every large note on open — and so does everything a load
   * knocks on.
   */
  function editedSinceLoadStart(): boolean {
    return session.unreported;
  }

  /**
   * The tail is in. Release the save lock, and with it any edit the user made
   * into the first viewport while the rest was still arriving.
   */
  function finishProgressiveLoad(): void {
    session.streamingTail = false;
    measureOpen(OPEN_COMPLETE_MEASURE);
    emitFormatState();

    /* Whatever the debounce is holding described a prefix, or is about to be
     * reported right here; either way a second report would be a duplicate. */
    cancelChangeNotification();
    // Any cached serialization described a prefix of the note.
    session.liveDoc = null;
    session.liveMarkdown = null;

    if (!editedSinceLoadStart()) {
      // The finished document IS the host's note: the load echo now applies.
      session.loadedDoc = pmView()?.state.doc ?? null;
      // Warm the block cache now that the whole note has landed.
      startPriming();
      return;
    }
    // The host's bytes are no longer what the document says.
    session.hostMarkdown = null;
    session.loadedDoc = null;
    // This fills every cache miss synchronously, so the document is already
    // fully primed by the time startPriming() below gets to run it.
    const complete = readSerialized();
    if (complete !== null && !session.settlingForFlush) postChange(complete);
    startPriming();
  }

  /**
   * Ends the in-flight progressive open, so the caller may replace the whole
   * document.
   *
   * CRITICAL — content duplication. A load still streaming behind a
   * whole-document replace appends its remaining chunks onto the REPLACEMENT:
   * changing a tag on a 502-line note while it was still opening left the note
   * holding its own tail TWICE, and the doubled document went to autosave.
   * Every path that replaces the document outright goes through here first,
   * and so does every path that has to READ the whole note.
   *
   * Which mode a caller wants follows from what it is about to put in the
   * document's place:
   *
   *   - `'settle'` parses the rest of the note right now
   *     (`ProgressiveLoad.finishNow`). Everything that replaces the document
   *     with text DERIVED FROM THIS NOTE wants this, even though the queued
   *     chunks are markdown the replacement already carries. The reason is the
   *     undo stack, not the content: a chrome edit is one undoable step
   *     (`applyEdit`), so the state one Ctrl-Z lands on is whatever the
   *     document held when the replace ran. Discard, and that is the
   *     half-streamed PREFIX — undo would truncate the note and hand the
   *     truncation to autosave, trading this bug for a worse one. Settling
   *     first makes the undo target the complete note.
   *   - `'discard'` throws the rest away, for a caller replacing the document
   *     with something that is not this note at all: another note, or this one
   *     re-parsed whole. Paying for a parse whose output the very next
   *     transaction deletes would be seconds of main thread on a note big
   *     enough to stream, for nothing.
   *
   * The bookkeeping matters as much as the ending: a DISCARDED load never
   * reaches `finishProgressiveLoad`, so the streaming affordance is cleared
   * here. (A settled one clears it there, and this is then a no-op.)
   */
  function endPendingLoad(mode: 'settle' | 'discard'): void {
    const load = session.progressive;
    if (mode === 'settle') load?.finishNow();
    else load?.cancel();
    session.progressive = null;
    session.streamingTail = false;
  }

  /**
   * Loads host content into the editor, progressively when the note is large
   * enough to be worth it (docs/plan/milkdown-transition.md §5).
   *
   * Progressive means the FIRST chunk is mounted synchronously — the user is
   * looking at a real, editable first viewport within one frame — and the rest
   * streams in idle slices. `markdownChunks.ts` guarantees the cuts are safe;
   * everything that could leak a half-loaded document (the `change`
   * notification, `getContent`) is locked until the last chunk lands.
   */
  function applyExternal(text: string, chunkOptions?: MarkdownChunkOptions): void {
    if (!getEditor()) return;
    cancelChangeNotification();
    session.unreported = false;
    /* A Link URL prompt left floating from before this call holds THAT
     * document's positions; submitting it after would write into this one.
     * `openNote` is not the only door — the native shells switch notes
     * through `setContent`/`applyExternalContent` too (F2), and even a
     * same-note sync adopt can move the position the prompt was opened at. */
    dismissLinkPrompt();
    // A different note (or this one, re-parsed whole): nothing still queued is
    // worth parsing.
    endPendingLoad('discard');
    session.abortedToWholeDocument = false;
    // A priming loop from the PREVIOUS document has nothing left to prime —
    // its cache entries key on that document's own node identities, which
    // this load is about to replace.
    stopPriming();
    /* Whatever this load does, it is now the one that owns the answer: a note
     * that failed to parse must not leave the NEXT note read-only, and a note
     * that parses must not inherit the previous one's failure. */
    /* Only when it actually moves: `refreshEditable` re-runs ProseMirror's
     * whole state-update pass, which on a very large note is measurable
     * against the open budget, and an ordinary open never touches this. */
    if (session.loadFailed) {
      session.loadFailed = false;
      refreshEditable();
    }
    markOpenStart();

    /* A load that throws leaves the document empty for a note that has bytes.
     * The host's text stays the answer to `getContent()`, the surface goes
     * read-only, and the failure is shown — never serialized back to disk. */
    const recordFailedLoad = (): void => {
      session.hostMarkdown = text;
      session.loadedDoc = null;
      session.liveDoc = null;
      session.liveMarkdown = null;
      session.loadFailed = true;
      refreshEditable();
    };

    const plan = planMarkdownChunks(text, chunkOptions);
    if (!plan.chunked) {
      if (!applyWholeDocument(text)) recordFailedLoad();
      measureOpen(OPEN_INTERACTIVE_MEASURE);
      measureOpen(OPEN_COMPLETE_MEASURE);
      if (!session.loadFailed)
        props.ondocumentloaded?.(session.documentRef(), session.pendingLoadSource);
      return;
    }

    session.hostMarkdown = text;
    /* No complete document exists yet — it is still a prefix. The save lock,
     * not `loadedDoc`, is what protects the streaming window. */
    session.loadedDoc = null;
    session.liveDoc = null;
    session.liveMarkdown = null;

    /* A chunk the editor would not take. Nothing about progressive open is
     * worth risking content for: throw the partial document away and load the
     * note exactly the way it loaded before this feature existed. An edit made
     * into the first viewport during the streaming window is discarded with it
     * — vanishingly rare (it needs a note whose chunks the plugin chain eats
     * AND a keystroke inside a sub-second window) and strictly better than
     * appending a chunk that lost part of the note. */
    let index = 0;
    const abortToWholeDocument = (): void => {
      session.abortedToWholeDocument = true;
      endPendingLoad('discard');
      if (!applyWholeDocument(text)) recordFailedLoad();
      measureOpen(OPEN_COMPLETE_MEASURE);
    };

    const load = startProgressiveLoad({
      chunks: plan.chunks,
      applyChunk: (markdown, leadingEmptyParagraphs) => {
        if (session.abortedToWholeDocument) return;
        const applied =
          index === 0
            ? applyFirstChunk(markdown)
            : appendParsedChunk(markdown, leadingEmptyParagraphs);
        index += 1;
        if (!applied) abortToWholeDocument();
      },
      scheduleIdle: scheduleIdleSlice,
      onComplete: () => {
        if (session.abortedToWholeDocument) return;
        finishProgressiveLoad();
      },
    });

    /* Chunk 0 is applied inside `startProgressiveLoad`, so an abort there ran
     * before `progressive` existed and could not cancel the load it is part of.
     * Everything else is already settled by `abortToWholeDocument`. */
    if (session.abortedToWholeDocument) {
      load.cancel();
      measureOpen(OPEN_INTERACTIVE_MEASURE);
      return;
    }

    session.progressive = load;
    session.streamingTail = load.loading;
    // After chunk 0, which is not an edit (`loadParsedDocument`): whatever
    // the user does from here on is.
    session.unreported = false;
    props.ondocumentloaded?.(session.documentRef(), session.pendingLoadSource);
    measureOpen(OPEN_INTERACTIVE_MEASURE);
  }

  return { applyExternal, endPendingLoad, editedSinceLoadStart };
}

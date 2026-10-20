import { insert, replaceAll } from '@milkdown/kit/utils';
import { toWellFormedText, type DocumentRef, type FlushFailureReason } from '@futo-notes/editor';
import { landPendingDrop } from './blockDragSession';
import type { DocumentLoad } from './documentLoad';
import type { DocumentSession } from './documentSession.svelte';
import { stripLeadingBoms } from './parseNote';
import { type SerializationLoop } from './serializationLoop';
import type { HostHandleDeps } from './hostHandleDeps';

/** The note's content: what leaves the editor, and the chrome's edits into it. */
export function createContentCommands(
  session: DocumentSession,
  serialization: SerializationLoop,
  documentLoad: DocumentLoad,
  deps: HostHandleDeps,
) {
  const { getEditor, pmView, props } = deps;
  const { cancelChangeNotification, stopPriming, readSerialized, unchangedSinceLoad, postChange } =
    serialization;
  const { endPendingLoad, editedSinceLoadStart } = documentLoad;

  function getDocumentRef(): DocumentRef {
    return session.documentRef();
  }

  function flush(token?: string): void {
    // A block drop still landing is in the note the host is about to save.
    landPendingDrop(pmView());
    const fail = (reason: FlushFailureReason): void => {
      if (token !== undefined) props.onflushfailed?.(session.documentRef(), token, reason);
    };
    if (session.currentNoteId === null || !getEditor()) {
      fail('noDocument');
      return;
    }
    if (session.loadFailed) {
      fail('loadFailed');
      return;
    }
    cancelChangeNotification();
    stopPriming();
    // Settling may itself report the complete document. The token still needs its answer.
    if (session.progressive?.loading && session.unreported) {
      session.settlingForFlush = true;
      try {
        endPendingLoad('settle');
      } finally {
        session.settlingForFlush = false;
      }
    }
    const text =
      session.hostMarkdown !== null && (session.progressive?.loading || unchangedSinceLoad())
        ? session.hostMarkdown
        : readSerialized();
    if (text === null) {
      fail('serializer');
      return;
    }
    postChange(text, token);
  }

  function getContent(): string | undefined {
    // A block drop still landing is in the note the host is about to read.
    landPendingDrop(pmView());
    const text = readContent();
    /* Every answer passes here, the host's own bytes included: nothing that
     * leaves the editor may carry a lone surrogate (RC-48, decision 16A). */
    return text === undefined ? text : toWellFormedText(text);
  }

  function readContent(): string | undefined {
    /* NOT THIS NOTE (CRITICAL — 2026-09-03 data loss, docs/spec/editor.md).
     * Two ways this component ends up holding an empty document for a note that
     * has bytes, both of which used to serialize back as "the user deleted
     * everything" and truncate the file:
     *
     *   - the load threw (`loadFailed`), so the host's own bytes are the only
     *     honest answer — and they are exactly what is on disk;
     *   - nothing has EVER been loaded into this instance, which is a fresh
     *     mount: a hot-module reload replacing the component under a live note,
     *     or any future `{#key}`/`{#if}` around the editor. `undefined` is the
     *     shell's existing "there is no editor to read" sentinel (EditorApi),
     *     and every caller already treats it as unsaveable.
     *
     * Nothing loaded, nothing reported and nothing serialized is precisely
     * "never loaded" — but only an EMPTY never-loaded document is "no note". A
     * host that dedupes `setContent('')` against this very method leaves an
     * untouched new note in exactly that state, and the text typed into it is
     * real content the moment it exists, a full change-debounce before the
     * change notification catches up. */
    if (session.loadFailed) return session.hostMarkdown ?? undefined;
    if (session.hostMarkdown === null && session.loadedDoc === null && session.liveDoc === null) {
      const untouched = readSerialized();
      if (untouched === null || untouched.trim() === '') return undefined;
      return untouched;
    }
    /* SAVE LOCK (CRITICAL — docs/plan/milkdown-transition.md §5). A document
     * that is still streaming is a PREFIX of the note, and this method is one
     * of exactly two ways content leaves the editor (the other is the `change`
     * message, locked in `reportDocumentChange`, serializationLoop.ts). Neither
     * branch below can return a prefix. */
    if (session.progressive?.loading) {
      /* Untouched since the open: the host's own bytes ARE the whole note, and
       * they are exactly what is on disk. The correct answer, and free. */
      if (!editedSinceLoadStart()) return session.hostMarkdown ?? '';
      /* Edited: the only answer carrying both the edit and the tail costs the
       * rest of the parse. Pay it rather than hand back a prefix. */
      endPendingLoad('settle');
    }
    // Only hand back the host's original bytes while the document is still
    // EXACTLY what it loaded; a keystroke inside the change debounce window
    // must not be reported as the unmodified note — and an untouched note
    // answers here without serializing anything.
    if (session.hostMarkdown !== null && unchangedSinceLoad()) return session.hostMarkdown;
    const live = readSerialized();
    /* CRITICAL — a document that cannot be serialized is not an empty one
     * (RC-17). After a chrome edit (`applyEdit`) nothing else describes it,
     * and `''` here was indistinguishable from the user clearing the note. No
     * answer is the honest one: every caller treats `undefined` as unsaveable. */
    if (live === null) return session.hostMarkdown ?? session.liveMarkdown ?? undefined;
    return live;
  }

  function insertMarkdown(text: string): void {
    const editor = getEditor();
    // Chrome must not write into a document that is not the note (`loadFailed`).
    if (!editor || session.loadFailed) return;
    editor.action(insert(stripLeadingBoms(text)));
    pmView()?.focus();
  }

  /**
   * Replace the whole document with `text` as the USER's own edit — undoable
   * in one step, and reported through `onchange` straight away.
   *
   * `setContent` is the HOST handing us a note (echo-guarded, silent); this is
   * the shell's chrome editing the note on the user's behalf. The desktop tag
   * bar is the caller (NoteTagBar.svelte): it computes new markdown from
   * `getContent()` and hands the whole document back, because a markdown
   * character offset has no ProseMirror position to splice at.
   *
   * `onchange` fires synchronously rather than waiting on the listener's
   * 200 ms debounce, so a tag the user just added is in the save queue before
   * they can navigate away. The debounced echo that follows is suppressed the
   * same way a completed progressive load suppresses its own.
   */
  function applyEdit(text: string): void {
    const editor = getEditor();
    // Same rule as `insertMarkdown`: the tag bar computed this from a document
    // the editor never managed to load, so it is not the note either.
    if (!editor || session.loadFailed) return;
    /* CRITICAL — the chunks a large note is still streaming would append onto
     * this replacement and leave the note holding its tail twice. Settled, not
     * discarded: this replace is one undoable step, so the document it leaves
     * behind for Ctrl-Z has to be the complete note (`endPendingLoad`). */
    endPendingLoad('settle');
    editor.action(replaceAll(stripLeadingBoms(text)));
    // The document is no longer the host's bytes — and this replace's own
    // debounced change notification is an echo of the report made right here,
    // not a second edit: `loadedDoc` is what says so.
    session.hostMarkdown = null;
    session.loadedDoc = pmView()?.state.doc ?? null;
    session.liveDoc = null;
    session.liveMarkdown = null;
    postChange(readSerialized() ?? text);
  }

  return { getDocumentRef, flush, getContent, insertMarkdown, applyEdit };
}

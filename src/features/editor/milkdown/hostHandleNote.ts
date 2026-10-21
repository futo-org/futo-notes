import { endsInUnwrittenBlank } from '@futo-notes/editor/milkdown-compat';
import type { DocumentLoad } from './documentLoad';
import type { DocumentSession } from './documentSession.svelte';
import { type SerializationLoop } from './serializationLoop';
import type { HostHandleDeps } from './hostHandleDeps';

/**
 * Which note the editor holds: opening one, relabeling it, and adopting the
 * host's newer text for it.
 */
export function createNoteCommands(
  session: DocumentSession,
  serialization: SerializationLoop,
  documentLoad: DocumentLoad,
  deps: HostHandleDeps,
  calls: { flush: (token?: string) => void; resetHistory: () => void },
) {
  const { getEditor, pmView, props } = deps;
  const { readSerialized, unchangedSinceLoad } = serialization;
  const { applyExternal, editedSinceLoadStart } = documentLoad;
  const { flush, resetHistory } = calls;

  function setContent(noteId: string, text: string): void {
    const editor = getEditor();
    if (editor && holdsExactly(text)) {
      if (session.currentNoteId === noteId) return;
      if (session.unreported && props.nativeShell) flush();
      session.currentNoteId = noteId;
      session.documentGeneration += 1;
      props.ondocumentloaded?.(session.documentRef(), 'load');
      return;
    }
    // A streaming edited departure pays the remaining parse before changing identity.
    if (
      session.currentNoteId !== null &&
      session.currentNoteId !== noteId &&
      session.unreported &&
      props.nativeShell
    )
      flush();
    session.documentIdentity += 1;
    session.currentNoteId = noteId;
    session.documentGeneration += 1;
    session.pendingLoadSource = 'load';
    if (!editor) {
      session.pendingContent = text;
      session.hostMarkdown = text;
      return;
    }
    applyExternal(text);
    resetHistory();
  }

  /**
   * The open note was renamed (or parked, or renamed by a peer): relabel the
   * live document and report it under the new identity. Never a load — the
   * shell's copy can lag a keystroke typed after its flush, and replacing the
   * document with it dropped that keystroke and the undo history.
   */
  function retarget(fromId: string, toId: string): void {
    if (session.currentNoteId !== fromId || fromId === toId) return;
    session.currentNoteId = toId;
    session.documentGeneration += 1;
    flush();
  }

  function applyExternalContent(noteId: string, text: string, expectedGeneration: number): void {
    if (
      session.currentNoteId !== noteId ||
      session.documentGeneration !== expectedGeneration ||
      session.unreported
    ) {
      props.onexternalrefused?.(session.documentRef());
      return;
    }
    const identical = holdsExactly(text);
    session.documentGeneration += 1;
    session.pendingLoadSource = 'external';
    if (identical) props.ondocumentloaded?.(session.documentRef(), 'external');
    else {
      session.documentIdentity += 1;
      applyExternal(text);
    }
  }

  /**
   * Is `text` what the document holds RIGHT NOW — so that loading it would
   * change nothing but the caret?
   *
   * Asked of the live document, never of what this component last loaded or
   * last reported. Both of those lag the user: `hostMarkdown` keeps the load
   * bytes for the whole change debounce after a keystroke, and `liveMarkdown`
   * describes whatever document was serialized last. A host that switches the
   * shared WebView to another note with the same bytes (two new, empty notes)
   * used to be swallowed by that bookkeeping, leaving the previous note's text
   * on screen to be reported as the next note's (L6a-1).
   *
   * Comparing stays side-effect free. The load caller flushes an outgoing
   * unreported edit before changing identity. Untouched streaming documents
   * can be compared against the complete host bytes without parsing the tail.
   */
  function holdsExactly(text: string): boolean {
    if (session.loadFailed || session.progressive?.loading) {
      return text === session.hostMarkdown && (session.loadFailed || !editedSinceLoadStart());
    }
    if (session.hostMarkdown !== null && unchangedSinceLoad()) return text === session.hostMarkdown;
    /* Equal bytes are not an equal document: trailing empty paragraphs are not
     * written (RC-22), nor is an empty last line (paragraphLines.ts), so a
     * document the user stacked blank lines onto serializes like one without
     * them, and skipping would leave those on screen under the next note. Such
     * a document is reloaded. */
    const view = pmView();
    if (view && endsInUnwrittenBlank(view.state.doc)) return false;
    return text === readSerialized();
  }

  /**
   * Opens a note: load its text, then drop the undo stack that belonged to
   * whatever was open before.
   *
   * The reset is the load-bearing half. Without it the first Ctrl-Z after a
   * note switch replays the PREVIOUS note's steps into this document, and the
   * save that follows writes them to THIS note's file. See `resetHistory`.
   *
   * There is no per-note undo stash.
   */
  function openNote(noteId: string | null, text: string): void {
    setContent(noteId ?? '', text);
  }

  /**
   * The note is still streaming in (progressiveLoad.ts): the document, and the
   * height it lays out to, is a prefix of the note until this goes false. The
   * shell's per-tab scroll restore waits on it.
   */
  function isStreaming(): boolean {
    return session.streamingTail;
  }

  return { setContent, retarget, applyExternalContent, openNote, isStreaming };
}

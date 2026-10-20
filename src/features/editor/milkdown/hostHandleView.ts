import { history as proseHistory, redoDepth, undoDepth } from '@milkdown/kit/prose/history';
import { EditorState, TextSelection, type PluginKey } from '@milkdown/kit/prose/state';
import type { Schema as ProseSchema } from '@milkdown/kit/prose/model';
import { closeFind as closeFindIn } from './find';
import { dropBlockDndFocusGuards } from './mobileBlockDnd';
import { hideTableGrips } from './table/tableGrips';
import { createToolbarExec } from './toolbarExec';
import { refreshWikilinkViews } from './wikilink';
import type { HostHandleDeps } from './hostHandleDeps';

/* prosemirror-history keeps its PluginKey module-private, so take it off a
 * throwaway instance of the very same plugin factory Milkdown's history
 * plugin uses — exact identity, no name matching. */
const HISTORY_KEY = proseHistory().spec.key as PluginKey<unknown>;

/** The plugin state a freshly created history plugin starts with. */
function emptyHistoryState(schema: ProseSchema): unknown {
  return HISTORY_KEY.getState(EditorState.create({ schema, plugins: [proseHistory()] }));
}

/** The view: focus, the caret, what the shell measures, the undo stack, toolbar commands. */
export function createViewCommands(deps: HostHandleDeps) {
  const { getEditor, pmView, emitCursorContext, emitFormatState } = deps;
  const EXEC = createToolbarExec(getEditor);

  function focus(): void {
    dropBlockDndFocusGuards(); // a host focus is intentional (R10-FB20-1)
    pmView()?.focus();
  }

  /*
   * The mobile shells' keyboard dismiss. It ends the editing session on the
   * page as well as the keyboard: no caret, no highlighted range or cell
   * selection, and no table grips left where a tap put them. A selection
   * survives a bare DOM blur, and so do its decorations and selection handles.
   */
  function blur(): void {
    const view = pmView();
    if (!view) return;
    const { state } = view;
    const collapsed = TextSelection.near(state.doc.resolve(state.selection.head));
    view.dispatch(hideTableGrips(state.tr.setSelection(collapsed)));
    view.dom.blur();
    view.dom.ownerDocument.getSelection()?.removeAllRanges();
  }

  /*
   * Scroll the caret into view without editing anything — for a viewport that
   * shrank under it. A tap near the bottom places the caret and THEN the
   * keyboard rises over it; ProseMirror only scrolls on its own transactions,
   * so until now the first keystroke was what revealed it.
   */
  function revealSelection(): void {
    const view = pmView();
    if (!view?.hasFocus()) return;
    view.dispatch(view.state.tr.scrollIntoView());
  }

  /*
   * "Is the user typing HERE, right now" — the question the external-change
   * coordinator asks before adopting a peer's or another app's bytes into the
   * open note (docs/spec/sync.md "External filesystem changes to the open note
   * mirror disk"; a focused editor gets DeferAdopt from
   * crates/futo-notes-sync `classify_open_note`).
   *
   * ProseMirror's own `hasFocus()` answers a narrower question — is the
   * editable the document's activeElement — and a backgrounded window keeps its
   * activeElement. On its own it therefore reports a typist who switched to
   * another app hours ago, which is precisely when an external file change
   * arrives: the deferral is never settled (no blur event follows a window
   * switch) and the note stops mirroring disk for the rest of the session.
   * CodeMirror's `hasFocus` gated on the document the same way; the Milkdown
   * port dropped the gate.
   */
  function hasFocus(): boolean {
    return (pmView()?.hasFocus() ?? false) && document.hasFocus();
  }

  function isComposing(): boolean {
    return Boolean(pmView()?.composing);
  }

  /** The editable element itself, for shell chrome that measures against it. */
  function contentElement(): HTMLElement | null {
    return pmView()?.dom ?? null;
  }

  /**
   * Put the caret at viewport coordinates, for shell chrome sitting OUTSIDE
   * the editor whose slack reaches into it (the desktop tag bar). Returns
   * false when the point resolves to no text position.
   */
  function placeCaretAtCoords(x: number, y: number): boolean {
    const view = pmView();
    if (!view) return false;
    const hit = view.posAtCoords({ left: x, top: y });
    if (!hit) return false;
    const { doc, tr } = view.state;
    const selection = TextSelection.findFrom(doc.resolve(hit.pos), 1, true) ?? null;
    if (!selection) return false;
    view.dispatch(tr.setSelection(selection).scrollIntoView());
    return true;
  }

  /**
   * Re-derive everything that depends on the HOST's state rather than the
   * document — today the note universe, which decides which wikilinks render as
   * broken. Reached from the bridge's `setNotes`/`setImageBaseUrl`, so it must
   * not dispatch a transaction: that would make a host call look like a user
   * edit and normalize-save the note.
   *
   * Images are deliberately NOT rebuilt here. Their node views re-resolve
   * themselves through `onVaultImageSrcChange` (vaultImageView.ts), which is
   * also the only thing that works when a URL lands with no host call behind it
   * — a late `setImageBaseUrl`, or an async desktop `getImageUrl`.
   */
  function refreshDecorations(): void {
    refreshWikilinkViews(pmView());
  }

  /**
   * Drops the undo/redo stack, keeping the document and the caret.
   *
   * CRITICAL — the host calls this on every `initialize`/`setContent`, i.e.
   * every note open (createFutoEditorApi.ts). Without it a Ctrl-Z after a note
   * switch replays the PREVIOUS note's steps into the current document and the
   * change that follows writes them to the current note's file. The first undo
   * after an open would also un-apply the load itself and leave the note empty.
   *
   * prosemirror-history exposes no clear command, so this hands its plugin the
   * initial state a fresh one would have, through the `historyKey` meta its own
   * undo/redo commands use (`applyTransaction` returns `meta.historyState`
   * verbatim). One empty transaction, nothing else touched.
   *
   * The obvious alternative — rebuilding the whole EditorState around the live
   * doc, which is what `replaceAll(md, true)` and CodeMirror's `swapEditorState`
   * do — is NOT usable here: `EditorState.create` builds a new plugin array, so
   * `view.updateState` sees changed plugins and destroys every plugin view. The
   * ⠿ block handle is parented outside the ProseMirror DOM by
   * @milkdown/plugin-block's BlockProvider, and that teardown detaches it for
   * good (BlockProvider only re-appends on a first `update()`, which it has
   * already had). Measured: the handle stopped existing after the first host
   * setContent.
   */
  function resetHistory(): void {
    const view = pmView();
    if (!view) return;
    /* Find state dies with the note. The host calls this on every
     * initialize/setContent, so it is the one place every note switch passes
     * through — and a query, a match list and a highlight from the PREVIOUS
     * note all point at positions this document no longer has. */
    closeFindIn(view);
    const { state } = view;
    if (undoDepth(state) === 0 && redoDepth(state) === 0) return;
    view.dispatch(state.tr.setMeta(HISTORY_KEY, { historyState: emptyHistoryState(state.schema) }));
  }

  function exec(commandId: string): boolean {
    const action = EXEC[commandId];
    if (!action) {
      console.warn(`MilkdownEditor.exec: unsupported command '${commandId}'`);
      return false;
    }
    action();
    // A tap may change the block or a mark without moving the selection (e.g.
    // Bold mid-word), so selectionUpdated alone would miss it — and the change
    // notification is 200ms-debounced, too slow for a toolbar highlight or an
    // Indent button to feel connected to the tap that caused it.
    emitCursorContext();
    emitFormatState();
    return true;
  }

  return {
    focus,
    blur,
    revealSelection,
    hasFocus,
    isComposing,
    contentElement,
    placeCaretAtCoords,
    refreshDecorations,
    resetHistory,
    exec,
  };
}

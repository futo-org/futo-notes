/*
 * The host handle: every call the embed entry point (src/editor-embed/main.ts,
 * createFutoEditorApi.ts) and the desktop shell (NoteWorkspace.svelte's
 * `EditorApi`) make on the editor. MilkdownEditor.svelte re-exports each one
 * under the same name: these are the component's exports.
 *
 * Grouped by what each call reaches: the note's content (what leaves the
 * editor, and the chrome's edits into it), which note is held, the view, find,
 * and the harness probes no shell calls. The document state they share is the
 * editor's DocumentSession.
 */
import { serializerCtx, type Editor } from '@milkdown/kit/core';
import { insert, replaceAll } from '@milkdown/kit/utils';
import { history as proseHistory, redoDepth, undoDepth } from '@milkdown/kit/prose/history';
import { EditorState, TextSelection, type PluginKey } from '@milkdown/kit/prose/state';
import type { Schema as ProseSchema } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { toWellFormedText, type DocumentRef, type FlushFailureReason } from '@futo-notes/editor';
import { endsInUnwrittenBlank } from '@futo-notes/editor/milkdown-compat';
import { WHOLE as CENSUS_WHOLE } from './chunkCensusHook';
import type { DocumentLoad } from './documentLoad';
import type { DocumentSession } from './documentSession.svelte';
import {
  closeFind as closeFindIn,
  openFind as openFindIn,
  setFindOverlayInset as setFindOverlayInsetIn,
  setFindQuery as setFindQueryIn,
  stepFind as stepFindIn,
  type FindBarState,
} from './find';
import { planMarkdownChunks, type MarkdownChunkOptions } from './markdownChunks';
import { dropBlockDndFocusGuards } from './mobileBlockDnd';
import { stripLeadingBoms } from './parseNote';
import { createDocumentSerializer, type SerializationLoop } from './serializationLoop';
import { hideTableGrips } from './table/tableGrips';
import { createToolbarExec } from './toolbarExec';
import { refreshWikilinkViews } from './wikilink';

/** The component props the handle reports through. Getters: each read is the CURRENT prop. */
export interface HostHandleProps {
  readonly nativeShell: boolean;
  readonly ondocumentloaded?: (ref: DocumentRef, source: 'load' | 'external') => void;
  readonly onflushfailed?: (ref: DocumentRef, token: string, reason: FlushFailureReason) => void;
  readonly onexternalrefused?: (ref: DocumentRef) => void;
  readonly onfindstate?: (state: FindBarState) => void;
}

export interface HostHandleDeps {
  getEditor: () => Editor | null;
  pmView: () => ProseView | null;
  emitCursorContext: () => void;
  emitFormatState: () => void;
  props: HostHandleProps;
}

/* prosemirror-history keeps its PluginKey module-private, so take it off a
 * throwaway instance of the very same plugin factory Milkdown's history
 * plugin uses — exact identity, no name matching. */
const HISTORY_KEY = proseHistory().spec.key as PluginKey<unknown>;

/** The plugin state a freshly created history plugin starts with. */
function emptyHistoryState(schema: ProseSchema): unknown {
  return HISTORY_KEY.getState(EditorState.create({ schema, plugins: [proseHistory()] }));
}

/** The note's content: what leaves the editor, and the chrome's edits into it. */
function createContentCommands(
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

/**
 * Which note the editor holds: opening one, relabeling it, and adopting the
 * host's newer text for it.
 */
function createNoteCommands(
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
   * There is no per-note undo stash: the CodeMirror
   * editor kept one (`noteHistory.ts`, keyed by note id) and this engine does
   * not.
   */
  function openNote(noteId: string | null, text: string): void {
    setContent(noteId ?? '', text);
  }

  return { setContent, retarget, applyExternalContent, openNote };
}

/** The view: focus, the caret, what the shell measures, the undo stack, toolbar commands. */
function createViewCommands(deps: HostHandleDeps) {
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

/** Find in note: what a bar renders, and the calls a bar makes. */
function createFindCommands(deps: HostHandleDeps) {
  const { pmView, props } = deps;

  /* What a find bar renders, mirrored out of the plugin by its
   * `onStateChange` and handed to whoever draws one. A projection, never the
   * source of truth: every action a bar takes comes back through the exported
   * find commands below.
   *
   * The desktop bar itself is the SHELL's chrome (NoteWorkspace.svelte), not
   * this component's: it spans the whole note pane, which is wider than the
   * editor column this component occupies. That also means the native shells
   * cannot accidentally get a web bar on top of their own — they never mount
   * NoteWorkspace. */
  let findBar: FindBarState = {
    open: false,
    query: '',
    label: '',
    hasMatches: false,
    focusToken: 0,
  };

  function emitFindState(next: Partial<FindBarState>): void {
    findBar = { ...findBar, ...next };
    props.onfindstate?.(findBar);
  }

  /* Find in note (docs/spec/editor.md). These five are the futoBridge v8 calls
   * both native shells make for their own find bars, and the desktop bar and
   * its Ctrl/Cmd+F / Ctrl/Cmd+G accelerators reach the engine through the same
   * three of them — one implementation, three platforms (M10). */
  function openFind(): void {
    const view = pmView();
    if (!view) return;
    openFindIn(view);
    /* Unconditionally, and AFTER the open: Ctrl/Cmd+F with the bar already up
     * on the same query changes nothing the plugin reports, so the bar would
     * never hear about it — and refocusing the query field is the whole point
     * of that second press (docs/spec/editor.md). */
    emitFindState({ open: true, focusToken: findBar.focusToken + 1 });
  }

  function setFindQuery(query: string): void {
    const view = pmView();
    if (view) setFindQueryIn(view, query);
  }

  function stepFind(direction: 1 | -1): void {
    const view = pmView();
    if (view) stepFindIn(view, direction);
  }

  /* The bar covering the bottom of the viewport, so a stepped-to match is
   * never scrolled UNDER it. iOS declares its bar's height here; the desktop
   * panel measures itself and reports through the same path; Android's bar is
   * a layout sibling and declares nothing. */
  function setFindOverlayInset(bottomOverlayPx: number): void {
    const view = pmView();
    if (view) setFindOverlayInsetIn(view, bottomOverlayPx);
  }

  /* `restoreOrigin` is the native shells' close (docs/spec/editor.md: closing
   * restores the editor selection and viewport from before find opened). The
   * desktop bar's own Escape passes `returnFocus` instead and leaves the
   * selection on the current match. */
  function closeFind(): void {
    const view = pmView();
    if (view) closeFindIn(view, { restoreOrigin: true });
  }

  /* The DESKTOP bar's close: leaves the selection on the current match and
   * hands focus back to the editor (docs/spec/editor.md). The native shells'
   * `closeFind` above restores the pre-find selection and viewport instead. */
  function dismissFind(): void {
    const view = pmView();
    if (view) closeFindIn(view, { returnFocus: true });
  }

  return {
    emitFindState,
    openFind,
    setFindQuery,
    stepFind,
    setFindOverlayInset,
    closeFind,
    dismissFind,
  };
}

/** The census and gauntlet harnesses' doors (src/editor-embed/main.ts); no shell calls these. */
function createHarnessProbes(
  session: DocumentSession,
  serialization: SerializationLoop,
  documentLoad: DocumentLoad,
  deps: HostHandleDeps,
) {
  const { getEditor, pmView } = deps;
  const { readSerialized } = serialization;
  const { applyExternal, endPendingLoad } = documentLoad;

  /**
   * Loads `text` with explicit chunk options and returns the editor's
   * serialization of the resulting document, plus the plan that produced it.
   *
   * The ONLY consumer is the chunk-equivalence census
   * (`scripts/milkdown-chunk-census.mjs`), which proves the claim progressive
   * open rests on: a chunked parse of a note produces the same document as a
   * whole-document parse of it. That comparison cannot go through the bridge,
   * because the bridge deliberately never hands out a serialization of an
   * unedited note — that IS the load-echo guard. `src/editor-embed/main.ts`
   * installs it only for `editor.html?census`, a URL no shell ever loads.
   *
   * Read-only with respect to the host: it never posts a message and never
   * touches `hostMarkdown` beyond what a normal load does.
   */
  function censusLoad(
    text: string,
    chunkOptions: MarkdownChunkOptions,
  ): { markdown: string | null; chunked: boolean; chunks: number; aborted: boolean } {
    const plan = planMarkdownChunks(text, chunkOptions);
    applyExternal(text, chunkOptions);
    endPendingLoad('settle');
    return {
      markdown: readSerialized(),
      chunked: plan.chunked,
      chunks: plan.chunks.length,
      aborted: session.abortedToWholeDocument,
    };
  }

  /**
   * Loads `text` as a whole document and reports the whole-document
   * serialization Milkdown's `serializerCtx` now holds (the owned serializer,
   * what `getMarkdown()` writes) next to a FRESH per-block cache's
   * serialization of the SAME document (`createDocumentSerializer`,
   * serializationLoop.ts) — the equivalence the block-serialization census
   * (`scripts/milkdown-chunk-census.mjs --serialize`) exists to measure.
   *
   * A fresh cache rather than the component's own, because the claim under
   * test is "the cache computes the same bytes as the direct call", and the
   * component's cache may already hold entries from whatever this instance
   * loaded before — reusing it would let a STALE cache entry pass unnoticed.
   * `whole` bypasses the cache entirely, so it is unaffected by any bug in it.
   *
   * Same door as `censusLoad`: read-only with respect to the host, never
   * posts a message, and installed only behind `editor.html?census`
   * (chunkCensusHook.ts).
   */
  function censusSerialize(text: string): { whole: string | null; blocks: string | null } {
    applyExternal(text, CENSUS_WHOLE);
    endPendingLoad('settle');
    const editor = getEditor();
    const view = pmView();
    if (!editor || !view) return { whole: null, blocks: null };
    try {
      const whole = editor.ctx.get(serializerCtx)(view.state.doc);
      return { whole, blocks: createDocumentSerializer(editor).serialize(view.state.doc) };
    } catch {
      return { whole: null, blocks: null };
    }
  }

  /**
   * The live ProseMirror view, for the editor gauntlet's Milkdown adapter
   * (tests/editor-gauntlet/milkdownAdapter.ts) — the permanent regression
   * suite, which drives the SAME editor.html bytes the shells ship and so has
   * no other way in.
   *
   * It exists because the gauntlet's two hardest jobs need the document model,
   * not the DOM: placing a caret at an exact position across 31k foreign notes,
   * and timing one keystroke's SYNCHRONOUS cost against the 16 ms budget. A
   * DOM-selection approximation would measure a different thing and quietly
   * change what the budget means.
   *
   * Read-only by intent and not part of the futoBridge contract; no native
   * host calls it. `main.ts` is what puts it on `window`.
   */
  function getProseMirrorView(): ProseView | null {
    return pmView();
  }

  return { censusLoad, censusSerialize, getProseMirrorView };
}

/**
 * The editor's host handle. `emitFindState` rides along for the find plugin
 * (editorPlugins.ts); every other member is one of the component's exports.
 */
export function createHostHandle(
  session: DocumentSession,
  serialization: SerializationLoop,
  documentLoad: DocumentLoad,
  deps: HostHandleDeps,
) {
  const view = createViewCommands(deps);
  const content = createContentCommands(session, serialization, documentLoad, deps);
  return {
    ...createNoteCommands(session, serialization, documentLoad, deps, {
      flush: content.flush,
      resetHistory: view.resetHistory,
    }),
    ...content,
    ...view,
    ...createFindCommands(deps),
    ...createHarnessProbes(session, serialization, documentLoad, deps),
  };
}

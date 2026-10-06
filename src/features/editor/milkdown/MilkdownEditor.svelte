<script lang="ts">
  /*
   * The FUTO Notes editor: Milkdown (ProseMirror), WYSIWYG.
   *
   * THE editor on every surface — the desktop shell mounts it through
   * `NoteWorkspace.svelte`, and the native iOS/Android shells mount the same
   * component inside `editor.html` through `src/editor-embed/main.ts`. There is
   * one engine and one plugin set, so a behavior is identical on all three by
   * construction rather than by three code paths agreeing.
   *
   * ROUND-TRIP CONTRACT (ADR-0002): Milkdown parses and re-serializes markdown
   * through remark, so saving normalizes syntax (list markers, emphasis
   * delimiters, spacing, a trailing newline). Normalizing on a real edit is
   * accepted; normalizing on OPEN is not. `getContent()` therefore returns the
   * host's ORIGINAL bytes for as long as the document is still exactly what
   * loaded, so opening and closing a note can never rewrite it on disk.
   * `editor-embed-milkdown.spec.ts` locks that.
   *
   * What lives elsewhere:
   *   - the plugin set and every ctx setting, in mount order
   *     (`editorPlugins.ts`);
   *   - block drag: the desktop ⠿ handle, the native shells' long-press drag
   *     and the one choice between them (`blockDrag.svelte.ts`, whose header
   *     lists the drag modules behind it);
   *   - the document this editor holds for the host
   *     (`documentSession.svelte.ts`) and how it becomes the markdown the host
   *     hears (`serializationLoop.ts`, whose `serialize` is the one door);
   *   - toolbar commands (`toolbarExec.ts`) and the native toolbar's
   *     active-state (`formatState.ts`).
   */
  import { onMount } from 'svelte';

  import './milkdownEditor.css';
  import { schemaCtx, serializerCtx, type Editor } from '@milkdown/kit/core';
  import { insert, replaceAll } from '@milkdown/kit/utils';
  import { history as proseHistory, redoDepth, undoDepth } from '@milkdown/kit/prose/history';
  import { EditorState, TextSelection, type PluginKey } from '@milkdown/kit/prose/state';
  import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
  import {
    Slice,
    type Node as ProseNode,
    type Schema as ProseSchema,
  } from '@milkdown/kit/prose/model';
  import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
  import { imageReferenceMarkdown, toWellFormedText } from '@futo-notes/editor';
  import {
    FRONTMATTER_NODE,
    hasSurplusTrailingEmptyParagraphs,
  } from '@futo-notes/editor/milkdown-compat';
  import {
    installVaultImageUrlResolver,
    uninstallVaultImageUrlResolver,
  } from '$features/images/vaultImageUrlResolver';
  import { deleteImage } from '$features/images/imageFiles';
  import { onFileDrop } from '$lib/platform';
  import { localizedText } from '$shared/localization';
  import { createImageInsertTarget } from '../imageInsertTarget';
  import { dismissLinkPrompt } from './linkPrompt';
  import {
    dropCarriesFiles,
    filePathsFromDrop,
    imageFilesIn,
    imagePathsIn,
    resolveImageInserter,
  } from '../imageInsert';
  import { createImagePasteHandler, resolveImagePasteSink } from '../imagePasteSink';
  import type { EditorLinkGesture } from '../editorLinkGesture';
  import { resolveBlockDragMode } from './blockDragMode';
  import { createBlockDrag } from './blockDrag.svelte';
  import { assembleEditor } from './editorPlugins';
  import { editorView, enclosingListItem } from './caretContext';
  import { inIndentableContainer } from './blockCommands';
  import { computeActiveFormats, computeDisabledFormats } from './formatState';
  import { endsWithUnwrittenLine } from './paragraphLines';
  import {
    dropBlockDndFocusGuards,
    DEFAULT_LONG_PRESS_MS,
    type MobileDndHapticKind,
  } from './mobileBlockDnd';
  import { resolveSelectionToolbar } from './selectionToolbar';
  import { resolveSlashMenu } from './slash';
  import { planMarkdownChunks, type MarkdownChunkOptions } from './markdownChunks';
  import { parseNote, stripLeadingBoms } from './parseNote';
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
  import {
    closeFind as closeFindIn,
    openFind as openFindIn,
    setFindOverlayInset as setFindOverlayInsetIn,
    setFindQuery as setFindQueryIn,
    stepFind as stepFindIn,
    type FindBarState,
    type FindMatchReport,
  } from './find';
  import { createBlockSerializer } from './blockSerializer';
  import { DocumentSession } from './documentSession.svelte';
  import { createSerializationLoop } from './serializationLoop';
  import { WHOLE as CENSUS_WHOLE } from './chunkCensusHook';
  import { CHECKBOX_SIZE_PX } from './taskCheckbox';
  import { hideTableGrips } from './table/tableGrips';
  import { createToolbarExec } from './toolbarExec';
  import { refreshWikilinkViews, WIKILINK_TARGET_ATTR } from './wikilink';
  import { WIKILINK_BROKEN_CLASS } from './wikilink/display';

  import type { DocumentRef, FlushFailureReason } from '@futo-notes/editor';

  interface Props {
    content?: string;
    onchange?: (content: string, ref: DocumentRef, flushToken?: string) => void;
    onedited?: (ref: DocumentRef) => void;
    ondocumentloaded?: (ref: DocumentRef, source: 'load' | 'external') => void;
    onflushfailed?: (ref: DocumentRef, token: string, reason: FlushFailureReason) => void;
    onexternalrefused?: (ref: DocumentRef) => void;
    onfocuschange?: (focused: boolean) => void;
    oncompositionend?: () => void;
    oncursorcontext?: (ctx: { onListLine: boolean; inContainer: boolean }) => void;
    nativeShell?: boolean;
    onopenlink?: (title: string, gesture: EditorLinkGesture) => void;
    onopenurl?: (url: string) => void;
    /* Notion-style native toolbar active-state (iOS only for now — see
     * bridge.ts FormatStateMessage and issue #104 for the Android consumer).
     * Fires deduped whenever the set of active toolbar-manifest ids at the
     * cursor/selection changes. */
    onformatstate?: (active: string[], disabled: string[]) => void;
    /* Notion-style block drag haptics, from the long-press path both native
     * shells mount (see bridge.ts HapticMessage / mobileBlockDnd.ts). */
    onhaptic?: (kind: MobileDndHapticKind) => void;
    /* Whether a block is airborne on that same long-press path. A shell whose
     * WebView runs its own text-interaction gestures suspends them while it is
     * (bridge.ts BlockDragMessage) — on iOS nothing the page can do stops the
     * OS magnifier. */
    onblockdrag?: (active: boolean) => void;
    /* Whether a finger is DOWN on a block on that same path — posted at
     * touch-down, so a shell can stand its WebView's DELAYED long-press
     * recognisers down before they can win, instead of waiting for a lift that
     * may not come (bridge.ts BlockPressMessage / mobileBlockDnd.ts). */
    onblockpress?: (pressed: boolean) => void;
    /* Find in note's `{query, current, total, label}` report, for the native
     * bars (bridge.ts FindMatchesMessage). Deduped by the engine, and posted
     * whether or not this build renders the desktop panel. */
    onfindmatches?: (report: FindMatchReport, ref: DocumentRef) => void;
    /* Everything a find bar renders, deduped. The desktop shell draws its bar
     * from this; the native shells ignore it and read `onfindmatches`. */
    onfindstate?: (state: FindBarState) => void;
    /** The note stays readable but takes no edits: its vault refuses writes. */
    readonly?: boolean;
    /* The editor engine is up and holding a document. Milkdown's
     * `Editor.make().create()` is ASYNC, so Svelte's `mount()` returns long
     * before this — and the Android WebView gate used to read the host API that
     * mount() publishes as proof the engine works. On a Chromium 83 WebView
     * that meant a blank pane and no "update System WebView" notice
     * (docs/spec/editor.md; tests/editor-embed-webview-floor.spec.ts). This is
     * the honest signal. */
    onenginemounted?: () => void;
  }

  let {
    content = '',
    onchange,
    onedited,
    ondocumentloaded,
    onflushfailed,
    onexternalrefused,
    onfocuschange,
    oncompositionend,
    oncursorcontext,
    onopenlink,
    onopenurl,
    onformatstate,
    nativeShell = false,
    onhaptic,
    onblockdrag,
    onblockpress,
    onfindmatches,
    onfindstate,
    readonly = false,
    onenginemounted,
  }: Props = $props();

  /* The props the editor's modules call back into, as getters: every call
   * reads the CURRENT prop, never the value at mount (src/AGENTS.md). */
  const liveProps = {
    get onchange() {
      return onchange;
    },
    get nativeShell() {
      return nativeShell;
    },
    get readonly() {
      return readonly;
    },
    get onfocuschange() {
      return onfocuschange;
    },
    get onfindmatches() {
      return onfindmatches;
    },
    get onhaptic() {
      return onhaptic;
    },
    get onblockdrag() {
      return onblockdrag;
    },
    get onblockpress() {
      return onblockpress;
    },
  };

  /* THE single gate: the Notion-style long-press-anywhere-on-the-block path
   * REPLACES the ⠿ gutter handle in the native shells — iOS and Android both —
   * and the two never coexist for one editor. `blockDragMode.ts` owns the
   * decision (components do not read the platform — src/AGENTS.md).
   *
   * `$derived` (not a plain top-level read) so the gutter CSS class and the
   * tap handlers stay wired to the `nativeShell` prop rather than to a
   * snapshot. Which PLUGIN gets mounted is still decided once, in onMount —
   * the embed never flips `nativeShell` on a live editor, and swapping drag
   * mechanisms under a mounted ProseMirror view is not something this
   * supports. */
  const useMobileBlockDnd = $derived(resolveBlockDragMode(nativeShell) === 'long-press');
  /* The `/` block menu, desktop only (slash/index.ts `resolveSlashMenu`).
   * Same one-shot read as useMobileBlockDnd above: the plugin set is fixed when
   * the engine is built. */
  const useSlashMenu = $derived(resolveSlashMenu(nativeShell) === 'enabled');
  /* The floating selection toolbar, desktop only (selectionToolbar/target.ts
   * `resolveSelectionToolbar`) — same gate, same one-shot read. */
  const useSelectionToolbar = $derived(resolveSelectionToolbar(nativeShell) === 'enabled');
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
    onfindstate?.(findBar);
  }

  let container: HTMLDivElement;
  let editor: Editor | null = null;

  /* The document this editor holds for the host (documentSession.svelte.ts). */
  const session = new DocumentSession();

  let onListLine: boolean | null = null;
  let inContainer: boolean | null = null;

  /* prosemirror-history keeps its PluginKey module-private, so take it off a
   * throwaway instance of the very same plugin factory Milkdown's history
   * plugin uses — exact identity, no name matching. */
  const HISTORY_KEY = proseHistory().spec.key as PluginKey<unknown>;

  /** The plugin state a freshly created history plugin starts with. */
  function emptyHistoryState(schema: ProseSchema): unknown {
    return HISTORY_KEY.getState(EditorState.create({ schema, plugins: [proseHistory()] }));
  }

  const pmView = (): ProseView | null => editorView(editor);

  /* How the live document becomes the markdown the host hears (serializationLoop.ts). */
  const serialization = createSerializationLoop(session, {
    getEditor: () => editor,
    pmView,
    emitFormatState,
    props: liveProps,
  });
  const {
    readSerialized,
    unchangedSinceLoad,
    postChange,
    startPriming,
    stopPriming,
    scheduleChangeNotification,
    cancelChangeNotification,
  } = serialization;

  /* The desktop ⠿ gutter handle (blockDrag.svelte.ts). */
  const blockDrag = createBlockDrag(pmView);

  /* ---- images ------------------------------------------------------------ *
   * Vault images are bare filenames; `vaultImageView.ts` is the ProseMirror
   * node view that resolves each one against whatever this shell serves the
   * vault over, and re-resolves itself when that arrives late. Nothing here
   * touches rendered image DOM — a post-render sweep is what the node view
   * replaced (see that file's header for the three bugs it had).
   *
   * Pasting an image is `pasteHandler` below: `imagePasteSink.ts` decides how
   * THIS host captures the bytes, and this component only inserts whatever
   * filename comes back. */
  let pasteHandler: ((event: ClipboardEvent) => boolean) | null = null;
  /* Dropping an image FILE from the OS is `dropHandler` plus `stopFileDrop`
   * below — two paths for one gesture, because the two backends deliver it
   * differently and neither is a choice this component gets to make:
   *
   *   - Every desktop platform now disables wry's native drop target
   *     (`dragDropEnabled: false` — Linux joined macOS/Windows in QA #017,
   *     2026-09-11), so the drop arrives as an ordinary HTML5 `drop` —
   *     ProseMirror's `handleDrop` prop. Chromium (macOS/Windows) populates
   *     `dataTransfer.files` with the bytes already read; WebKitGTK (Linux)
   *     does NOT — first fix attempt claimed on `text/uri-list` CONTENT, but
   *     a real capture (QA #017 follow-up, 2026-09-15) showed WebKitGTK
   *     advertises `text/uri-list` in `.types` while `getData` on it returns
   *     an empty string, and the dropped path lives only in the sibling
   *     `text/html`'s `<a>` TEXT CONTENT (no `href`) — so the drop went
   *     unclaimed and the `file:///…` text was inserted literally.
   *     `filePathsFromDrop` reads that real shape now; see its own header.
   *   - The WINDOW path (`PlatformFS`'s `onFileDrop`) stays wired as a
   *     fallback: it was Linux's ONLY path while wry's GTK relay was on, and
   *     that relay never fired at all on a native-Wayland compositor.
   *
   * Both end in `imageInsert.ts`, which is also what the `/image` picker uses.
   * Off Tauri `onFileDrop` is a no-op subscription, so nothing here branches on
   * platform (src/AGENTS.md rule 4.5). */
  let dropHandler: ((event: DragEvent) => boolean) | null = null;
  let stopFileDrop: (() => void) | null = null;
  /* Only true where this editor installed the per-file URL producer (Tauri
   * desktop), so the teardown removes exactly what the mount added. */
  let ownsImageUrlResolver = false;

  /* The note every asynchronous image completion belongs to. ONE target for
   * all three doors — clipboard paste, the `/` menu's Image item, an OS drop —
   * so the rule is stated once rather than remembered at each of them. At
   * component scope because the `/` menu plugin is built earlier in the mount
   * than the paste handler and both need it. */
  const imageTarget = createImageInsertTarget({
    documentToken: () => session.documentIdentity,
    insert: (filename) => insertMarkdown(imageReferenceMarkdown(filename)),
    discard: deleteImage,
  });

  /* Sorted comma-joined snapshot of the last emitted format-state set, so
   * emitFormatState() below can dedupe without the caller tracking it. */
  let lastFormatStateKey: string | null = null;

  /**
   * Emits deduped `formatState`. `selectionOverride`, when given, is the
   * SELECTION-JUST-APPLIED from Milkdown's `selectionUpdated` listener
   * callback — pass it explicitly rather than reading `pmView()!.state`
   * there: Milkdown's listener plugin runs that callback from inside
   * `EditorState.apply(tr)`, before the default `dispatchTransaction` calls
   * `view.updateState(...)`, so `view.state` (and its `.selection`/
   * `.storedMarks`) is still ONE TRANSACTION BEHIND at that exact call site —
   * `pmView()?.state.selection` there would report where the caret USED TO
   * BE. `mounted`/the debounced change notification/`exec()` all run outside that
   * window, so `view.state` is current for them (no override needed) — and
   * `storedMarks` is intentionally omitted (`null`) for the override case: a
   * plain selection-move transaction always clears storedMarks anyway, so
   * `selection.$from.marks()` alone is correct there, whereas `exec('bold')`
   * on a collapsed selection genuinely relies on the freshly toggled
   * `view.state.storedMarks` to report active immediately.
   *
   * Disabled ids (Undo/Redo) are computed from `view.state` directly — they
   * are not selection-dependent, so `selectionOverride` says nothing about
   * them — which means they can lag by the same one transaction the override
   * exists to correct for `active`. That is fine here: it self-heals at the
   * next debounced change notification (`reportDocumentChange`'s
   * `emitFormatState()`, called with fresh `view.state`), and the case that
   * actually matters — tapping Undo/Redo itself — runs through `exec()`,
   * which is never inside the stale window.
   */
  function emitFormatState(selectionOverride?: ProseSelection): void {
    if (!onformatstate) return;
    /* A streaming progressive open moves the selection with every chunk it
     * appends, and there is no toolbar tap behind any of it — recomputing
     * would be per-chunk work on the load path for a highlight nobody asked
     * for. The completion path emits once, for the finished document. */
    if (session.progressive?.loading) return;
    const view = pmView();
    if (!view) return;
    const selection = selectionOverride ?? view.state.selection;
    const storedMarks = selectionOverride ? null : view.state.storedMarks;
    const active = computeActiveFormats(view, selection, storedMarks);
    const disabled = computeDisabledFormats(view);
    const key = `${[...active].sort().join(',')}|${[...disabled].sort().join(',')}`;
    if (key === lastFormatStateKey) return;
    lastFormatStateKey = key;
    onformatstate(active, disabled);
  }

  /**
   * Emits deduped `cursorContext` — Indent/Outdent visibility. Takes the same
   * `selectionOverride` as `emitFormatState`, and for the same reason.
   *
   * `inContainer` is the honest name for the native toolbars' `when:
   * 'inContainer'` visibility rule (list item OR blockquote —
   * `inIndentableContainer`, blockCommands.ts); `onListLine` stays exactly
   * what it was for anything that genuinely needs list-only semantics.
   */
  function emitCursorContext(selectionOverride?: ProseSelection): void {
    const view = pmView();
    if (!view) return;
    const selection = selectionOverride ?? view.state.selection;
    const inList = enclosingListItem(selection) !== null;
    const inAnyContainer = inIndentableContainer(selection.$from);
    if (inList === onListLine && inAnyContainer === inContainer) return;
    onListLine = inList;
    inContainer = inAnyContainer;
    oncursorcontext?.({ onListLine: inList, inContainer: inAnyContainer });
  }

  const EXEC = createToolbarExec(() => editor);

  onMount(() => {
    let disposed = false;

    // Read the initial prop here rather than at the top level: the embed host
    // feeds content through setContent, and a top-level read is a Svelte 5
    // "captures only the initial value" warning.
    if (content) {
      session.pendingContent = content;
      session.hostMarkdown = content;
      session.liveMarkdown = content;
    }
    const visibility = (): void => {
      if (nativeShell && document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', flushOnPageHide);
    container.addEventListener('click', handleClick);
    container.addEventListener('auxclick', handleAuxClick);
    container.addEventListener('pointerdown', handlePointerDown);
    // Not passive: the handler must be able to preventDefault a link tap.
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchcancel', handleTouchCancel);
    container.addEventListener('touchend', handleTouchEnd, { passive: false });

    (async () => {
      const created = await assembleEditor({
        container,
        props: liveProps,
        useMobileBlockDnd: () => useMobileBlockDnd,
        useSlashMenu: () => useSlashMenu,
        useSelectionToolbar: () => useSelectionToolbar,
        getEditor: () => editor,
        getPendingContent: () => session.pendingContent,
        getPasteHandler: () => pasteHandler,
        getDropHandler: () => dropHandler,
        isLoadFailed: () => session.loadFailed,
        getCurrentNoteId: () => session.currentNoteId,
        getDocumentGeneration: () => session.documentGeneration,
        getDocumentIdentity: () => session.documentIdentity,
        imageTarget,
        pmView,
        flush,
        emitCursorContext,
        emitFormatState,
        emitFindState,
        nudgeBlockHandle: blockDrag.nudgeBlockHandle,
        documentEdited,
      }).create();

      if (disposed) {
        void created.destroy();
        return;
      }

      editor = created;
      // One cache per editor instance, built as soon as the ctx slices it
      // reads (serializerCtx/schemaCtx) exist — both are set by Milkdown's
      // own internal plugins during `.create()`, so this is always safe here.
      serialization.attach(created);
      // Here, not after the chrome below and not after the first document is
      // parsed: the question this answers is "can this WebView run the editor
      // engine", and tying it to a parse would make a big note look like an
      // unsupported WebView on a slow phone (the host's boot grace is 10 s).
      onenginemounted?.();
      if (session.pendingContent !== null) {
        applyExternal(session.pendingContent);
      }
      session.pendingContent = null;

      pasteHandler = createImagePasteHandler({
        sink: resolveImagePasteSink(),
        insertImage: imageTarget,
      });

      const imageInserter = resolveImageInserter(imageTarget);

      /* The HTML5 half (macOS/Windows/Linux). A drop carrying files, OR one
       * advertising `text/uri-list` with none (WebKitGTK's shape — see the
       * `dropHandler` declaration above), is ALWAYS claimed, images or not:
       * the browser's default for an unclaimed file drop is to navigate the
       * webview to that file, which would tear the app down mid-edit. A
       * non-image file is therefore swallowed and ignored rather than
       * inserted. The editor's OWN block drag matches neither shape — it
       * never advertises `text/uri-list` — so it is never claimed here and
       * falls through to ProseMirror's own drop handling. */
      dropHandler = (event) => {
        const transfer = event.dataTransfer;
        if (dropCarriesFiles(transfer)) {
          event.preventDefault();
          const images = imageFilesIn(transfer);
          if (images.length > 0) {
            placeCaretAtCoords(event.clientX, event.clientY);
            void imageInserter.insertFiles(images);
          }
          return true;
        }
        const paths = filePathsFromDrop(transfer);
        if (paths.length > 0) {
          event.preventDefault();
          const images = imagePathsIn(paths);
          if (images.length > 0) {
            placeCaretAtCoords(event.clientX, event.clientY);
            void imageInserter.insertPaths(images);
          }
          return true;
        }
        return false;
      };

      /* The window half (Linux). It fires for a drop anywhere on the window, so
       * this editor takes only the ones that landed on IT — a drop on the
       * sidebar is not this component's business. */
      stopFileDrop = onFileDrop(({ paths, x, y }) => {
        const box = container?.getBoundingClientRect();
        if (!box) return;
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
        placeCaretAtCoords(x, y);
        void imageInserter.insertPaths(paths);
      });
      /* Where images resolve per file rather than off a host base URL (Tauri
       * desktop), the node views need something to ask. */
      ownsImageUrlResolver = installVaultImageUrlResolver();

      if (!useMobileBlockDnd) blockDrag.mountGutterHandle(created);
    })().catch((error: unknown) => {
      // An engine that cannot build the editor is the whole reason the WebView
      // gate exists, and this used to be an unhandled rejection — invisible to
      // everything. Swallowing it is still the right shape: onenginemounted
      // never fired, so the host's probe keeps answering 'pending' and its
      // grace period turns that into the update-WebView notice.
      console.error('MilkdownEditor: the editor engine failed to start', error);
    });

    return () => {
      disposed = true;
      // No document to belong to any more, so a pending image completion is
      // abandoned rather than inserted into a destroyed editor.
      session.documentIdentity += 1;
      session.documentGeneration += 1;
      session.currentNoteId = null;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', flushOnPageHide);
      dismissLinkPrompt();
      // Same teardown `openNote`/`applyExternal` use for a pending progressive
      // load: discard rather than settle, since there is no document left to
      // finish loading into.
      endPendingLoad('discard');
      // A change notification that lands after the component is gone would
      // serialize a destroyed editor and report it as the note.
      cancelChangeNotification();
      stopPriming();
      serialization.detach();
      stopFileDrop?.();
      stopFileDrop = null;
      dropHandler = null;
      if (ownsImageUrlResolver) {
        uninstallVaultImageUrlResolver();
        ownsImageUrlResolver = false;
      }
      container.removeEventListener('click', handleClick);
      container.removeEventListener('auxclick', handleAuxClick);
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchcancel', handleTouchCancel);
      container.removeEventListener('touchend', handleTouchEnd);
      blockDrag.destroy();
      const current = editor;
      editor = null;
      void current?.destroy();
    };
  });

  /**
   * Re-asks the view for its `editable` prop after `loadFailed` or `readonly` moved.
   *
   * ProseMirror reads `editable` during `updateStateInner`, which nothing here
   * would otherwise trigger — a plain assignment to `loadFailed` leaves the
   * contenteditable exactly as it was. `setProps({})` merges nothing and
   * re-runs that pass, which is the sanctioned way to re-evaluate a direct prop.
   */
  function refreshEditable(): void {
    pmView()?.setProps({});
  }

  $effect(() => {
    void readonly;
    refreshEditable();
  });

  /** A user edit (documentChanges.ts): remember it, and report it once the document settles. */
  function documentEdited(): void {
    session.documentGeneration += 1;
    if (!session.unreported) {
      session.unreported = true;
      onedited?.(session.documentRef());
    }
    scheduleChangeNotification();
  }

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
    if (view.hasFocus() && !view.composing)
      view.dom.ownerDocument.getSelection()?.removeAllRanges();
    const { state } = view;
    view.dispatch(
      state.tr
        .replace(0, state.doc.content.size, new Slice(parsed.content, 0, 0))
        .setMeta('addToHistory', false),
    );
  }

  /**
   * Loads the whole document in one parse — what every ordinary note does.
   *
   * Returns false if the parse threw. The caller records that as a failed load
   * (`loadFailed`); the host's bytes stay the answer to `getContent()`, so a
   * note this build cannot parse is shown as unreadable rather than emptied.
   */
  function applyWholeDocument(text: string): boolean {
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
   * Whether the last chunk applied ended in an empty paragraph of its OWN — a
   * `<br />` placeholder an older build wrote as its final block. The next
   * append must then keep the live document's trailing empty paragraph rather
   * than treat it as the `trailing` plugin's (see `appendChunkContent`).
   */
  let previousChunkEndedEmpty = false;

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
    if (!editor) return;
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
      if (!session.loadFailed) ondocumentloaded?.(session.documentRef(), session.pendingLoadSource);
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
    ondocumentloaded?.(session.documentRef(), session.pendingLoadSource);
    measureOpen(OPEN_INTERACTIVE_MEASURE);
  }

  /* Tapping a task-list marker toggles it (Milkdown renders the checkbox state
   * as a `data-checked` attribute; the glyph itself is CSS). */
  /* ---- link taps --------------------------------------------------------- *
   * Wikilinks and external links share ONE activation path on purpose. The
   * reason they need a `touchend` leg at all is engine-specific and applies to
   * both: on iOS WebKit a prevented mousedown cancels the synthetic click, so a
   * click-only handler dead-ends there while Chromium double-fires
   * (docs/spec/editor.md, "Wikilinks — navigation & integrity"). Splitting the
   * two would have left external links on the leg that dead-ends. */

  type EditorLink =
    { kind: 'wikilink'; title: string; broken: boolean } | { kind: 'external'; url: string };

  /** A wikilink chip is an anchor carrying the raw target; anything else with
   * an href leaves the app. Neither is a plain caret placement. */
  function linkAt(node: HTMLElement | null): EditorLink | null {
    const anchor = node?.closest('a');
    if (!anchor) return null;
    const title = anchor.getAttribute(WIKILINK_TARGET_ATTR);
    if (title !== null) {
      return { kind: 'wikilink', title, broken: anchor.classList.contains(WIKILINK_BROKEN_CLASS) };
    }
    const href = anchor.getAttribute('href') ?? '';
    return href ? { kind: 'external', url: href } : null;
  }

  /**
   * A tap on a BROKEN wikilink must not be swallowed. The host may do nothing
   * with it — the native embed posts `openNote` only for a resolved link, a
   * known limitation — and preventing the default as well would leave a dead
   * chip that can be neither followed nor repaired, since an atom node is
   * fixed by SELECTING and replacing it, not by editing inside it. Letting
   * ProseMirror have the event keeps the spec's intent ("a broken wikilink
   * still focuses, so it can be edited") reachable in the WYSIWYG model.
   */
  function consumesTap(link: EditorLink): boolean {
    return !(link.kind === 'wikilink' && link.broken);
  }

  const NEUTRAL_GESTURE: EditorLinkGesture = {
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };

  /* A WebView can emit a click after touchend despite preventDefault. Remember
   * only that touch's anchor; independent mouse clicks must still open links. */
  let pendingTouchClick: { anchor: HTMLAnchorElement; at: number } | null = null;
  let linkTouch: {
    identifier: number;
    x: number;
    y: number;
    at: number;
    anchor: HTMLAnchorElement;
    moved: boolean;
  } | null = null;
  const SYNTHETIC_CLICK_WINDOW_MS = 700;
  const TAP_MOVE_PX = 10;

  function activateLink(link: EditorLink, gesture: EditorLinkGesture): void {
    /* Broken links are posted too: what happens next is the HOST's call —
     * desktop opens an empty editor bound to the target text, the native embed
     * drops it. The editor does not resolve here. */
    if (link.kind === 'wikilink') onopenlink?.(link.title, gesture);
    else onopenurl?.(link.url);
  }

  function handleTouchStart(event: TouchEvent): void {
    linkTouch = null;
    if (event.touches.length !== 1) return;
    const anchor = (event.target as HTMLElement | null)?.closest('a');
    const touch = event.changedTouches[0];
    if (!anchor || !touch || !linkAt(anchor)) return;
    linkTouch = {
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      at: Date.now(),
      anchor,
      moved: false,
    };
  }

  function handleTouchMove(event: TouchEvent): void {
    if (!linkTouch) return;
    const touch = Array.from(event.touches).find(
      (candidate) => candidate.identifier === linkTouch?.identifier,
    );
    if (
      !touch ||
      event.touches.length !== 1 ||
      Math.hypot(touch.clientX - linkTouch.x, touch.clientY - linkTouch.y) > TAP_MOVE_PX
    ) {
      linkTouch.moved = true;
    }
  }

  function handleTouchCancel(): void {
    linkTouch = null;
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse') pendingTouchClick = null;
  }

  function handleTouchEnd(event: TouchEvent): void {
    const started = linkTouch;
    linkTouch = null;
    const touch = Array.from(event.changedTouches).find(
      (candidate) => candidate.identifier === started?.identifier,
    );
    // A rejected hold can still produce a compatibility click on release.
    if (started && touch) pendingTouchClick = { anchor: started.anchor, at: Date.now() };
    if (
      !started ||
      !touch ||
      event.touches.length !== 0 ||
      started.moved ||
      Date.now() - started.at >= DEFAULT_LONG_PRESS_MS ||
      Math.hypot(touch.clientX - started.x, touch.clientY - started.y) > TAP_MOVE_PX ||
      !(event.target as HTMLElement | null)?.closest('a')?.isSameNode(started.anchor)
    )
      return;
    const link = linkAt(started.anchor);
    if (!link) return;
    // Also stops WebKit turning the tap into a caret placement inside the chip.
    if (consumesTap(link)) event.preventDefault();
    activateLink(link, NEUTRAL_GESTURE);
  }

  /* Task checkboxes own their own taps — see taskCheckbox.ts, whose widget
   * both draws the box and toggles it. This handler is only links and the
   * tap-to-surface-the-drag-handle behavior. */
  function handleClick(event: MouseEvent): void {
    if (event.button !== 0) return;
    handleLinkClick(event);
  }

  function handleAuxClick(event: MouseEvent): void {
    if (event.button === 1) handleLinkClick(event);
  }

  function handleLinkClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // BlockService already owns mousedown/dragstart on its own handle DOM.
    if (target.closest('.milkdown-block-handle')) return;

    const link = linkAt(target);
    if (link) {
      if (consumesTap(link)) event.preventDefault();
      const anchor = target.closest('a');
      const touchClick = pendingTouchClick;
      pendingTouchClick = null;
      if (
        event.button === 0 &&
        event.detail !== 0 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        touchClick?.anchor === anchor &&
        Date.now() - touchClick.at <= SYNTHETIC_CLICK_WINDOW_MS &&
        (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } })
          .sourceCapabilities?.firesTouchEvents !== false
      )
        return;
      activateLink(link, {
        button: event.button === 1 ? 1 : 0,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
      return;
    }

    // No hover on mobile — surface the drag handle for whatever block was
    // tapped. Not applicable under the long-press path (no handle).
    if (!useMobileBlockDnd) blockDrag.nudgeBlockHandle(event.clientY);
  }

  // ---- handle consumed by src/editor-embed ------------------------------- //

  function flushOnPageHide(): void {
    if (nativeShell) flush();
  }

  export function getDocumentRef(): DocumentRef {
    return session.documentRef();
  }

  export function setContent(noteId: string, text: string): void {
    if (editor && holdsExactly(text)) {
      if (session.currentNoteId === noteId) return;
      if (session.unreported && nativeShell) flush();
      session.currentNoteId = noteId;
      session.documentGeneration += 1;
      ondocumentloaded?.(session.documentRef(), 'load');
      return;
    }
    // A streaming edited departure pays the remaining parse before changing identity.
    if (
      session.currentNoteId !== null &&
      session.currentNoteId !== noteId &&
      session.unreported &&
      nativeShell
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
  export function retarget(fromId: string, toId: string): void {
    if (session.currentNoteId !== fromId || fromId === toId) return;
    session.currentNoteId = toId;
    session.documentGeneration += 1;
    flush();
  }

  export function applyExternalContent(
    noteId: string,
    text: string,
    expectedGeneration: number,
  ): void {
    if (
      session.currentNoteId !== noteId ||
      session.documentGeneration !== expectedGeneration ||
      session.unreported
    ) {
      onexternalrefused?.(session.documentRef());
      return;
    }
    const identical = holdsExactly(text);
    session.documentGeneration += 1;
    session.pendingLoadSource = 'external';
    if (identical) ondocumentloaded?.(session.documentRef(), 'external');
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
    if (
      view &&
      (hasSurplusTrailingEmptyParagraphs(view.state.doc) || endsWithUnwrittenLine(view.state.doc))
    ) {
      return false;
    }
    return text === readSerialized();
  }

  export function flush(token?: string): void {
    const fail = (reason: FlushFailureReason): void => {
      if (token !== undefined) onflushfailed?.(session.documentRef(), token, reason);
    };
    if (session.currentNoteId === null || !editor) {
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

  export function getContent(): string | undefined {
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
     * message, locked in the listener above). Neither branch below can return
     * a prefix. */
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

  export function focus(): void {
    dropBlockDndFocusGuards(); // a host focus is intentional (R10-FB20-1)
    pmView()?.focus();
  }

  /*
   * The mobile shells' keyboard dismiss. It ends the editing session on the
   * page as well as the keyboard: no caret, no highlighted range or cell
   * selection, and no table grips left where a tap put them. A selection
   * survives a bare DOM blur, and so do its decorations and selection handles.
   */
  export function blur(): void {
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
  export function revealSelection(): void {
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
  export function hasFocus(): boolean {
    return (pmView()?.hasFocus() ?? false) && document.hasFocus();
  }

  export function isComposing(): boolean {
    return Boolean(pmView()?.composing);
  }

  export function insertMarkdown(text: string): void {
    // Chrome must not write into a document that is not the note (`loadFailed`).
    if (!editor || session.loadFailed) return;
    editor.action(insert(stripLeadingBoms(text)));
    pmView()?.focus();
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
  export function openNote(noteId: string | null, text: string): void {
    setContent(noteId ?? '', text);
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
  export function applyEdit(text: string): void {
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

  /** The editable element itself, for shell chrome that measures against it. */
  export function contentElement(): HTMLElement | null {
    return pmView()?.dom ?? null;
  }

  /**
   * Put the caret at viewport coordinates, for shell chrome sitting OUTSIDE
   * the editor whose slack reaches into it (the desktop tag bar). Returns
   * false when the point resolves to no text position.
   */
  export function placeCaretAtCoords(x: number, y: number): boolean {
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
  export function refreshDecorations(): void {
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
  export function resetHistory(): void {
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

  /**
   * Loads `text` with explicit chunk options and returns Milkdown's
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
  export function censusLoad(
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
   * Loads `text` as a whole document and reports Milkdown's OWN serialization
   * of the result next to a FRESH `BlockSerializer`'s serialization of the
   * SAME document — the equivalence the block-serialization census
   * (blockSerializer.ts, `scripts/milkdown-chunk-census.mjs --serialize`)
   * exists to measure.
   *
   * A fresh serializer rather than the component's own `blockSerializer`,
   * because the claim under test is "the cache computes the same bytes as the
   * direct call", and the component's cache may already hold entries from
   * whatever this instance loaded before — reusing it would let a STALE cache
   * entry pass unnoticed. `whole` bypasses `blockSerializer` entirely by
   * calling the ctx-provided serializer directly, so it is unaffected by any
   * bug this module might have.
   *
   * Same door as `censusLoad`: read-only with respect to the host, never
   * posts a message, and installed only behind `editor.html?census`
   * (chunkCensusHook.ts).
   */
  export function censusSerialize(text: string): { whole: string | null; blocks: string | null } {
    applyExternal(text, CENSUS_WHOLE);
    endPendingLoad('settle');
    const view = pmView();
    if (!editor || !view) return { whole: null, blocks: null };
    try {
      const schema = editor.ctx.get(schemaCtx);
      const rawSerialize = editor.ctx.get(serializerCtx);
      const whole = rawSerialize(view.state.doc);
      const fresh = createBlockSerializer({
        serializeDoc: (doc) => rawSerialize(doc),
        createDoc: (nodes) => schema.topNodeType.create(null, nodes),
      });
      return { whole, blocks: fresh.serialize(view.state.doc) };
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
  export function getProseMirrorView(): ProseView | null {
    return pmView();
  }

  /* Find in note (docs/spec/editor.md). These five are the futoBridge v8 calls
   * both native shells make for their own find bars, and the desktop bar and
   * its Ctrl/Cmd+F / Ctrl/Cmd+G accelerators reach the engine through the same
   * three of them — one implementation, three platforms (M10). */
  export function openFind(): void {
    const view = pmView();
    if (!view) return;
    openFindIn(view);
    /* Unconditionally, and AFTER the open: Ctrl/Cmd+F with the bar already up
     * on the same query changes nothing the plugin reports, so the bar would
     * never hear about it — and refocusing the query field is the whole point
     * of that second press (docs/spec/editor.md). */
    emitFindState({ open: true, focusToken: findBar.focusToken + 1 });
  }

  export function setFindQuery(query: string): void {
    const view = pmView();
    if (view) setFindQueryIn(view, query);
  }

  export function stepFind(direction: 1 | -1): void {
    const view = pmView();
    if (view) stepFindIn(view, direction);
  }

  /* The bar covering the bottom of the viewport, so a stepped-to match is
   * never scrolled UNDER it. iOS declares its bar's height here; the desktop
   * panel measures itself and reports through the same path; Android's bar is
   * a layout sibling and declares nothing. */
  export function setFindOverlayInset(bottomOverlayPx: number): void {
    const view = pmView();
    if (view) setFindOverlayInsetIn(view, bottomOverlayPx);
  }

  /* `restoreOrigin` is the native shells' close (docs/spec/editor.md: closing
   * restores the editor selection and viewport from before find opened). The
   * desktop bar's own Escape passes `returnFocus` instead and leaves the
   * selection on the current match. */
  export function closeFind(): void {
    const view = pmView();
    if (view) closeFindIn(view, { restoreOrigin: true });
  }

  /* The DESKTOP bar's close: leaves the selection on the current match and
   * hands focus back to the editor (docs/spec/editor.md). The native shells'
   * `closeFind` above restores the pre-find selection and viewport instead. */
  export function dismissFind(): void {
    const view = pmView();
    if (view) closeFindIn(view, { returnFocus: true });
  }

  export function exec(commandId: string): boolean {
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
</script>

<!-- The click handler is attached in onMount (see handleClick): it fires on
     ProseMirror-generated children, which the markup never sees. -->
<!-- `mobile-dnd` is the ONE mechanism that tells the stylesheet the ⠿ gutter
     handle does not exist for this instance, so the left padding can drop back
     to match the right (see the .ProseMirror padding rule below). It is driven
     by the SAME `useMobileBlockDnd` gate that swaps the plugin, so the gutter
     and the thing that needs the gutter can never disagree. -->
<!-- `--futo-checkbox-slot` is set here, from taskCheckbox.ts's own constant, so
     the tap-target size the widget promises and the list padding that makes
     room for it cannot drift apart. -->
<div
  class="futo-milkdown"
  class:mobile-dnd={useMobileBlockDnd}
  class:handle-pressed={blockDrag.handlePress !== 'idle'}
  style="--futo-checkbox-slot: {CHECKBOX_SIZE_PX}px"
  bind:this={container}
  oncompositionend={() => oncompositionend?.()}
>
  <!-- The streaming tail of a large note (progressiveLoad.ts). Absolutely
       positioned so it never enters the editor's layout, and rendered inside
       the container the same way the block-drag ghost is. `polite` rather than
       `assertive`: it is reassurance, not an interruption of typing. -->
  {#if session.streamingTail}
    <div class="milkdown-stream-tail" role="status" aria-live="polite">
      <span class="milkdown-stream-tail-dot" aria-hidden="true"></span>
      {localizedText('editor.progressiveLoad.loadingRest')}
    </div>
  {/if}

  <!-- A note this build's parser threw on. Says so instead of showing a blank
       editable page, which is what a reader took for an empty note right
       before the save pipeline made it one (2026-09-03). The editable is
       read-only underneath (`editable` in editorViewOptionsCtx), and the file
       on disk is untouched. → docs/spec/editor.md -->
  {#if session.loadFailed}
    <div class="milkdown-load-failed" role="alert">
      <strong>{localizedText('editor.loadFailed.heading')}</strong>
      {localizedText('editor.loadFailed.body')}
    </div>
  {/if}
</div>

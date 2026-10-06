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
   *     (`documentSession.svelte.ts`), how host content becomes it
   *     (`documentLoad.ts`), and how it becomes the markdown the host hears
   *     (`serializationLoop.ts`, whose `serialize` is the one door);
   *   - every call the embed and the desktop shell make, which this component
   *     re-exports by name (`hostHandle.ts`);
   *   - toolbar commands (`toolbarExec.ts`) and the native toolbar's
   *     active-state (`formatState.ts`).
   */
  import { onMount } from 'svelte';

  import './milkdownEditor.css';
  import type { Editor } from '@milkdown/kit/core';
  import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
  import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
  import { imageReferenceMarkdown } from '@futo-notes/editor';
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
  import { DEFAULT_LONG_PRESS_MS, type MobileDndHapticKind } from './mobileBlockDnd';
  import { resolveSelectionToolbar } from './selectionToolbar';
  import { resolveSlashMenu } from './slash';
  import type { FindBarState, FindMatchReport } from './find';
  import { DocumentSession } from './documentSession.svelte';
  import { createSerializationLoop } from './serializationLoop';
  import { createDocumentLoad } from './documentLoad';
  import { createHostHandle } from './hostHandle';
  import { CHECKBOX_SIZE_PX } from './taskCheckbox';
  import { WIKILINK_TARGET_ATTR } from './wikilink';
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
    get onedited() {
      return onedited;
    },
    get ondocumentloaded() {
      return ondocumentloaded;
    },
    get onflushfailed() {
      return onflushfailed;
    },
    get onexternalrefused() {
      return onexternalrefused;
    },
    get onfindstate() {
      return onfindstate;
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

  let container: HTMLDivElement;
  let editor: Editor | null = null;

  /* The document this editor holds for the host (documentSession.svelte.ts). */
  const session = new DocumentSession();

  let onListLine: boolean | null = null;
  let inContainer: boolean | null = null;

  const pmView = (): ProseView | null => editorView(editor);

  /* How the live document becomes the markdown the host hears (serializationLoop.ts). */
  const serialization = createSerializationLoop(session, {
    getEditor: () => editor,
    pmView,
    emitFormatState,
    props: liveProps,
  });
  /* How host content becomes the document (documentLoad.ts). */
  const documentLoad = createDocumentLoad(session, serialization, {
    getEditor: () => editor,
    pmView,
    emitFormatState,
    refreshEditable,
    props: liveProps,
  });
  /* Everything the embed and the desktop shell call (hostHandle.ts), exported
   * under the same names. */
  const hostHandle = createHostHandle(session, serialization, documentLoad, {
    getEditor: () => editor,
    pmView,
    emitCursorContext,
    emitFormatState,
    props: liveProps,
  });
  export const {
    getDocumentRef,
    setContent,
    retarget,
    applyExternalContent,
    flush,
    getContent,
    focus,
    blur,
    revealSelection,
    hasFocus,
    isComposing,
    insertMarkdown,
    openNote,
    applyEdit,
    contentElement,
    placeCaretAtCoords,
    refreshDecorations,
    resetHistory,
    censusLoad,
    censusSerialize,
    getProseMirrorView,
    openFind,
    setFindQuery,
    stepFind,
    setFindOverlayInset,
    closeFind,
    dismissFind,
    exec,
  } = hostHandle;

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
   * `emitFormatState()` in serializationLoop.ts, called with fresh
   * `view.state`), and the case that
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

  function flushOnPageHide(): void {
    if (nativeShell) flush();
  }

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
        emitFindState: hostHandle.emitFindState,
        nudgeBlockHandle: blockDrag.nudgeBlockHandle,
        documentEdited: serialization.documentEdited,
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
        documentLoad.applyExternal(session.pendingContent);
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
      documentLoad.endPendingLoad('discard');
      // A change notification that lands after the component is gone would
      // serialize a destroyed editor and report it as the note.
      serialization.cancelChangeNotification();
      serialization.stopPriming();
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

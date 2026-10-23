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
   *   - link taps and clicks (`linkTaps.ts`);
   *   - toolbar commands (`toolbarExec.ts`) and the native toolbar's
   *     active-state (`formatState.ts`).
   */
  import { onMount } from 'svelte';

  import './milkdownEditor.css';
  import type { Editor } from '@milkdown/kit/core';
  import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
  import { imageReferenceMarkdown } from '@futo-notes/editor';
  import { deleteImage } from '$features/images/imageFiles';
  import { localizedText } from '$shared/localization';
  import { createImageInsertTarget } from '../imageInsertTarget';
  import { dismissLinkPrompt } from './linkPrompt';
  import { resolveBlockDragMode } from './blockDragMode';
  import { createBlockDrag } from './blockDrag.svelte';
  import { landPendingDrop } from './blockDragSession';
  import { assembleEditor } from './editorPlugins';
  import { editorView } from './caretContext';
  import { resolveSelectionToolbar } from './selectionToolbar';
  import { resolveSlashMenu } from './slash';
  import { DocumentSession } from './documentSession.svelte';
  import { createSerializationLoop } from './serializationLoop';
  import { createDocumentLoad } from './documentLoad';
  import { createInteractionHold } from './interactionHold';
  import { createYieldingIdleScheduler } from './progressiveLoad';
  import { createHostHandle } from './hostHandle';
  import { createLinkTaps } from './linkTaps';
  import { CHECKBOX_SIZE_PX } from './taskCheckbox';
  import type { Props } from './milkdownEditorProps';
  import { createEditorEmitters } from './editorEmitters';
  import { createImageInput } from './imageInput';

  let props: Props = $props();

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
  const useMobileBlockDnd = $derived(
    resolveBlockDragMode(props.nativeShell ?? false) === 'long-press',
  );
  /* The `/` block menu, desktop only (slash/index.ts `resolveSlashMenu`).
   * Same one-shot read as useMobileBlockDnd above: the plugin set is fixed when
   * the engine is built. */
  const useSlashMenu = $derived(resolveSlashMenu(props.nativeShell ?? false) === 'enabled');
  /* The floating selection toolbar, desktop only (selectionToolbar/target.ts
   * `resolveSelectionToolbar`) — same gate, same one-shot read. */
  const useSelectionToolbar = $derived(
    resolveSelectionToolbar(props.nativeShell ?? false) === 'enabled',
  );

  let container: HTMLDivElement;
  let editor: Editor | null = null;

  /* The document this editor holds for the host (documentSession.svelte.ts). */
  const session = new DocumentSession();

  const pmView = (): ProseView | null => editorView(editor);

  const { emitFormatState, emitCursorContext } = createEditorEmitters({
    pmView,
    session,
    props,
  });

  /* Background idle work — the streamed tail of a progressive open, the
   * serializer's cache priming — yields to the user's touch
   * (interactionHold.ts): a tap into a still-streaming note gets its frames. */
  const interactionHold = createInteractionHold();
  const scheduleIdle = createYieldingIdleScheduler(interactionHold.isHeld);
  /* How the live document becomes the markdown the host hears (serializationLoop.ts). */
  const serialization = createSerializationLoop(session, {
    getEditor: () => editor,
    pmView,
    emitFormatState,
    props,
    scheduleIdle,
  });
  /* How host content becomes the document (documentLoad.ts). */
  const documentLoad = createDocumentLoad(session, serialization, {
    getEditor: () => editor,
    pmView,
    emitFormatState,
    refreshEditable,
    props,
    scheduleIdle,
  });
  /* Everything the embed and the desktop shell call (hostHandle.ts), exported
   * under the same names. */
  const hostHandle = createHostHandle(session, serialization, documentLoad, {
    getEditor: () => editor,
    pmView,
    emitCursorContext,
    emitFormatState,
    props,
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
    isStreaming,
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

  /* Link taps (linkTaps.ts): listeners on the container, added in onMount. */
  const {
    handleClick,
    handleAuxClick,
    handlePointerDown,
    handleTouchStart,
    handleTouchMove,
    handleTouchCancel,
    handleTouchEnd,
  } = createLinkTaps({
    props,
    useMobileBlockDnd: () => useMobileBlockDnd,
    nudgeBlockHandle: blockDrag.nudgeBlockHandle,
  });

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

  const imageInput = createImageInput({
    imageTarget,
    placeCaretAtCoords,
    getContainer: () => container,
  });

  /** The page is going away or out of sight: a block drop still landing
   * commits now (its slides may never end: a hidden page's animation clock
   * stops), and a native shell's note is flushed. */
  function pageLeaving(): void {
    landPendingDrop(pmView());
    if (props.nativeShell) flush();
  }

  onMount(() => {
    let disposed = false;

    // Read the initial prop here rather than at the top level: the embed host
    // feeds content through setContent, and a top-level read is a Svelte 5
    // "captures only the initial value" warning.
    if (props.content) {
      session.pendingContent = props.content;
      session.hostMarkdown = props.content;
      session.liveMarkdown = props.content;
    }
    const visibility = (): void => {
      if (document.visibilityState === 'hidden') pageLeaving();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pageLeaving);
    const detachInteractionHold = interactionHold.attach(container);
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
        props,
        useMobileBlockDnd: () => useMobileBlockDnd,
        useSlashMenu: () => useSlashMenu,
        useSelectionToolbar: () => useSelectionToolbar,
        getEditor: () => editor,
        getPasteHandler: imageInput.getPasteHandler,
        getDropHandler: imageInput.getDropHandler,
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
      props.onenginemounted?.();
      if (session.pendingContent !== null) {
        documentLoad.applyExternal(session.pendingContent);
      }
      session.pendingContent = null;

      imageInput.install();

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
      window.removeEventListener('pagehide', pageLeaving);
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
      imageInput.dispose();
      detachInteractionHold();
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
    void props.readonly;
    refreshEditable();
  });

  /* Tapping a task-list marker toggles it (Milkdown renders the checkbox state
   * as a `data-checked` attribute; the glyph itself is CSS). */
</script>

<!-- The click handler is attached in onMount (see handleClick, linkTaps.ts): it
     fires on ProseMirror-generated children, which the markup never sees. -->
<!-- `mobile-dnd` is the ONE mechanism that tells the stylesheet the ⠿ gutter
     handle does not exist for this instance, so the left padding can drop back
     to match the right (see the .ProseMirror padding rule in milkdownEditor.css). It is driven
     by the SAME `useMobileBlockDnd` gate that swaps the plugin, so the gutter
     and the thing that needs the gutter can never disagree. -->
<!-- `--futo-checkbox-slot` is set here, from taskCheckbox.ts's own constant, so
     the tap-target size the widget promises and the list padding that makes
     room for it cannot drift apart. -->
<div
  class="futo-milkdown"
  class:mobile-dnd={useMobileBlockDnd}
  style="--futo-checkbox-slot: {CHECKBOX_SIZE_PX}px"
  bind:this={container}
  oncompositionend={() => props.oncompositionend?.()}
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

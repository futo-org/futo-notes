<script lang="ts">
  import { EditorView } from '@codemirror/view';
  import {
    EditorSelection,
    EditorState,
    type Extension,
    type SelectionRange,
  } from '@codemirror/state';
  import { redoDepth, undoDepth } from '@codemirror/commands';
  import { onMount } from 'svelte';
  import { preloadImages, liveMarkdownRefresh } from './liveMarkdownTransform';
  import { getImageWebPath } from '$features/images/imageFiles';
  import {
    buildSetContentTransaction,
    readDocContent,
    EXTERNAL_CONTENT_OPTS,
    type SetEditorContentOptions,
  } from './editorContentSync';
  import { hasFileSystem } from '$lib/platform';
  import { toggleBold, toggleItalic, toggleStrikethrough } from './markdownToolbar';
  import type { EditorLinkGesture } from './interactions/editorPointerInteractions';
  import { EditorScrollAnchoring } from './interactions/scrollAnchoring';
  import { createMarkdownEditorRuntime } from './createMarkdownEditorRuntime';
  import { createNoteHistoryStore, restoreState } from './noteHistory';
  import { swapEditorState } from './swapEditorState';
  import { desktopLocalization } from '$shared/localization';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
    onfocuschange?: (focused: boolean) => void;
    oncompositionend?: () => void;
    oncursorcontext?: (ctx: { onListLine: boolean }) => void;
    scrollParent?: HTMLElement | null;
    nativeShell?: boolean;
    onopenlink: (title: string, gesture: EditorLinkGesture) => void;
    onopenurl?: (url: string) => void;
  }

  type DevelopmentEditorWindow = typeof window & {
    __cmToggle?: (view: EditorView, name: string) => void;
    __cmGetView?: () => EditorView | null;
  };

  let {
    content = '',
    onchange,
    onfocuschange,
    oncompositionend,
    oncursorcontext,
    scrollParent = null,
    nativeShell = false,
    onopenlink,
    onopenurl,
  }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = $state(null);
  let extensions: Extension | null = null;
  let openNoteId: string | null = null;
  const noteHistory = createNoteHistoryStore();

  let editorOwnsContent = false;

  let scrollAnchoring: EditorScrollAnchoring | null = null;
  let refreshLocalization: ((editorView: EditorView) => void) | null = null;

  onMount(() => {
    preloadImages(content, hasFileSystem ? getImageWebPath : undefined, () => view);
    const runtime = createMarkdownEditorRuntime({
      nativeShell,
      getView: () => view,
      getOnChange: () => onchange,
      getOnFocusChange: () => onfocuschange,
      getOnCursorContext: () => oncursorcontext,
      getOnOpenUrl: () => onopenurl,
      openWikilink: (title, gesture) => onopenlink(title, gesture),
      onEditorContentChange: () => {
        editorOwnsContent = true;
      },
    });
    const currentScrollAnchoring = runtime.scrollAnchoring;
    scrollAnchoring = currentScrollAnchoring;
    refreshLocalization = runtime.refreshLocalization;

    extensions = runtime.extensions;
    const v = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: runtime.extensions,
      }),
      parent: container,
    });

    view = v;
    currentScrollAnchoring.attachView(v);

    if (!nativeShell) {
      requestAnimationFrame(() => {
        if (!view) return;
        view.focus();
        if (!view.hasFocus) {
          view.contentDOM.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        }
        onfocuschange?.(runtime.editorHasDomFocus(view));
      });
    }

    if (import.meta.env.DEV) {
      const w = window as DevelopmentEditorWindow;
      w.__cmToggle = (v: EditorView, name: string) => {
        const fns: Record<string, (v: EditorView) => void> = {
          bold: toggleBold,
          italic: toggleItalic,
          strikethrough: toggleStrikethrough,
        };
        fns[name]?.(v);
      };
      w.__cmGetView = () => view;
    }

    return () => {
      runtime.destroy();
      if (scrollAnchoring === currentScrollAnchoring) scrollAnchoring = null;
      refreshLocalization = null;
      noteHistory.clear();
      extensions = null;
      openNoteId = null;
      view?.destroy();
      view = null;
    };
  });

  $effect(() => {
    desktopLocalization.effectiveLanguage.tag;
    if (view && refreshLocalization) refreshLocalization(view);
  });

  $effect(() => {
    if (!view) return;
    const c = content;
    if (editorOwnsContent) {
      editorOwnsContent = false;
      if (view.state.doc.length === c.length) return;
    }
    setContent(c, EXTERNAL_CONTENT_OPTS);
  });

  $effect(() => {
    const anchoring = scrollAnchoring;
    const sp = scrollParent;
    if (!anchoring) return;
    return anchoring.connectScrollParent(sp);
  });

  // Swaps the whole state rather than editing the document, so opening a note leaves no
  // undo entry.
  export function openNote(noteId: string | null, text: string): void {
    const v = view;
    const exts = extensions;
    if (!v || !exts) return;
    if (openNoteId) noteHistory.save(openNoteId, v.state);
    openNoteId = noteId;
    scrollAnchoring?.resetAnchor();
    swapEditorState(v, restoreState(text, exts, noteId ? noteHistory.take(noteId) : undefined));
    scrollAnchoring?.scheduleWarm();
    if (text) {
      const getImageFn = hasFileSystem ? getImageWebPath : undefined;
      queueMicrotask(() => preloadImages(text, getImageFn, () => v));
    }
  }

  export function retargetOpenNote(fromId: string | null, toId: string): void {
    if (fromId) noteHistory.rename(fromId, toId);
    if (openNoteId === fromId) openNoteId = toId;
  }

  export function forgetNoteHistory(noteIds: readonly string[]): void {
    for (const id of noteIds) {
      noteHistory.forget(id);
      if (openNoteId === id) openNoteId = null;
    }
  }

  // For hosts that switch notes without naming one. Two notes can hold identical text, so
  // this rebuilds around the live doc instead of keying off a content change.
  export function resetHistory(): void {
    const v = view;
    const exts = extensions;
    if (!v || !exts) return;
    openNoteId = null;
    if (undoDepth(v.state) === 0 && redoDepth(v.state) === 0) return;
    swapEditorState(
      v,
      EditorState.create({ doc: v.state.doc, selection: v.state.selection, extensions: exts }),
    );
  }

  export function setContent(text: string, options: SetEditorContentOptions = {}): void {
    if (!view) return;
    const result = buildSetContentTransaction(view.state, text, options);
    if (!result) return;
    if (!options.preserveSelection) {
      scrollAnchoring?.resetAnchor();
    }
    view.dispatch(result.spec);
    if (!options.preserveSelection) scrollAnchoring?.scheduleWarm();
    const preloadText = result.insertedText;
    if (preloadText) {
      const getImageFn = hasFileSystem ? getImageWebPath : undefined;
      const viewRef = view;
      queueMicrotask(() => preloadImages(preloadText, getImageFn, () => viewRef));
    }
  }

  export function focus(): void {
    if (!view) return;
    view.focus();
    if (!view.hasFocus) {
      view.contentDOM.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    }
  }

  export function refreshDecorations(): void {
    if (!view) return;
    view.dispatch({ effects: liveMarkdownRefresh.of(null) });
  }

  export function blur(): void {
    if (view) {
      view.contentDOM.blur();
      view.dom.blur();
    }
  }

  export function getContent(): string | undefined {
    return readDocContent(view);
  }

  export function hasFocus(): boolean {
    return view?.hasFocus ?? false;
  }

  export function isComposing(): boolean {
    return Boolean(view?.composing || view?.compositionStarted);
  }

  export function getView(): EditorView | null {
    return view;
  }

  export function warmScroll(): { grew: number; steps: number } | null {
    return scrollAnchoring?.warmNow() ?? null;
  }

  export function getSelection(): { from: number; to: number } | null {
    if (!view) return null;
    const sel = view.state.selection.main;
    return { from: sel.from, to: sel.to };
  }

  export function setSelection(from: number, to: number): void {
    if (!view) return;
    const len = view.state.doc.length;
    const clampedFrom = Math.max(0, Math.min(from, len));
    const clampedTo = Math.max(0, Math.min(to, len));
    view.dispatch({
      selection: { anchor: clampedFrom, head: clampedTo },
    });
  }

  export function setCaret(at: SelectionRange): void {
    if (!view) return;
    view.dispatch({ selection: EditorSelection.create([at]) });
  }
</script>

<div bind:this={container} oncompositionend={() => oncompositionend?.()}></div>

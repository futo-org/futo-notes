<script lang="ts">
  import { EditorView } from '@codemirror/view';
  import { EditorState, Transaction } from '@codemirror/state';
  import { onMount } from 'svelte';
  import { preloadImages, liveMarkdownRefresh } from './liveMarkdownTransform';
  import { getImageWebPath } from '$features/images/imageFiles';
  import {
    buildSetContentTransaction,
    readDocContent,
    type SetEditorContentOptions,
  } from './editorContentSync';
  import { hasFileSystem } from '$lib/platform';
  import { toggleBold, toggleItalic, toggleStrikethrough } from './markdownToolbar';
  import { EditorLinkInteractions } from './interactions/linkInteractions';
  import { EditorPointerSelection } from './interactions/pointerSelection';
  import { EditorScrollAnchoring } from './interactions/scrollAnchoring';
  import { createMarkdownEditorRuntime } from './createMarkdownEditorRuntime';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
    onfocuschange?: (focused: boolean) => void;
    oncursorcontext?: (ctx: { onListLine: boolean }) => void;
    scrollParent?: HTMLElement | null;
    nativeShell?: boolean;
    onopenlink: (title: string, event: MouseEvent) => void;
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
    oncursorcontext,
    scrollParent = null,
    nativeShell = false,
    onopenlink,
    onopenurl,
  }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = $state(null);

  let editorOwnsContent = false;

  let linkInteractions: EditorLinkInteractions | null = null;
  let scrollAnchoring: EditorScrollAnchoring | null = null;

  const EXTERNAL_UPDATE_OPTS: SetEditorContentOptions = {
    preserveSelection: true,
    annotations: [Transaction.addToHistory.of(false)],
  };

  onMount(() => {
    preloadImages(content, hasFileSystem ? getImageWebPath : undefined, () => view);
    const runtime = createMarkdownEditorRuntime({
      nativeShell,
      getView: () => view,
      getOnChange: () => onchange,
      getOnFocusChange: () => onfocuschange,
      getOnCursorContext: () => oncursorcontext,
      getOnOpenUrl: () => onopenurl,
      openWikilink: (title, event) => onopenlink(title, event),
      onEditorContentChange: () => {
        editorOwnsContent = true;
      },
    });
    const currentLinkInteractions = runtime.linkInteractions;
    linkInteractions = currentLinkInteractions;
    const currentScrollAnchoring = runtime.scrollAnchoring;
    scrollAnchoring = currentScrollAnchoring;

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

    const pointerSelection = new EditorPointerSelection({
      view: v,
      onBlur: () => onfocuschange?.(false),
    });
    if (!nativeShell) {
      pointerSelection.attach();
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
      import('../../../factory/driver/futoNotes').then(({ installDriver }) => {
        if (view) installDriver(view);
      });
    }

    return () => {
      runtime.destroy();
      pointerSelection.destroy();
      if (linkInteractions === currentLinkInteractions) linkInteractions = null;
      if (scrollAnchoring === currentScrollAnchoring) scrollAnchoring = null;
      view?.destroy();
      view = null;
    };
  });

  $effect(() => {
    if (!view) return;
    const c = content;
    if (editorOwnsContent) {
      editorOwnsContent = false;
      if (view.state.doc.length === c.length) return;
    }
    setContent(c, EXTERNAL_UPDATE_OPTS);
  });

  $effect(() => {
    const anchoring = scrollAnchoring;
    const sp = scrollParent;
    if (!anchoring) return;
    return anchoring.connectScrollParent(sp);
  });

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

  export function placeCaretAtEnd(): void {
    if (!view) return;
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    });
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
</script>

<div bind:this={container}></div>

<script lang="ts">
  import {
    EditorView,
    keymap,
    drawSelection,
    Decoration,
    MatchDecorator,
    ViewPlugin
  } from '@codemirror/view';
  import type { DecorationSet, ViewUpdate } from '@codemirror/view';
  import { EditorState, Transaction } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { onMount } from 'svelte';
  import { listContinuationKeymap } from '$lib/listContinuation';
  import { tableRendering } from '$lib/tableRenderingField';
  import { liveMarkdownTransform, preloadImages } from '$lib/liveMarkdownTransform';
  import { getImageWebPath } from '$lib/fileSystem';
  import { buildSetContentTransaction, type SetEditorContentOptions, type SetContentResult } from '$lib/editorContentSync';
  import { hasFileSystem, isTauri } from '$lib/platform';
  import { toggleBold, toggleItalic, toggleStrikethrough, isListLine } from '$lib/markdownToolbar';
  import { imagePasteHandler } from '$lib/imagePaste';
  import { openUrl } from '$lib/openUrl';
  import { wikilinkAutocomplete } from '$lib/wikilinkAutocomplete';
  import { typingLatencyExtension } from '$lib/typingLatency';
  import { completionKeymap } from '@codemirror/autocomplete';
  import { navigate } from '../router';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
    oncursorcontext?: (ctx: { onListLine: boolean }) => void;
    scrollParent?: HTMLElement | null;
  }

  let { content = '', onchange, oncursorcontext, scrollParent = null }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = $state(null);

  // When true, the next $effect trigger for `content` is from our own
  // onchange callback — the editor already has this content, skip the
  // round-trip through buildSetContentTransaction entirely.
  let editorOwnsContent = false;

  // Coalesce rapid doc changes (paste, composition, multi-cursor) into
  // a single onchange + toString() per animation frame.
  let onchangeRafId = 0;

  // Pre-allocated options for external content updates — avoids object
  // allocation per $effect trigger.
  const EXTERNAL_UPDATE_OPTS: SetEditorContentOptions = {
    preserveSelection: true,
    annotations: [Transaction.addToHistory.of(false)],
  };

  // Scroll compensation — see docs/devlog.md
  let anchorPos = -1;
  let anchorBlockTop = 0;
  let compensating = false;
  let userScrolling = false;
  let scrollTimer: number | null = null;

  const PLAIN_URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,!?;:]/g;
  const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^)\s]+)(?:\s+"[^"]*")?\)/g;

  const autoLinkMatcher = new MatchDecorator({
    regexp: PLAIN_URL_REGEX,
    decoration: Decoration.mark({ class: 'cm-md-link cm-md-autolink' })
  });

  const autoLinkHighlight = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(v: EditorView) {
      this.decorations = autoLinkMatcher.createDeco(v);
    }
    update(update: ViewUpdate) {
      this.decorations = autoLinkMatcher.updateDeco(update, this.decorations);
    }
  }, {
    decorations: (v) => v.decorations
  });

  function normalizeUrl(url: string): string {
    return url.startsWith('www.') ? `https://${url}` : url;
  }

  function findUrlAtPosition(v: EditorView, pos: number): string | null {
    const line = v.state.doc.lineAt(pos);
    const lineOffset = pos - line.from;
    const text = line.text;

    const markdownRegex = new RegExp(MARKDOWN_LINK_REGEX.source, 'g');
    let markdownMatch: RegExpExecArray | null;
    while ((markdownMatch = markdownRegex.exec(text)) !== null) {
      const linkText = markdownMatch[1];
      const url = markdownMatch[2];
      const fullStart = markdownMatch.index;
      const linkTextStart = fullStart + 1;
      const linkTextEnd = linkTextStart + linkText.length;
      if (lineOffset >= linkTextStart && lineOffset <= linkTextEnd) {
        return normalizeUrl(url);
      }
    }

    const plainRegex = new RegExp(PLAIN_URL_REGEX.source, 'g');
    let plainMatch: RegExpExecArray | null;
    while ((plainMatch = plainRegex.exec(text)) !== null) {
      const matchText = plainMatch[0];
      const start = plainMatch.index;
      const end = start + matchText.length;
      if (lineOffset >= start && lineOffset <= end) {
        return normalizeUrl(matchText);
      }
    }

    return null;
  }

  function openExternalUrl(url: string): void {
    openUrl(url);
  }

  const wikilinkClickHandler = EditorView.domEventHandlers({
    mousedown: (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.cm-md-wikilink')) {
        event.preventDefault();
        return true;
      }
      return false;
    },
    click: (event) => {
      const target = event.target as HTMLElement | null;
      const wikilink = target?.closest('.cm-md-wikilink') as HTMLElement | null;
      if (wikilink) {
        const title = wikilink.getAttribute('data-wikilink');
        if (title) {
          event.preventDefault();
          event.stopPropagation();
          navigate('/note/' + encodeURIComponent(title));
          return true;
        }
      }
      return false;
    }
  });

  const linkClickHandler = EditorView.domEventHandlers({
    mousedown: (event, v) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('a.cm-md-table-link')) return false;
      const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const url = findUrlAtPosition(v, pos);
      if (!url) return false;
      event.preventDefault();
      return true;
    },
    click: (event, v) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('a.cm-md-table-link')) return false;
      const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const url = findUrlAtPosition(v, pos);
      if (!url) return false;
      event.preventDefault();
      event.stopPropagation();
      openExternalUrl(url);
      return true;
    }
  });

  function updateScrollAnchor(v: EditorView) {
    const sp = scrollParent;
    if (!sp || compensating) return;
    // How far into the editor is the top of the visible viewport?
    const vpTop = sp.getBoundingClientRect().top - v.dom.getBoundingClientRect().top;
    if (vpTop > 0) {
      try {
        const block = v.lineBlockAtHeight(vpTop);
        anchorPos = block.from;
        anchorBlockTop = block.top;
      } catch {
        anchorPos = -1;
      }
    } else {
      anchorPos = -1;
    }
  }

  onMount(() => {
    preloadImages(content, hasFileSystem ? getImageWebPath : undefined, () => view);

    // Reset anchor state for new editor
    anchorPos = -1;
    anchorBlockTop = 0;
    compensating = false;

    const extensions = [
      drawSelection(),
      listContinuationKeymap,
      history(),
      keymap.of([
        { key: 'Mod-b', run: (v) => { toggleBold(v); return true; } },
        { key: 'Mod-i', run: (v) => { toggleItalic(v); return true; } },
        { key: 'Mod-Shift-s', run: (v) => { toggleStrikethrough(v); return true; } },
        indentWithTab,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown({ base: markdownLanguage }),
      liveMarkdownTransform,
      autoLinkHighlight,
      tableRendering,
      wikilinkAutocomplete(),
      imagePasteHandler,
      wikilinkClickHandler,
      linkClickHandler,
      EditorView.contentAttributes.of({
        autocorrect: 'on',
        autocapitalize: 'sentences',
        spellcheck: 'false',
        enterkeyhint: 'return'
      }),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: 'auto', fontSize: '18px' },
        '.cm-content': {
          padding: '0',
          fontFamily: "'Outfit', 'GeneralSans', system-ui, sans-serif",
        },
        '.cm-focused': { outline: 'none' }
      }),
      // Scroll compensation (see docs/devlog.md)
      EditorView.updateListener.of(update => {
        const sp = scrollParent;
        if (!sp) return;

        // Only compensate for rendering-induced height changes, not user edits or active scrolling
        if (update.heightChanged && !update.docChanged && !userScrolling && anchorPos >= 0 && anchorPos <= update.state.doc.length) {
          try {
            const block = update.view.lineBlockAt(anchorPos);
            const delta = block.top - anchorBlockTop;
            if (Math.abs(delta) > 0.5) {
              compensating = true;
              sp.scrollTop += delta;
              anchorBlockTop = block.top;
              requestAnimationFrame(() => { compensating = false; });
            }
          } catch { /* anchor position might be invalid after large edits */ }
        }

        updateScrollAnchor(update.view);
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && onchange) {
          editorOwnsContent = true;
          // Coalesce rapid changes into one toString() + onchange per frame.
          // Paste, IME composition, and multi-cursor edits can fire multiple
          // docChanged updates in the same frame — this avoids O(n) string
          // allocation for each intermediate state.
          if (!onchangeRafId) {
            onchangeRafId = requestAnimationFrame(() => {
              onchangeRafId = 0;
              if (view) onchange(view.state.doc.toString());
            });
          }
        }
      }),
      // Typing latency measurement (dev only)
      ...(import.meta.env.DEV ? typingLatencyExtension() : []),
      // Cursor context detection for toolbar
      EditorView.updateListener.of((() => {
        let lastOnList = false;
        return (update: ViewUpdate) => {
          if (!update.selectionSet && !update.docChanged) return;
          const line = update.state.doc.lineAt(update.state.selection.main.head);
          const onList = isListLine(line.text);
          if (onList !== lastOnList) {
            lastOnList = onList;
            // Read lazily — not tracked as $effect dependency
            oncursorcontext?.({ onListLine: onList });
          }
        };
      })())
    ];

    const v = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions
      }),
      parent: container
    });

    view = v;

    if (import.meta.env.DEV) {
      const w = window as any;
      w.__cmToggle = (v: EditorView, name: string) => {
        const fns: Record<string, (v: EditorView) => void> = { bold: toggleBold, italic: toggleItalic, strikethrough: toggleStrikethrough };
        fns[name]?.(v);
      };
      w.__cmGetView = () => view;
    }

    return () => {
      if (onchangeRafId) { cancelAnimationFrame(onchangeRafId); onchangeRafId = 0; }
      view?.destroy();
      view = null;
    };
  });

  $effect(() => {
    if (!view) return;
    // Read `content` to ensure Svelte tracks it as a dependency,
    // but skip the work if this change originated from the editor itself
    // (the editor already has this content — no round-trip needed).
    const c = content;
    if (editorOwnsContent) { editorOwnsContent = false; return; }
    setContent(c, EXTERNAL_UPDATE_OPTS);
  });

  $effect(() => {
    const v = view;
    const sp = scrollParent;
    if (!v || !sp) return;

    const onScroll = () => {
      userScrolling = true;
      if (scrollTimer !== null) clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => { userScrolling = false; scrollTimer = null; }, 150);
      updateScrollAnchor(v);
    };
    sp.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      sp.removeEventListener('scroll', onScroll);
      if (scrollTimer !== null) { clearTimeout(scrollTimer); scrollTimer = null; }
    };
  });

  export function setContent(text: string, options: SetEditorContentOptions = {}): void {
    if (!view) return;
    const result = buildSetContentTransaction(view.state, text, options);
    if (!result) return;
    // Only reset scroll compensation for note switches (full replacement).
    // Same-note sync updates (preserveSelection) should keep the scroll position.
    if (!options.preserveSelection) {
      anchorPos = -1;
      anchorBlockTop = 0;
      compensating = false;
    }
    view.dispatch(result.spec);
    // Defer image preloading — only scan the inserted text (not the full doc)
    // so incremental sync updates don't re-scan the entire document.
    const preloadText = result.insertedText;
    if (preloadText) {
      const getImageFn = hasFileSystem ? getImageWebPath : undefined;
      const viewRef = view;
      queueMicrotask(() => preloadImages(preloadText, getImageFn, () => viewRef));
    }
  }

  export function focus(): void {
    view?.focus();
  }

  export function blur(): void {
    if (view) {
      view.contentDOM.blur();
      view.dom.blur();
    }
  }

  export function getContent(): string {
    return view?.state.doc.toString() ?? '';
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
</script>

<div bind:this={container}></div>

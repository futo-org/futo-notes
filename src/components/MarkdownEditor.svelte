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
  import { cursorMotionKeymap } from '$lib/cursorMotion';
  import { interactiveTableEditor } from '$lib/editorUX/tableEditor';
  import { selectionToolbar } from '$lib/editorUX/selectionToolbar';
  import { slashMenu } from '$lib/editorUX/slashMenu';
  import { blockHandle } from '$lib/editorUX/blockHandle';
  import { liveMarkdownTransform, preloadImages, setInlineSelectionDragging } from '$lib/liveMarkdownTransform';
  import { getImageWebPath } from '$lib/fileSystem';
  import { buildSetContentTransaction, type SetEditorContentOptions, type SetContentResult } from '$lib/editorContentSync';
  import { hasFileSystem, isTauri } from '$lib/platform';
  import { toggleBold, toggleItalic, toggleStrikethrough, isListLine } from '$lib/markdownToolbar';
  import { imagePasteHandler } from '$lib/imagePaste';
  import { openUrl } from '$lib/openUrl';
  import { wikilinkAutocomplete } from '$lib/wikilinkAutocomplete';
  import { acceptCompletion, completionKeymap } from '@codemirror/autocomplete';
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
  const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^()\s]*(?:\([^)]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/g;

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

  const INLINE_STYLED_SELECTOR = '.cm-md-emphasis, .cm-md-strong, .cm-md-strikethrough, .cm-md-code';
  const EXTERNAL_LINK_SELECTOR = '.cm-md-link:not(.cm-md-wikilink)';
  const VISIBLE_LINE_EDGE_SELECTOR = [
    '.cm-md-wikilink',
    EXTERNAL_LINK_SELECTOR,
    INLINE_STYLED_SELECTOR,
    '.cm-md-tag',
    '.cm-md-task-checkbox-wrapper',
    '.cm-md-image-wrapper'
  ].join(', ');

  function getFirstTextNode(root: Node): Text | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      if (current.textContent && current.textContent.length > 0) {
        return current as Text;
      }
      current = walker.nextNode();
    }
    return null;
  }

  function getTextOffsetAtPoint(textNode: Text, x: number): number {
    const textLength = textNode.textContent?.length ?? 0;
    let bestOffset = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let offset = 0; offset <= textLength; offset += 1) {
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const distance = Math.abs(rect.left - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestOffset = offset;
      }
    }

    return bestOffset;
  }

  function findInlineStyledElementAtPoint(target: Element | null, x: number, y: number): Element | null {
    const line = target?.closest('.cm-line');
    if (!line) return null;

    for (const candidate of line.querySelectorAll(INLINE_STYLED_SELECTOR)) {
      const rect = candidate.getBoundingClientRect();
      if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) {
        return candidate;
      }
    }

    return null;
  }

  function findExternalLinkElementAtPoint(target: Element | null, x: number, y: number): Element | null {
    const line = target?.closest('.cm-line');
    if (!line) return null;

    for (const candidate of line.querySelectorAll(EXTERNAL_LINK_SELECTOR)) {
      const rect = candidate.getBoundingClientRect();
      if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) {
        return candidate;
      }
    }

    return null;
  }

  function getInlineStyledPosition(v: EditorView, event: MouseEvent): number | null {
    const targetNode = event.target as Node | null;
    const target =
      targetNode instanceof Element ? targetNode : targetNode?.parentElement ?? null;
    if (!target || target.closest('.cm-md-link')) return null;

    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const inline =
      findInlineStyledElementAtPoint(hit, event.clientX, event.clientY) ??
      findInlineStyledElementAtPoint(target, event.clientX, event.clientY) ??
      hit?.closest(INLINE_STYLED_SELECTOR) ??
      target.closest(INLINE_STYLED_SELECTOR);
    if (!inline) return null;

    const textNode = getFirstTextNode(inline);
    if (!textNode) return null;

    const visibleLength = textNode.textContent?.length ?? 0;
    const rawStart = v.posAtDOM(textNode, 0);
    const rawEnd = v.posAtDOM(textNode, visibleLength);
    const hiddenMarkerChars = Math.max(0, rawEnd - rawStart - visibleLength);
    const contentStart = rawStart + Math.floor(hiddenMarkerChars / 2);
    const contentEnd = rawEnd - Math.ceil(hiddenMarkerChars / 2);
    const offset = getTextOffsetAtPoint(textNode, event.clientX);

    return Math.min(contentStart + offset, contentEnd);
  }

  function getRenderedLineRight(line: HTMLElement): number | null {
    let right: number | null = null;

    for (const candidate of line.querySelectorAll(VISIBLE_LINE_EDGE_SELECTOR)) {
      const rect = (candidate as HTMLElement).getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      right = right === null ? rect.right : Math.max(right, rect.right);
    }

    if (right !== null) return right;

    const walker = document.createTreeWalker(line, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();

    while (current) {
      if (current instanceof HTMLElement) {
        if (
          current === line ||
          current.classList.contains('cm-md-marker-hidden') ||
          current.classList.contains('cm-md-marker-widget')
        ) {
          current = walker.nextNode();
          continue;
        }

        const rect = current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          right = right === null ? rect.right : Math.max(right, rect.right);
        }
      } else if (current instanceof Text) {
        const parent = current.parentElement;
        if (
          current.textContent &&
          parent &&
          !parent.closest('.cm-md-marker-hidden, .cm-md-marker-widget')
        ) {
          const range = document.createRange();
          range.selectNodeContents(current);
          for (const rect of range.getClientRects()) {
            if (rect.width <= 0 && rect.height <= 0) continue;
            right = right === null ? rect.right : Math.max(right, rect.right);
          }
        }
      }

      current = walker.nextNode();
    }

    return right;
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

  const tripleClickLineSelectionHandler = EditorView.domEventHandlers({
    mousedown: (event, v) => {
      if (event.button !== 0 || event.detail !== 3) return false;

      const targetNode = event.target as Node | null;
      const target =
        targetNode instanceof Element ? targetNode : targetNode?.parentElement ?? null;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const lineCandidate = (hit?.closest('.cm-line') ?? target?.closest('.cm-line')) as HTMLElement | null;
      if (!lineCandidate) return false;

      let linePos: number | null = null;
      try {
        linePos = v.posAtDOM(lineCandidate, 0);
      } catch {
        try {
          linePos = v.posAtCoords({ x: event.clientX, y: event.clientY });
        } catch {
          linePos = null;
        }
      }
      if (linePos === null) return false;

      const line = v.state.doc.lineAt(linePos);
      event.preventDefault();
      v.focus();
      requestAnimationFrame(() => {
        if (!view) return;
        v.dispatch({ selection: { anchor: line.from, head: line.to } });
      });
      return true;
    }
  });

  // Place cursor at end-of-line when the user clicks in the empty space past the
  // last character. Split across two events:
  //   - `mousedown`: measure the rendered line-end (while live-markdown decorations
  //     are still applied — focusing the editor can drop them via
  //     `selectionTouchesRange`). Does not preventDefault so drag still works.
  //   - `click`: if the pointer never moved (no drag) and was past the visible
  //     right edge, jump the caret to line.to.
  let lineEndPending: {
    clientX: number;
    clientY: number;
    visibleRight: number;
    lineTo: number;
  } | null = null;

  const lineEndClickHandler = EditorView.domEventHandlers({
    mousedown: (event, v) => {
      lineEndPending = null;
      if (event.button !== 0 || event.detail !== 1) return false;

      const targetNode = event.target as Node | null;
      const target =
        targetNode instanceof Element ? targetNode : targetNode?.parentElement ?? null;
      const lineEl = target?.closest('.cm-line') as HTMLElement | null;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const lineCandidate = (hit?.closest('.cm-line') ?? lineEl) as HTMLElement | null;
      if (!lineCandidate) return false;

      let linePos: number | null = null;
      try {
        linePos = v.posAtDOM(lineCandidate, 0);
      } catch {
        try {
          linePos = v.posAtCoords({ x: event.clientX, y: event.clientY });
        } catch {
          linePos = null;
        }
      }
      if (linePos === null) return false;

      const line = v.state.doc.lineAt(linePos);
      const visibleRight = getRenderedLineRight(lineCandidate);
      if (visibleRight === null || event.clientX <= visibleRight + 1) return false;

      lineEndPending = {
        clientX: event.clientX,
        clientY: event.clientY,
        visibleRight,
        lineTo: line.to,
      };
      return false;
    },
    click: (event, v) => {
      const pending = lineEndPending;
      lineEndPending = null;
      if (!pending) return false;
      if (event.button !== 0 || event.detail !== 1) return false;
      // If the user dragged a selection, don't override it
      if (!v.state.selection.main.empty) return false;
      // If the click point moved significantly from mousedown, treat as a drag
      // and don't jump the caret.
      if (
        Math.abs(event.clientX - pending.clientX) > 2 ||
        Math.abs(event.clientY - pending.clientY) > 2
      ) {
        return false;
      }

      event.preventDefault();
      v.dispatch({ selection: { anchor: pending.lineTo } });
      return true;
    }
  });

  const inlineStyledClickHandler = EditorView.domEventHandlers({
    click: (event, v) => {
      if (event.detail !== 1 || !v.state.selection.main.empty) return false;
      const pos = getInlineStyledPosition(v, event);
      if (pos === null) return false;

      event.preventDefault();
      event.stopPropagation();
      requestAnimationFrame(() => {
        if (!view) return;
        v.focus();
        v.dispatch({ selection: { anchor: pos } });
      });
      return true;
    }
  });

  // Resolve a click on an external link element to its URL, using the
  // element itself (not posAtCoords, which is unreliable when the live
  // markdown decoration has not yet been dropped/re-applied by focus changes).
  function resolveLinkUrlFromElement(v: EditorView, link: Element): string | null {
    try {
      const offsetStart = v.posAtDOM(link, 0);
      const offsetEnd = v.posAtDOM(link, link.childNodes.length);
      // Use the midpoint so we're safely inside the rendered link text.
      const pos = Math.floor((offsetStart + offsetEnd) / 2);
      return findUrlAtPosition(v, pos);
    } catch {
      return null;
    }
  }

  // Stash the URL found on mousedown so the click handler can open it even
  // if focusing the editor drops the live-markdown decoration between the
  // two events (which would otherwise leave no `.cm-md-link` at the point).
  let pendingLinkUrl: string | null = null;

  const linkClickHandler = EditorView.domEventHandlers({
    mousedown: (event, v) => {
      pendingLinkUrl = null;
      const targetNode = event.target as Node | null;
      const target =
        targetNode instanceof Element ? targetNode : targetNode?.parentElement ?? null;
      if (target?.closest('a.cm-md-table-link')) return false;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const link =
        findExternalLinkElementAtPoint(hit, event.clientX, event.clientY) ??
        findExternalLinkElementAtPoint(target, event.clientX, event.clientY) ??
        hit?.closest(EXTERNAL_LINK_SELECTOR) ??
        target?.closest(EXTERNAL_LINK_SELECTOR);
      if (!link) return false;
      const url = resolveLinkUrlFromElement(v, link);
      if (!url) return false;
      pendingLinkUrl = url;
      // Prevent the default cursor placement so the editor doesn't focus
      // and drop the live-markdown link decoration before `click` fires.
      event.preventDefault();
      return true;
    },
    click: (event, v) => {
      const url = pendingLinkUrl;
      pendingLinkUrl = null;
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

  let pointerSelectionSettleTimer: number | null = null;

  function clearPointerSelectionSettleTimer(): void {
    if (pointerSelectionSettleTimer !== null) {
      clearTimeout(pointerSelectionSettleTimer);
      pointerSelectionSettleTimer = null;
    }
  }

  function schedulePointerSelectionSettle(v: EditorView): void {
    clearPointerSelectionSettleTimer();
    pointerSelectionSettleTimer = window.setTimeout(() => {
      pointerSelectionSettleTimer = null;
      setInlineSelectionDragging(v, false, true);
    }, 0);
  }

  const pointerSelectionTrackingHandler = EditorView.domEventHandlers({
    mousedown: (event, v) => {
      if (event.button !== 0) return false;
      clearPointerSelectionSettleTimer();
      // Defer flipping the `display:contents` flag until after CM6's native
      // mousedown handler has run. Flattening inline markdown spans before
      // CM6 calls `posAtCoords` for the mousedown shifts the anchor — a
      // backward drag starting next to rendered *italic*/**bold** would
      // otherwise anchor at the opening marker instead of the clicked char.
      // The flag is flipped on the next microtask so any following mousemove
      // sees the flattened layout, which is what the drag-selection fix
      // originally relied on.
      queueMicrotask(() => setInlineSelectionDragging(v, true, true));
      return false;
    }
  });

  onMount(() => {
    preloadImages(content, hasFileSystem ? getImageWebPath : undefined, () => view);

    // Reset anchor state for new editor
    anchorPos = -1;
    anchorBlockTop = 0;
    compensating = false;

    const extensions = [
      drawSelection(),
      cursorMotionKeymap,
      listContinuationKeymap,
      history(),
      keymap.of([
        { key: 'Mod-b', run: (v) => { toggleBold(v); return true; } },
        { key: 'Mod-i', run: (v) => { toggleItalic(v); return true; } },
        { key: 'Mod-Shift-s', run: (v) => { toggleStrikethrough(v); return true; } },
        { key: 'Tab', run: acceptCompletion },
        indentWithTab,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown({ base: markdownLanguage }),
      liveMarkdownTransform,
      autoLinkHighlight,
      interactiveTableEditor,
      selectionToolbar,
      slashMenu,
      // Fine-pointer only: attaches a document-wide pointermove listener that
      // calls posAtCoords + getBoundingClientRect on every move. On touch
      // devices the hover-to-reveal UX is unreachable anyway and every
      // scroll-drag pointermove triggers forced layout — a major source of
      // mobile jank. `(pointer: fine)` is true for mouse/trackpad (desktop,
      // Playwright) and false for touch-only Android/iOS.
      ...(typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches
        ? [blockHandle]
        : []),
      wikilinkAutocomplete(),
      imagePasteHandler,
      pointerSelectionTrackingHandler,
      tripleClickLineSelectionHandler,
      inlineStyledClickHandler,
      lineEndClickHandler,
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

    // Focus the editor on mount so the caret is visible immediately.
    // CM6 only renders `.cm-cursor` when the editor is focused; without this,
    // a fresh note shows no caret until the user clicks inside.
    v.focus();

    const onGlobalMouseUp = () => {
      schedulePointerSelectionSettle(v);
    };
    const onGlobalBlur = () => {
      clearPointerSelectionSettleTimer();
      setInlineSelectionDragging(v, false, true);
    };
    window.addEventListener('mouseup', onGlobalMouseUp, true);
    window.addEventListener('blur', onGlobalBlur);

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
      clearPointerSelectionSettleTimer();
      window.removeEventListener('mouseup', onGlobalMouseUp, true);
      window.removeEventListener('blur', onGlobalBlur);
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
    if (editorOwnsContent) {
      editorOwnsContent = false;
      // Safety: fall through to sync if programmatic setContent failed.
      if (view.state.doc.length === c.length) return;
    }
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

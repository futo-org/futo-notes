<script lang="ts">
  import {
    EditorView,
    keymap,
    drawSelection,
    Decoration,
    ViewPlugin
  } from '@codemirror/view';
  import type { DecorationSet, ViewUpdate } from '@codemirror/view';
  import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { syntaxTree } from '@codemirror/language';
  import { onMount } from 'svelte';
  import { markdownEditorLanguageExtensions } from '$lib/codeMirrorMarkdown';
  import { listContinuationKeymap, orderedListRenumber } from '$lib/listContinuation';
  import { imeShieldPlugin } from '$lib/imeShield';
  import { cursorMotionKeymap } from '$lib/cursorMotion';
  import { interactiveTableEditor } from '$lib/editorUX/tableEditor';
  import { selectionToolbar } from '$lib/editorUX/selectionToolbar';
  import { slashMenu } from '$lib/editorUX/slashMenu';
  import {
    liveMarkdownTransform,
    preloadImages,
    clearSelectionRevealFreeze,
    freezeSelectionReveal,
    liveMarkdownRefresh,
    setSuppressSelectionReveal
  } from '$lib/liveMarkdownTransform';
  import { getImageWebPath } from '$lib/fileSystem';
  import { buildSetContentTransaction, type SetEditorContentOptions, type SetContentResult } from '$lib/editorContentSync';
  import { hasFileSystem, isMobile, isTauri } from '$lib/platform';
  import { toggleBold, toggleItalic, toggleStrikethrough, isListLine } from '$lib/markdownToolbar';
  import { imagePasteHandler } from '$lib/imagePaste';
  import { openUrl } from '$lib/openUrl';
  import { wikilinkAutocomplete } from '$lib/wikilinkAutocomplete';
  import { acceptCompletion, completionKeymap } from '@codemirror/autocomplete';
  import { navigate } from '../router';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
    onfocuschange?: (focused: boolean) => void;
    oncursorcontext?: (ctx: { onListLine: boolean }) => void;
    scrollParent?: HTMLElement | null;
    /**
     * Called when the user clicks a wikilink. The shell decides whether
     * to navigate in-place or open in a new tab based on the event's
     * modifier / button state. If omitted, falls back to in-place navigation.
     */
    onopenlink?: (title: string, event: MouseEvent) => void;
  }

  let { content = '', onchange, onfocuschange, oncursorcontext, scrollParent = null, onopenlink }: Props = $props();

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

  function editorHasDomFocus(v: EditorView): boolean {
    const active = document.activeElement;
    return v.hasFocus || active === v.contentDOM || v.dom.contains(active);
  }

  // Decorate bare URLs as autolinks — but skip URLs that are the target
  // of a markdown link (`[text](url)`) or that sit inside an inline
  // code span (`` `https://x.com` ``) or a fenced/indented code block.
  function buildAutolinkDecorations(view: EditorView): DecorationSet {
    const ranges: Array<{ from: number; to: number }> = [];
    const tree = syntaxTree(view.state);
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      // Mark out byte ranges occupied by markdown-link URLs so we can
      // skip plain-URL matches that fall inside them.
      const linkUrlRanges: Array<[number, number]> = [];
      const mdRe = new RegExp(MARKDOWN_LINK_REGEX.source, 'g');
      let mdMatch: RegExpExecArray | null;
      while ((mdMatch = mdRe.exec(text)) !== null) {
        const urlStart = mdMatch.index + mdMatch[0].indexOf('](') + 2;
        const urlEnd = mdMatch.index + mdMatch[0].length - 1;
        linkUrlRanges.push([from + urlStart, from + urlEnd]);
      }
      const inMdLink = (pos: number) =>
        linkUrlRanges.some(([s, e]) => pos >= s && pos < e);
      // A URL that falls inside a CodeBlock / FencedCode / InlineCode
      // syntax node isn't a link — it's source text.
      const inCode = (pos: number) => {
        let hit = false;
        tree.iterate({
          from: pos, to: pos + 1,
          enter: (node) => {
            if (/^(InlineCode|FencedCode|CodeBlock)$/.test(node.name)) hit = true;
          },
        });
        return hit;
      };
      const plainRe = new RegExp(PLAIN_URL_REGEX.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = plainRe.exec(text)) !== null) {
        const matchFrom = from + m.index;
        const matchTo = matchFrom + m[0].length;
        if (inMdLink(matchFrom)) continue;
        if (inCode(matchFrom)) continue;
        ranges.push({ from: matchFrom, to: matchTo });
      }
    }
    return Decoration.set(
      ranges.map((r) =>
        Decoration.mark({ class: 'cm-md-link cm-md-autolink' }).range(r.from, r.to),
      ),
      true,
    );
  }

  const autoLinkHighlight = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(v: EditorView) {
      this.decorations = buildAutolinkDecorations(v);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildAutolinkDecorations(update.view);
      }
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

  function getRenderedLineRight(line: HTMLElement): number | null {
    let right: number | null = null;

    // Inline-styled and widget-like spans (links, bold, images, etc.) still
    // need explicit rect lookups because some — image/checkbox wrappers — have
    // no text node the walker can range over.
    for (const candidate of line.querySelectorAll(VISIBLE_LINE_EDGE_SELECTOR)) {
      const rect = (candidate as HTMLElement).getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      right = right === null ? rect.right : Math.max(right, rect.right);
    }

    // Always walk the full line for plain text after styled spans (e.g.
    // `**bold** trailing text` — the styled span's right edge is mid-line,
    // so without walking text we'd treat clicks on "trailing text" as past
    // line-end and snap the caret to line.to.
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();

    while (current) {
      if (current instanceof HTMLElement) {
        if (current === line || current.classList.contains('cm-md-marker-widget')) {
          current = walker.nextNode();
          continue;
        }

        const rect = current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          right = right === null ? rect.right : Math.max(right, rect.right);
        }
      } else if (current instanceof Text) {
        const parent = current.parentElement;
        if (current.textContent && parent && !parent.closest('.cm-md-marker-widget')) {
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

  function dispatchWikilinkOpen(title: string, event: MouseEvent): void {
    if (onopenlink) {
      onopenlink(title, event);
    } else {
      navigate('/note/' + encodeURIComponent(title));
    }
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
      const title = wikilink?.getAttribute('data-wikilink');
      if (!title) return false;
      event.preventDefault();
      event.stopPropagation();
      dispatchWikilinkOpen(title, event);
      return true;
    },
    // CodeMirror's `click` event does not fire for middle-click. Catch it
    // separately so middle-click on a wikilink opens in a new tab.
    auxclick: (event) => {
      if (event.button !== 1) return false;
      const target = event.target as HTMLElement | null;
      const wikilink = target?.closest('.cm-md-wikilink') as HTMLElement | null;
      const title = wikilink?.getAttribute('data-wikilink');
      if (!title) return false;
      event.preventDefault();
      event.stopPropagation();
      dispatchWikilinkOpen(title, event);
      return true;
    }
  });

  function getLineAtMouseEvent(event: MouseEvent, v: EditorView) {
    const targetNode = event.target as Node | null;
    const target =
      targetNode instanceof Element ? targetNode : targetNode?.parentElement ?? null;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const lineCandidate = (hit?.closest('.cm-line') ?? target?.closest('.cm-line')) as HTMLElement | null;
    if (!lineCandidate) return null;

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
    if (linePos === null) return null;

    return v.state.doc.lineAt(linePos);
  }

  function selectLineFromMouseEvent(event: MouseEvent, v: EditorView): boolean {
    if (event.button !== 0 || event.detail !== 3) return false;

    const line = getLineAtMouseEvent(event, v);
    if (!line) return false;

    event.preventDefault();
    event.stopPropagation();
    v.focus();
    window.setTimeout(() => {
      if (!view) return;
      v.dispatch({ selection: { anchor: line.from, head: line.to } });
    }, 0);
    return true;
  }

  const tripleClickLineSelectionHandler = EditorView.domEventHandlers({
    mousedown: selectLineFromMouseEvent,
    click: selectLineFromMouseEvent
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
      if (!v.state.selection.main.empty) return false;
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

  // Android Chrome's native tap-to-caret in contenteditable falls back to
  // position 0 on empty lines and on lines made up of widget-replaced
  // syntax. posAtCoords lenient-mode returns the nearest doc position but
  // can still drift to a neighbour when the tap lands in the vertical gap
  // between a tall paragraph and a short empty line. Resolve the .cm-line
  // under the tap explicitly, then map x within that exact line.
  function resolveTapPosition(event: MouseEvent, v: EditorView): number | null {
    const line = getLineAtMouseEvent(event, v);
    if (!line) return v.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    if (line.from === line.to) return line.from;
    const lineEl =
      (document.elementFromPoint(event.clientX, event.clientY) as Element | null)
        ?.closest?.('.cm-line') as HTMLElement | null;
    if (!lineEl) return line.from;
    const rect = lineEl.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX, rect.left + 1), rect.right - 1);
    const y = rect.top + rect.height / 2;
    return v.posAtCoords({ x, y }, false) ?? line.from;
  }
  const mobileTapCaretCorrection = isMobile
    ? [EditorView.domEventHandlers({
        click: (event, v) => {
          if (event.button !== 0 || event.detail !== 1) return false;
          if (pendingLinkUrl !== null || lineEndPending !== null) return false;
          const sel = v.state.selection.main;
          if (!sel.empty) return false;
          const desired = resolveTapPosition(event, v);
          if (desired === null || desired === sel.head) return false;
          v.dispatch({ selection: { anchor: desired }, scrollIntoView: false });
          return false;
        }
      })]
    : [];

  // Resolve a click on an external link element to its URL via the element
  // itself — posAtCoords is unreliable when the live-markdown decoration
  // hasn't yet been dropped/re-applied by focus changes.
  function resolveLinkUrlFromElement(v: EditorView, link: Element): string | null {
    try {
      const offsetStart = v.posAtDOM(link, 0);
      const offsetEnd = v.posAtDOM(link, link.childNodes.length);
      const pos = Math.floor((offsetStart + offsetEnd) / 2);
      return findUrlAtPosition(v, pos);
    } catch {
      return null;
    }
  }

  // Stash the URL found on mousedown so the click handler can open it even
  // when focusing the editor drops the live-markdown link decoration between
  // mousedown and click (which would leave no `.cm-md-link` to target).
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
      event.preventDefault();
      return true;
    },
    click: (event) => {
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

  // After a drag, if the selection covers the full rendered content of a
  // markdown element whose syntax was hidden during the drag, extend through
  // the hidden source markers so copy/delete operations include valid markdown.
  function snapSelectionPastMarkdownMarkers(v: EditorView, wasDragging: boolean): void {
    const main = v.state.selection.main;
    if (main.empty) return;

    const forward = main.anchor <= main.head;
    const origFrom = forward ? main.anchor : main.head;
    const origTo = forward ? main.head : main.anchor;

    const doc = v.state.doc;
    const tree = syntaxTree(v.state);

    let from = origFrom;
    let to = origTo;

    tree.iterate({
      enter: (node) => {
        if (node.to < origFrom || node.from > origTo) return;

        if (/^ATXHeading[1-6]$/.test(node.name)) {
          if (!wasDragging) return;
          const head = doc.sliceString(node.from, Math.min(node.to, node.from + 8));
          const marker = head.match(/^#+ ?/)?.[0] ?? '';
          if (!marker) return;
          const markerEnd = node.from + marker.length;
          if (origFrom === markerEnd && origTo > markerEnd) {
            from = Math.min(from, node.from);
          }
          return;
        }

        let markerLen = 0;
        if (node.name === 'StrongEmphasis' || node.name === 'Strikethrough') markerLen = 2;
        else if (node.name === 'Emphasis') markerLen = 1;
        else if (node.name === 'InlineCode') {
          const head = doc.sliceString(node.from, Math.min(node.to, node.from + 10));
          markerLen = head.match(/^`+/)?.[0].length ?? 0;
        } else {
          return;
        }
        if (markerLen === 0) return;

        const outerFrom = node.from;
        const outerTo = node.to;
        const innerFrom = outerFrom + markerLen;
        const innerTo = outerTo - markerLen;
        if (innerFrom >= innerTo) return;

        // Only consider elements whose inner content is fully selected.
        if (origFrom > innerFrom || origTo < innerTo) return;

        // If the selection already includes the opening marker and stops at
        // the inner edge of the closing marker, extend through the closer.
        if (origFrom <= outerFrom && origTo === innerTo) {
          to = Math.max(to, outerTo);
        }
        // Symmetric case for a selection anchored at the inner opening edge.
        if (origTo >= outerTo && origFrom === innerFrom) {
          from = Math.min(from, outerFrom);
        }
        // Drag-select that landed exactly on both inner edges: extend through
        // both markers since the user couldn't see them to target past.
        if (wasDragging && origFrom === innerFrom && origTo === innerTo) {
          from = Math.min(from, outerFrom);
          to = Math.max(to, outerTo);
        }
      }
    });

    if (from === origFrom && to === origTo) return;

    v.dispatch({
      selection: EditorSelection.single(forward ? from : to, forward ? to : from)
    });
  }

  function schedulePointerSelectionSettle(v: EditorView, wasDragging: boolean): void {
    clearPointerSelectionSettleTimer();
    pointerSelectionSettleTimer = window.setTimeout(() => {
      pointerSelectionSettleTimer = null;
      snapSelectionPastMarkdownMarkers(v, wasDragging);
    }, 0);
  }

  function setPointerSelectionRevealSuppressed(v: EditorView, suppressed: boolean): void {
    setSuppressSelectionReveal(suppressed);
    v.dom.toggleAttribute('data-selection-reveal-suppressed', suppressed);
  }

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
      orderedListRenumber,
      // IME Shield — Android-only workaround for the Chromium 147 +
      // FUTO Keyboard backspace-on-empty renderer crash. Pushes doc
      // text + selection to a Kotlin shadow that answers
      // InputConnection queries locally. Removing this re-opens the
      // crash. See docs/learnings/ime-shield-workaround.md.
      imeShieldPlugin,
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
      ...markdownEditorLanguageExtensions(),
      liveMarkdownTransform,
      autoLinkHighlight,
      interactiveTableEditor,
      ...(isMobile ? [] : selectionToolbar),
      slashMenu,
      wikilinkAutocomplete(),
      imagePasteHandler,
      tripleClickLineSelectionHandler,
      lineEndClickHandler,
      ...mobileTapCaretCorrection,
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
          fontFamily: "'Barlow', system-ui, sans-serif",
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
      EditorView.updateListener.of(update => {
        if (update.focusChanged) {
          onfocuschange?.(editorHasDomFocus(update.view));
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

    // Focus the editor on mount so .cm-cursor renders immediately on
    // desktop. Skip on mobile: programmatic contenteditable focus pops
    // the soft keyboard, which is unwanted when opening an existing note.
    // The new-note path in noteSession explicitly calls focusEditor()
    // when the keyboard is actually wanted.
    //
    // Defer to the next frame so CM6 has finished wiring its focus tracker
    // (the `cm-focused` class on `.cm-editor`) before we focus. Calling
    // synchronously here can leave activeElement = .cm-content while
    // `.cm-focused` is still missing, which hides the cursor.
    if (!isMobile) {
      requestAnimationFrame(() => {
        if (!view) return;
        view.focus();
        // Belt-and-braces: if CM6 didn't pick up the focus event (can happen
        // when synthetic events bypass the trusted-event path in tests, or
        // when the view mounts inside a hidden ancestor that briefly fires
        // blur), nudge the focus tracker explicitly.
        if (!view.hasFocus) {
          view.contentDOM.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        }
        onfocuschange?.(editorHasDomFocus(view));
      });
    }

    // Suppress marker reveal only after a real pointer drag starts. Plain
    // clicks/double-clicks should not make already-revealed markers blink.
    let mouseDownInEditor = false;
    let dragMoved = false;
    let mouseDownX = 0;
    let mouseDownY = 0;
    const onEditorMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      mouseDownInEditor = true;
      dragMoved = false;
      mouseDownX = event.clientX;
      mouseDownY = event.clientY;
      freezeSelectionReveal(v.hasFocus, v.state.selection.ranges);
      setPointerSelectionRevealSuppressed(v, false);
    };
    const onGlobalPointerMove = (event: MouseEvent) => {
      if (!mouseDownInEditor) return;
      if (!dragMoved) {
        const dx = event.clientX - mouseDownX;
        const dy = event.clientY - mouseDownY;
        if ((dx * dx) + (dy * dy) < 9) return;
      }
      dragMoved = true;
      setPointerSelectionRevealSuppressed(v, true);
    };
    const onGlobalMouseUp = () => {
      if (!mouseDownInEditor) return;
      const wasDragging = mouseDownInEditor && dragMoved;
      mouseDownInEditor = false;
      dragMoved = false;
      clearSelectionRevealFreeze();
      setPointerSelectionRevealSuppressed(v, false);
      v.dispatch({ effects: liveMarkdownRefresh.of(null) });
      schedulePointerSelectionSettle(v, wasDragging);
    };
    const onGlobalBlur = () => {
      mouseDownInEditor = false;
      dragMoved = false;
      clearSelectionRevealFreeze();
      setPointerSelectionRevealSuppressed(v, false);
      clearPointerSelectionSettleTimer();
    };
    v.dom.addEventListener('mousedown', onEditorMouseDown, true);
    window.addEventListener('mousemove', onGlobalPointerMove, true);
    window.addEventListener('mouseup', onGlobalMouseUp, true);
    window.addEventListener('blur', onGlobalBlur);

    if (import.meta.env.DEV) {
      const w = window as any;
      w.__cmToggle = (v: EditorView, name: string) => {
        const fns: Record<string, (v: EditorView) => void> = { bold: toggleBold, italic: toggleItalic, strikethrough: toggleStrikethrough };
        fns[name]?.(v);
      };
      w.__cmGetView = () => view;
      // Factory driver: window.__driver, used by factory/judge to compare
      // FUTO Notes's editor state against Obsidian's.
      import('../../factory/driver/futoNotes').then(({ installDriver }) => {
        if (view) installDriver(view);
      });
    }

    return () => {
      if (onchangeRafId) { cancelAnimationFrame(onchangeRafId); onchangeRafId = 0; }
      clearPointerSelectionSettleTimer();
      v.dom.removeEventListener('mousedown', onEditorMouseDown, true);
      window.removeEventListener('mousemove', onGlobalPointerMove, true);
      window.removeEventListener('mouseup', onGlobalMouseUp, true);
      window.removeEventListener('blur', onGlobalBlur);
      clearSelectionRevealFreeze();
      setPointerSelectionRevealSuppressed(v, false);
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
    if (!view) return;
    view.focus();
    // CM6's `cm-focused` class is gated on a focus event reaching the
    // contentDOM. If the call above didn't trip it (synthetic-event path,
    // mid-mount race), force the tracker to update so `.cm-cursor` is
    // visible immediately.
    if (!view.hasFocus) {
      view.contentDOM.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    }
  }

  /**
   * Re-run the live-markdown decoration pass without changing the doc.
   *
   * Wikilink display uses the shortest-unique-suffix rule across the
   * full note index (see Spec § Wikilinks/Display). When a note is
   * added, removed, or moved elsewhere, the open editor's wikilink
   * widgets need to recompute. The shell calls this from a $effect on
   * the notes-cache so the visible doc tracks the new universe.
   */
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

  export function getSelection(): { from: number; to: number } | null {
    if (!view) return null;
    const sel = view.state.selection.main;
    return { from: sel.from, to: sel.to };
  }

  /**
   * Set the editor's primary selection. Out-of-range positions are
   * clamped to the document length so a restored selection from a
   * previous (longer) version of the doc doesn't throw.
   */
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

<script lang="ts">
  /*
   * SPIKE — Milkdown (ProseMirror) WYSIWYG editor for the native embedded host.
   *
   * Quick-and-dirty drop-in for MarkdownEditor.svelte inside src/editor-embed:
   * it implements the same props + the subset of the exported handle that
   * createFutoEditorApi/EmbedToolbar actually call. `getView()` returns null
   * because there is no CodeMirror view here; every CM-specific caller already
   * guards on that, and toolbar commands route through `exec()` instead.
   *
   * NOT a replacement for the shipping CM6 live-preview editor: Milkdown
   * round-trips markdown through remark, so its serializer normalizes syntax
   * (`*em*` -> `_em_`, list markers, spacing). `getContent()` therefore returns
   * the host's ORIGINAL markdown until the user actually edits, so merely
   * opening a note can never rewrite it on disk.
   */
  import { onMount } from 'svelte';
  import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
  import {
    commonmark,
    liftListItemCommand,
    sinkListItemCommand,
    toggleEmphasisCommand,
    toggleLinkCommand,
    toggleStrongCommand,
    turnIntoTextCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
    wrapInHeadingCommand,
    wrapInOrderedListCommand,
  } from '@milkdown/kit/preset/commonmark';
  import { gfm, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
  import { history } from '@milkdown/kit/plugin/history';
  import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
  import { clipboard } from '@milkdown/kit/plugin/clipboard';
  import { cursor, dropCursorConfig } from '@milkdown/kit/plugin/cursor';
  import { trailing } from '@milkdown/kit/plugin/trailing';
  import { block, BlockProvider } from '@milkdown/kit/plugin/block';
  import { callCommand, getMarkdown, insert, replaceAll } from '@milkdown/kit/utils';
  import type { EditorView as CodeMirrorView } from '@codemirror/view';
  import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
  import type { Mark as ProseMark, Node as ProseNode } from '@milkdown/kit/prose/model';
  import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
  import { resolveImageSrc } from './live-preview/images';
  import type { EditorLinkGesture } from './interactions/editorPointerInteractions';
  import { isIOS } from '$lib/platform';
  import { contentColumnX, resolveTopLevelTarget, type TopLevelTarget } from './blockDragGeometry';
  import { createMobileBlockDndPlugin, type MobileDndHapticKind } from './mobileBlockDnd';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
    onfocuschange?: (focused: boolean) => void;
    oncompositionend?: () => void;
    oncursorcontext?: (ctx: { onListLine: boolean }) => void;
    scrollParent?: HTMLElement | null;
    nativeShell?: boolean;
    onopenlink?: (title: string, gesture: EditorLinkGesture) => void;
    onopenurl?: (url: string) => void;
    /* Notion-style native toolbar active-state (SPIKE, iOS only for now — see
     * bridge.ts FormatStateMessage). Fires deduped whenever the set of active
     * toolbar-manifest ids at the cursor/selection changes. */
    onformatstate?: (active: string[]) => void;
    /* Notion-style mobile block drag haptics (SPIKE, iOS long-press path
     * only — see bridge.ts HapticMessage / mobileBlockDnd.ts). */
    onhaptic?: (kind: MobileDndHapticKind) => void;
  }

  let {
    content = '',
    onchange,
    onfocuschange,
    oncursorcontext,
    onopenurl,
    onformatstate,
    nativeShell = false,
    onhaptic,
  }: Props = $props();

  /* TEST-ONLY escape hatch: headless chromium (Playwright smokes) can never
   * be sniffed as iOS, so the long-press path needs a way in without a real
   * device. `editor.html?forceMobileDnd` or `window.__futoForceMobileDnd`;
   * never set by production hosts. Kept as the sole extra input to the ONE
   * iOS gate below rather than a second ad-hoc platform check. */
  function forceMobileDndForTests(): boolean {
    if (typeof window === 'undefined') return false;
    if ((window as unknown as { __futoForceMobileDnd?: boolean }).__futoForceMobileDnd) return true;
    try {
      return new URLSearchParams(window.location.search).has('forceMobileDnd');
    } catch {
      return false;
    }
  }

  /* THE single gate (root AGENTS.md §6 requirement 6): the Notion-style
   * long-press-anywhere-on-the-block path replaces the ⠿ gutter handle ONLY
   * in the native iOS shell. Every other environment (desktop browser,
   * Android, and the shipping CodeMirror editor entirely) is unaffected.
   * `$derived` (not a plain top-level read) so this stays wired to the
   * `nativeShell` prop rather than a one-shot snapshot taken at mount. */
  const useMobileBlockDnd = $derived(nativeShell && (isIOS || forceMobileDndForTests()));

  let container: HTMLDivElement;
  let editor: Editor | null = null;

  /* The markdown the HOST last handed us, kept verbatim while the document is
   * still exactly what it loaded, so an open/close cycle cannot rewrite a note
   * on disk in Milkdown's normalized syntax. */
  let hostMarkdown: string | null = null;
  /* Milkdown's own serialization of the current doc. */
  let liveMarkdown = '';
  /* Milkdown's serialization of the doc AS LOADED from the host. The listener
   * plugin debounces markdownUpdated by 200ms, so a synchronous "we are
   * applying host content" flag cannot suppress the load echo — comparing
   * against this can. */
  let externalSerialization: string | null = null;
  let pendingContent: string | null = null;
  let onListLine: boolean | null = null;

  /* Notion-style block drag handle (SPIKE). BlockProvider (from Milkdown's
   * block plugin) owns rendering/positioning the ⠿ handle and the native
   * HTML5 drag mechanics; we just feed it a DOM node and, on mobile where
   * there is no hover, nudge it to show for the block under the cursor/tap by
   * dispatching a synthetic pointermove — the SAME event the plugin's own
   * hover detection listens for, so selection/tap and mouse-hover resolve to
   * identical block boundaries. */
  let blockProvider: BlockProvider | null = null;
  /* The live handle DOM node BlockProvider renders into — hoisted out of the
   * onMount async closure (where it is created) so the touch-drag listeners
   * below can be attached/removed from the SAME onMount's teardown. */
  let blockHandleEl: HTMLDivElement | null = null;

  /* Touch/pen drag fallback (SPIKE). The block handle's drag mechanism is
   * native HTML5 DnD (`draggable`/`dragstart`), which iOS WKWebView never
   * initiates for a finger — `UIDragInteraction.isEnabled` defaults to FALSE
   * on the iPhone idiom (it's an iPad-only default), so no real `dragstart`
   * ever fires there.
   *
   * An earlier version of this drove ProseMirror's own core `drop` handler
   * (via synthetic DragEvents + `view.dragging`) so the move landed as one
   * transaction "for free". That reuse turned out to have a real bug:
   * `handleDrop`'s `dropPoint()` snapping picks the NEAREST *schema-valid*
   * position for the dragged slice, not the nearest TOP-LEVEL boundary — so
   * dropping a paragraph just below a blockquote landed it INSIDE the
   * blockquote (a valid child slot) instead of after it as a sibling. Fixed
   * by resolving the target ourselves (`resolveTopLevelTarget`, walking the
   * doc to a depth-0/1 boundary the way `selectRootNodeByDom` in
   * @milkdown/plugin-block's own block-service.ts does for hover) and
   * building the move as an explicit delete+map+insert transaction, rather
   * than trusting the library's more permissive snapping. The visual
   * indicator is rendered from the SAME resolved boundary (a small custom
   * element, not the reused `.use(cursor)` one — that plugin only shows
   * wherever dropPoint() would land, which is exactly the position this
   * fallback deliberately does NOT use) so what the user sees always matches
   * where the drop will land. */
  type TouchDragState = {
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    sourceEl: HTMLElement | null;
    /** Position immediately before the dragged top-level block, and its size — both captured
     * once at drag start (see beginTouchDrag) and stable for the drag's duration since no
     * transaction is dispatched until drop. */
    sourceStart: number;
    sourceSize: number;
  };
  let touchDrag: TouchDragState | null = null;
  let touchDropIndicatorEl: HTMLDivElement | null = null;
  const TOUCH_DRAG_THRESHOLD_PX = 6;
  const AUTO_SCROLL_EDGE_PX = 48;
  const AUTO_SCROLL_STEP_PX = 14;

  // contentColumnX / resolveTopLevelTarget / TopLevelTarget now live in
  // blockDragGeometry.ts, shared with mobileBlockDnd.ts's iOS long-press path
  // (see that module's doc comment for why top-level resolution must not
  // reuse ProseMirror's own dropPoint()).

  function ensureTouchDropIndicator(): HTMLDivElement {
    if (!touchDropIndicatorEl) {
      const el = document.createElement('div');
      el.className = 'milkdown-touch-drop-indicator';
      el.setAttribute('aria-hidden', 'true');
      container.appendChild(el);
      touchDropIndicatorEl = el;
    }
    return touchDropIndicatorEl;
  }

  function showTouchDropIndicator(target: TopLevelTarget): void {
    const el = ensureTouchDropIndicator();
    const containerRect = container.getBoundingClientRect();
    const domRect = target.dom.getBoundingClientRect();
    const y = target.corner === 'before' ? domRect.top : domRect.bottom;
    el.style.left = `${domRect.left - containerRect.left}px`;
    el.style.width = `${domRect.width}px`;
    el.style.top = `${y - containerRect.top}px`;
    el.classList.add('milkdown-touch-drop-indicator--visible');
  }

  function hideTouchDropIndicator(): void {
    touchDropIndicatorEl?.classList.remove('milkdown-touch-drop-indicator--visible');
  }

  function beginTouchDrag(view: ProseView): void {
    const state = touchDrag;
    if (!state) return;
    const active = blockProvider?.active;
    if (!active) {
      // Nothing hovered (handle tapped without a prior tap/selection nudging
      // it onto a block) — leave `dragging` false so pointerup treats this
      // as a no-op tap rather than starting a drag with no source.
      return;
    }
    state.dragging = true;
    state.sourceEl = active.el;
    state.sourceStart = active.$pos.pos;
    state.sourceSize = active.node.nodeSize;
    state.sourceEl.classList.add('milkdown-block-drag-source');
    // Auto-scroll below moves view.dom.scrollTop directly, which fires a
    // native 'scroll' event — suppress the existing scroll->hide handler for
    // the duration of the drag so it cannot flicker the handle away mid-drag.
    view.dom.removeEventListener('scroll', handleBlockScroll);
  }

  function handleHandlePointerDown(event: PointerEvent): void {
    // Mouse keeps the existing native HTML5 DnD path untouched — this
    // fallback is touch/pen only, and the two must never both fire for one
    // gesture (a mouse never reaches this branch at all).
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (touchDrag) return; // a second simultaneous touch on the handle
    const handleEl = event.currentTarget as HTMLElement;
    event.preventDefault();
    try {
      handleEl.setPointerCapture(event.pointerId);
    } catch {
      // Rare (pointer already released); the drag just won't track off-element.
    }
    touchDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      sourceEl: null,
      sourceStart: 0,
      sourceSize: 0,
    };
  }

  function handleHandlePointerMove(event: PointerEvent): void {
    const state = touchDrag;
    if (!state || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    const view = pmView();
    if (!view) return;

    if (!state.dragging) {
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (Math.hypot(dx, dy) < TOUCH_DRAG_THRESHOLD_PX) return;
      beginTouchDrag(view);
      if (!state.dragging) return; // no active block to drag (see beginTouchDrag)
    }

    const rect = view.dom.getBoundingClientRect();
    const x = contentColumnX(view);
    const y = Math.min(Math.max(event.clientY, rect.top + 1), rect.bottom - 1);
    const target = resolveTopLevelTarget(view, x, y);
    if (target) showTouchDropIndicator(target);

    // Rudimentary auto-scroll: `.ProseMirror` (view.dom) owns overflow-y.
    if (event.clientY - rect.top < AUTO_SCROLL_EDGE_PX) {
      view.dom.scrollTop = Math.max(0, view.dom.scrollTop - AUTO_SCROLL_STEP_PX);
    } else if (rect.bottom - event.clientY < AUTO_SCROLL_EDGE_PX) {
      view.dom.scrollTop += AUTO_SCROLL_STEP_PX;
    }
  }

  function endTouchDrag(event: PointerEvent, commit: boolean): void {
    const state = touchDrag;
    const handleEl = blockHandleEl;
    if (!state || event.pointerId !== state.pointerId) return;
    touchDrag = null;
    state.sourceEl?.classList.remove('milkdown-block-drag-source');
    hideTouchDropIndicator();
    if (handleEl) {
      try {
        handleEl.releasePointerCapture(event.pointerId);
      } catch {
        // Already released (e.g. handle hidden mid-drag) — fine.
      }
    }
    if (!state.dragging) return; // never crossed the threshold: a no-op tap

    const view = pmView();
    if (view) view.dom.addEventListener('scroll', handleBlockScroll, { passive: true });
    if (!commit || !view) return; // pointercancel, or the view vanished mid-drag: abort cleanly

    const rect = view.dom.getBoundingClientRect();
    const x = contentColumnX(view);
    const y = Math.min(Math.max(event.clientY, rect.top + 1), rect.bottom - 1);
    const target = resolveTopLevelTarget(view, x, y);
    if (!target) return;

    const srcStart = state.sourceStart;
    const srcEnd = srcStart + state.sourceSize;
    // Dropping back onto/within the source's own range (including exactly
    // at either edge, which is what "dropped where it started" resolves to
    // once mapped through the deletion) is a genuine no-op: skip the
    // transaction entirely so there is no markdownUpdated and no history
    // entry, rather than dispatching a transaction that happens to be a
    // doc-identity no-op.
    if (target.pos >= srcStart && target.pos <= srcEnd) return;

    const beforeDoc = view.state.doc;
    const slice = beforeDoc.slice(srcStart, srcEnd);
    let tr = view.state.tr.delete(srcStart, srcEnd);
    const mappedTarget = tr.mapping.map(target.pos);
    tr = tr.insert(mappedTarget, slice.content);
    if (!tr.doc.eq(beforeDoc)) view.dispatch(tr);
  }

  function handleHandlePointerUp(event: PointerEvent): void {
    endTouchDrag(event, true);
  }

  function handleHandlePointerCancel(event: PointerEvent): void {
    endTouchDrag(event, false);
  }

  function isTaskItem(node: ProseNode): boolean {
    return (
      node.type.name === 'list_item' &&
      node.attrs.checked !== null &&
      node.attrs.checked !== undefined
    );
  }

  /* Task-list glyphs are painted via an outdented `::before` on the <li>
   * (see the `li[data-checked]::before` rule below) that the block handle's
   * own bounding box does not know about — push the handle further left for
   * those items so the two tap targets never overlap (req. 5). */
  function blockHandleOffset(node: ProseNode): { mainAxis: number } {
    return isTaskItem(node) ? { mainAxis: 30 } : { mainAxis: 8 };
  }

  /* Drives the block plugin's own hover-detection path (BlockService listens
   * for `pointermove` on the ProseMirror DOM) so tap/selection reuse the exact
   * same block-boundary resolution as desktop mouse hover, instead of a
   * hand-rolled second implementation that could disagree with it. */
  function nudgeBlockHandle(clientY: number): void {
    const view = pmView();
    if (!view) return;
    const rect = view.dom.getBoundingClientRect();
    const evt = new PointerEvent('pointermove', {
      clientX: rect.left + rect.width / 2,
      clientY,
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(evt);
  }

  /* The handle's position is only recomputed when the plugin shows/hides it;
   * without this it would visually drift over the wrong block while the user
   * scrolls the ProseMirror-internal scroller. */
  function handleBlockScroll(): void {
    blockProvider?.hide();
  }

  function pmView(): ProseView | null {
    if (!editor) return null;
    try {
      return editor.ctx.get(editorViewCtx);
    } catch {
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function run(command: { key: any }, payload?: unknown): void {
    if (!editor) return;
    editor.action(callCommand(command.key, payload));
    pmView()?.focus();
  }

  /* ---- image srcs -------------------------------------------------------- *
   * Vault images are relative filenames; the native host registers a base URL
   * (createFutoEditorApi -> setLocalImageBaseUrl), and resolveImageSrc owns the
   * mapping. Milkdown renders plain <img src="file.png">, so rewrite after every
   * render instead of teaching the schema about vault paths. */
  function rewriteImageSrcs(): void {
    const root = container;
    if (!root) return;
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const original = img.dataset.futoSrc ?? img.getAttribute('src') ?? '';
      if (!original) continue;
      img.dataset.futoSrc = original;
      const resolved = resolveImageSrc(original);
      if (resolved && img.getAttribute('src') !== resolved) img.setAttribute('src', resolved);
    }
  }

  function enclosingListItem(): { node: ProseNode; pos: number } | null {
    const view = pmView();
    if (!view) return null;
    // `$from` would be the natural name, but Svelte reserves the `$` prefix.
    const at = view.state.doc.resolve(view.state.selection.from);
    for (let depth = at.depth; depth > 0; depth -= 1) {
      const node = at.node(depth);
      if (node.type.name === 'list_item') return { node, pos: at.before(depth) };
    }
    return null;
  }

  function currentHeadingLevel(): number {
    const view = pmView();
    if (!view) return 0;
    const at = view.state.doc.resolve(view.state.selection.from);
    for (let depth = at.depth; depth > 0; depth -= 1) {
      const node = at.node(depth);
      if (node.type.name === 'heading') return Number(node.attrs.level ?? 0);
    }
    return 0;
  }

  /* Notion-style native toolbar active-state (SPIKE, iOS only for now). Sorted
   * comma-joined snapshot of the last emitted set, so emitFormatState() below
   * can dedupe without the caller having to track it. */
  let lastFormatStateKey: string | null = null;

  /* Whether `markName` (a Milkdown/ProseMirror mark type) covers `selection`
   * on `view`'s doc: for an empty selection, the marks that would apply to
   * text typed next (`storedMarks` when given, falling back to the resolved
   * position's own marks); for a range, every character in it. `storedMarks`
   * is threaded in rather than read off `view.state` because the caller may
   * be reporting a NEWER selection than `view.state` currently reflects (see
   * computeActiveFormats). */
  function markActive(
    view: ProseView,
    selection: ProseSelection,
    storedMarks: readonly ProseMark[] | null,
    markName: string,
  ): boolean {
    const markType = view.state.schema.marks[markName];
    if (!markType) return false;
    const { from, to, empty } = selection;
    if (empty) {
      const marks = storedMarks ?? selection.$from.marks();
      return markType.isInSet(marks) !== undefined;
    }
    // `view.state.doc` is safe even when `selection` is newer than `view.state`
    // (see computeActiveFormats): a pure selection-move transaction never
    // touches the doc, so the stale and fresh docs are the same object.
    return view.state.doc.rangeHasMark(from, to, markType);
  }

  /* The toolbar-manifest ids active for `selection` (see EXEC above for the id
   * set). Node checks walk `selection.$from`'s ancestors, same pattern as
   * enclosingListItem()/currentHeadingLevel() but resolved against the
   * SELECTION passed in rather than `view.state.selection` — see the caller
   * comment in the `selectionUpdated` listener for why that distinction
   * matters. A task-list item is schema-nested inside bullet_list, so it
   * reports 'task-list' and deliberately NOT 'bullet-list' — otherwise both
   * toolbar buttons would light up together. */
  function computeActiveFormats(
    selection: ProseSelection,
    storedMarks: readonly ProseMark[] | null,
  ): string[] {
    const view = pmView();
    if (!view) return [];
    const active = new Set<string>();

    if (markActive(view, selection, storedMarks, 'strong')) active.add('bold');
    if (markActive(view, selection, storedMarks, 'emphasis')) active.add('italic');
    if (markActive(view, selection, storedMarks, 'strike_through')) active.add('strikethrough');
    if (markActive(view, selection, storedMarks, 'link')) active.add('link');

    const at = selection.$from;
    let inHeading = false;
    let inBlockquote = false;
    let inBulletList = false;
    let inOrderedList = false;
    let inTaskItem = false;
    for (let depth = at.depth; depth > 0; depth -= 1) {
      const node = at.node(depth);
      if (node.type.name === 'heading') inHeading = true;
      else if (node.type.name === 'blockquote') inBlockquote = true;
      else if (node.type.name === 'bullet_list') inBulletList = true;
      else if (node.type.name === 'ordered_list') inOrderedList = true;
      else if (node.type.name === 'list_item' && isTaskItem(node)) inTaskItem = true;
    }
    if (inHeading) active.add('heading');
    if (inBlockquote) active.add('quote');
    if (inOrderedList) active.add('ordered-list');
    if (inTaskItem) active.add('task-list');
    else if (inBulletList) active.add('bullet-list');

    return Array.from(active);
  }

  /**
   * Emits deduped `formatState`. `selectionOverride`, when given, is the
   * SELECTION-JUST-APPLIED from Milkdown's `selectionUpdated` listener
   * callback — pass it explicitly rather than reading `pmView()!.state`
   * there: Milkdown's listener plugin runs that callback from inside
   * `EditorState.apply(tr)`, before the default `dispatchTransaction` calls
   * `view.updateState(...)`, so `view.state` (and its `.selection`/
   * `.storedMarks`) is still ONE TRANSACTION BEHIND at that exact call site —
   * `pmView()?.state.selection` there would report where the caret USED TO
   * BE. `mounted`/`markdownUpdated`(debounced)/`exec()` all run outside that
   * window, so `view.state` is current for them (no override needed) — and
   * `storedMarks` is intentionally omitted (`null`) for the override case: a
   * plain selection-move transaction always clears storedMarks anyway, so
   * `selection.$from.marks()` alone is correct there, whereas `exec('bold')`
   * on a collapsed selection genuinely relies on the freshly toggled
   * `view.state.storedMarks` to report active immediately.
   */
  function emitFormatState(selectionOverride?: ProseSelection): void {
    if (!onformatstate) return;
    const view = pmView();
    if (!view) return;
    const selection = selectionOverride ?? view.state.selection;
    const storedMarks = selectionOverride ? null : view.state.storedMarks;
    const active = computeActiveFormats(selection, storedMarks);
    const key = [...active].sort().join(',');
    if (key === lastFormatStateKey) return;
    lastFormatStateKey = key;
    onformatstate(active);
  }

  function setListItemChecked(value: boolean | null): void {
    const view = pmView();
    const item = enclosingListItem();
    if (!view || !item) return;
    view.dispatch(
      view.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: value }),
    );
  }

  const EXEC: Record<string, () => void> = {
    bold: () => run(toggleStrongCommand),
    italic: () => run(toggleEmphasisCommand),
    strikethrough: () => run(toggleStrikethroughCommand),
    link: () => run(toggleLinkCommand, { href: '' }),
    heading: () => {
      const level = currentHeadingLevel();
      if (level >= 3) run(turnIntoTextCommand);
      else run(wrapInHeadingCommand, level + 1);
    },
    quote: () => run(wrapInBlockquoteCommand),
    'bullet-list': () => run(wrapInBulletListCommand),
    'ordered-list': () => run(wrapInOrderedListCommand),
    'task-list': () => {
      if (!enclosingListItem()) run(wrapInBulletListCommand);
      const current = enclosingListItem()?.node.attrs.checked ?? null;
      setListItemChecked(current === null ? false : null);
      pmView()?.focus();
    },
    indent: () => run(sinkListItemCommand),
    outdent: () => run(liftListItemCommand),
  };

  onMount(() => {
    let disposed = false;

    // Read the initial prop here rather than at the top level: the embed host
    // feeds content through setContent, and a top-level read is a Svelte 5
    // "captures only the initial value" warning.
    if (content) {
      pendingContent = content;
      hostMarkdown = content;
      liveMarkdown = content;
    }
    container.addEventListener('click', handleClick);

    void (async () => {
      let builder = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container);
          ctx.set(defaultValueCtx, pendingContent ?? '');
          // The drop indicator ships via `.use(cursor)`; its default color is
          // `false` (invisible) unless configured.
          ctx.set(dropCursorConfig.key, {
            width: 3,
            color: 'var(--color-primary, #f26b1f)',
            class: 'milkdown-drop-indicator',
          });

          const listeners = ctx.get(listenerCtx);
          listeners.markdownUpdated((_ctx, markdown) => {
            liveMarkdown = markdown;
            rewriteImageSrcs();
            emitFormatState();
            // The debounced echo of host content we just loaded — not an edit.
            if (externalSerialization !== null && markdown === externalSerialization) return;
            // A genuine user edit: the host's copy is no longer authoritative.
            externalSerialization = null;
            hostMarkdown = null;
            onchange?.(markdown);
          });
          listeners.focus(() => onfocuschange?.(true));
          listeners.blur(() => onfocuschange?.(false));
          listeners.selectionUpdated((_ctx, selection) => {
            const inList = enclosingListItem() !== null;
            if (inList !== onListLine) {
              onListLine = inList;
              oncursorcontext?.({ onListLine: inList });
            }
            // Pass `selection` explicitly — see emitFormatState's doc comment
            // for why `pmView()!.state.selection` is one step stale here.
            emitFormatState(selection);
            // No hover on mobile — surface the handle for the block the
            // cursor now sits in (covers both real cursor moves and a tap
            // that placed the caret). Not applicable at all under the iOS
            // long-press path — there is no handle to surface.
            if (!useMobileBlockDnd) {
              const view = pmView();
              if (view) {
                try {
                  const coords = view.coordsAtPos(selection.from);
                  nudgeBlockHandle((coords.top + coords.bottom) / 2);
                } catch {
                  // Position not currently measurable (e.g. mid-transaction); skip.
                }
              }
            }
          });
          listeners.mounted(() => {
            rewriteImageSrcs();
            emitFormatState();
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(listener)
        .use(clipboard)
        .use(cursor)
        .use(trailing);

      // THE single iOS gate (see useMobileBlockDnd above): the Notion-style
      // long-press-anywhere-on-the-block path REPLACES the ⠿ gutter handle
      // plugin entirely for this editor instance — the two never coexist.
      builder = useMobileBlockDnd
        ? builder.use(
            createMobileBlockDndPlugin({
              onHaptic: (kind) => onhaptic?.(kind),
            }),
          )
        : builder.use(block);

      const created = await builder.create();

      if (disposed) {
        void created.destroy();
        return;
      }

      editor = created;
      if (pendingContent !== null && pendingContent !== '') {
        applyExternal(pendingContent);
      }
      pendingContent = null;
      rewriteImageSrcs();

      if (!useMobileBlockDnd) {
        const handleEl = document.createElement('div');
        handleEl.className = 'milkdown-block-handle';
        handleEl.textContent = '⠿';
        handleEl.setAttribute('aria-hidden', 'true');
        blockProvider = new BlockProvider({
          ctx: created.ctx,
          content: handleEl,
          getOffset: (deriveContext) => blockHandleOffset(deriveContext.active.node),
        });
        blockProvider.update();
        created.ctx
          .get(editorViewCtx)
          .dom.addEventListener('scroll', handleBlockScroll, { passive: true });

        // Touch/pen drag fallback (SPIKE) — see the block comment above
        // touchDrag's declaration. Mouse is deliberately excluded inside the
        // handler itself, not here, so this stays the single attachment point.
        blockHandleEl = handleEl;
        handleEl.addEventListener('pointerdown', handleHandlePointerDown);
        handleEl.addEventListener('pointermove', handleHandlePointerMove, { passive: false });
        handleEl.addEventListener('pointerup', handleHandlePointerUp);
        handleEl.addEventListener('pointercancel', handleHandlePointerCancel);
      }
    })();

    return () => {
      disposed = true;
      container.removeEventListener('click', handleClick);
      pmView()?.dom.removeEventListener('scroll', handleBlockScroll);
      if (blockHandleEl) {
        blockHandleEl.removeEventListener('pointerdown', handleHandlePointerDown);
        blockHandleEl.removeEventListener('pointermove', handleHandlePointerMove);
        blockHandleEl.removeEventListener('pointerup', handleHandlePointerUp);
        blockHandleEl.removeEventListener('pointercancel', handleHandlePointerCancel);
      }
      blockHandleEl = null;
      touchDrag = null;
      touchDropIndicatorEl?.remove();
      touchDropIndicatorEl = null;
      blockProvider?.destroy();
      blockProvider = null;
      const current = editor;
      editor = null;
      void current?.destroy();
    };
  });

  function readSerialized(): string | null {
    if (!editor) return null;
    try {
      return editor.action(getMarkdown());
    } catch {
      return null;
    }
  }

  function applyExternal(text: string): void {
    if (!editor) return;
    editor.action(replaceAll(text));
    hostMarkdown = text;
    liveMarkdown = text;
    externalSerialization = readSerialized() ?? text;
    rewriteImageSrcs();
  }

  /* Tapping a task-list marker toggles it (Milkdown renders the checkbox state
   * as a `data-checked` attribute; the glyph itself is CSS). */
  function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // BlockService already owns mousedown/dragstart on its own handle DOM.
    if (target.closest('.milkdown-block-handle')) return;

    const anchor = target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href') ?? '';
      if (href) {
        event.preventDefault();
        onopenurl?.(href);
      }
      return;
    }

    const item = target.closest('li[data-checked]') as HTMLElement | null;
    if (item) {
      // The ::before glyph is outdented into the list's padding, so a tap on
      // it lands left of the <li> box. Taps on the text itself must not
      // toggle — fall through to the tap-shows-handle behavior below instead.
      const rect = item.getBoundingClientRect();
      if (event.clientX < rect.left) {
        event.preventDefault();
        const view = pmView();
        if (view) {
          const pos = view.posAtDOM(item, 0);
          const resolved = view.state.doc.resolve(pos);
          for (let depth = resolved.depth; depth > 0; depth -= 1) {
            const node = resolved.node(depth);
            if (node.type.name !== 'list_item') continue;
            const checked = node.attrs.checked;
            view.dispatch(
              view.state.tr.setNodeMarkup(resolved.before(depth), undefined, {
                ...node.attrs,
                checked: checked ? false : true,
              }),
            );
            break;
          }
        }
        return;
      }
    }

    // No hover on mobile — surface the drag handle for whatever block was
    // tapped. Not applicable under the iOS long-press path (no handle).
    if (!useMobileBlockDnd) nudgeBlockHandle(event.clientY);
  }

  // ---- handle consumed by src/editor-embed ------------------------------- //

  export function setContent(text: string): void {
    if (!editor) {
      pendingContent = text;
      hostMarkdown = text;
      return;
    }
    if (text === hostMarkdown || text === liveMarkdown) return;
    applyExternal(text);
  }

  export function getContent(): string | undefined {
    const live = readSerialized();
    if (live === null) return hostMarkdown ?? liveMarkdown;
    // Only hand back the host's original bytes while the document is still
    // EXACTLY what it loaded; a keystroke inside the listener's debounce window
    // must not be reported as the unmodified note.
    if (hostMarkdown !== null && live === externalSerialization) return hostMarkdown;
    return live;
  }

  export function focus(): void {
    pmView()?.focus();
  }

  export function blur(): void {
    pmView()?.dom.blur();
  }

  export function hasFocus(): boolean {
    return pmView()?.hasFocus() ?? false;
  }

  export function isComposing(): boolean {
    return Boolean(pmView()?.composing);
  }

  export function insertMarkdown(text: string): void {
    if (!editor) return;
    editor.action(insert(text));
    pmView()?.focus();
  }

  export function refreshDecorations(): void {
    rewriteImageSrcs();
  }

  export function resetHistory(): void {
    // Milkdown's history plugin has no public clear; a fresh note is close
    // enough for the spike.
  }

  export function warmScroll(): { grew: number; steps: number } | null {
    return null;
  }

  /** No CodeMirror view exists — every CM-specific caller already guards null. */
  export function getView(): CodeMirrorView | null {
    return null;
  }

  export function exec(commandId: string): boolean {
    const action = EXEC[commandId];
    if (!action) {
      console.warn(`MilkdownEditor.exec: unsupported command '${commandId}'`);
      return false;
    }
    action();
    // A tap may toggle a mark/node without moving the selection (e.g. Bold
    // mid-word), so selectionUpdated alone would miss it — and
    // markdownUpdated is 200ms-debounced, too slow for a toolbar highlight
    // to feel connected to the tap that caused it.
    emitFormatState();
    return true;
  }
</script>

<!-- The click handler is attached in onMount (see handleClick): it fires on
     ProseMirror-generated children, which the markup never sees. -->
<div class="futo-milkdown" bind:this={container}></div>

<style>
  .futo-milkdown {
    height: 100%;
    position: relative;
  }

  :global(.futo-milkdown .milkdown) {
    height: 100%;
  }

  :global(.futo-milkdown .ProseMirror) {
    height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    outline: none;
    /* Left padding is wider than the right: it is the gutter the block drag
     * handle floats in (see .milkdown-block-handle below), so it needs room
     * on a phone-width screen without eating into content width.
     *
     * The gutter must ALSO keep the handle clear of the leftmost 20pt of the
     * SCREEN. That strip belongs to UIKit's interactive-pop
     * UIScreenEdgePanGestureRecognizer (the swipe-back that pops the
     * NavigationStack), which delays touches begun inside it — a drag started
     * there reaches the WKWebView as NOTHING AT ALL: no pointerdown, no
     * touchstart, no moves. Measured on iPhone 17 Pro / iOS 26.5: an identical
     * synthetic drag delivers a full pointer stream at screen x >= 20 and zero
     * events at x <= 15, and a horizontal drag from x = 8 pops the stack.
     * At the old 34px gutter the 20px-wide handle sat at x 6..26 — its whole
     * left half, INCLUDING its centre, inside that dead strip, which is why
     * touch block-drag looked completely inert on iOS while working in
     * Chromium and in Mobile Safari with the very same bundle. 54px puts it at
     * x 26..46 (task items at 28..48). env() keeps that true in landscape,
     * where the notch inset already pushes the whole page in. */
    padding: 14px calc(18px + env(safe-area-inset-right)) max(40vh, 280px)
      calc(54px + env(safe-area-inset-left));
    color: var(--color-text, #0f0f0f);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    font-size: 17px;
    line-height: 1.55;
    -webkit-text-size-adjust: 100%;
    word-wrap: break-word;
    white-space: pre-wrap;
  }

  :global(.futo-milkdown .ProseMirror > * + *) {
    margin-top: 0.75em;
  }

  :global(.futo-milkdown .ProseMirror h1),
  :global(.futo-milkdown .ProseMirror h2),
  :global(.futo-milkdown .ProseMirror h3),
  :global(.futo-milkdown .ProseMirror h4),
  :global(.futo-milkdown .ProseMirror h5),
  :global(.futo-milkdown .ProseMirror h6) {
    font-weight: 650;
    line-height: 1.25;
    margin-top: 1.2em;
  }

  :global(.futo-milkdown .ProseMirror h1) {
    font-size: 1.7em;
  }
  :global(.futo-milkdown .ProseMirror h2) {
    font-size: 1.4em;
  }
  :global(.futo-milkdown .ProseMirror h3) {
    font-size: 1.2em;
  }

  :global(.futo-milkdown .ProseMirror a) {
    color: var(--color-primary, #f26b1f);
    text-decoration: underline;
  }

  :global(.futo-milkdown .ProseMirror blockquote) {
    border-left: 3px solid var(--color-border, #e5e5e5);
    padding-left: 0.9em;
    color: var(--color-muted, #737373);
  }

  :global(.futo-milkdown .ProseMirror code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--color-surface, #f2f2f2);
    border-radius: 4px;
    padding: 0.1em 0.3em;
  }

  :global(.futo-milkdown .ProseMirror pre) {
    background: var(--color-surface, #f2f2f2);
    border-radius: 8px;
    padding: 0.8em;
    overflow-x: auto;
    white-space: pre;
  }

  :global(.futo-milkdown .ProseMirror pre code) {
    background: none;
    padding: 0;
  }

  :global(.futo-milkdown .ProseMirror ul),
  :global(.futo-milkdown .ProseMirror ol) {
    padding-left: 1.4em;
  }

  :global(.futo-milkdown .ProseMirror ul) {
    list-style: disc;
  }
  :global(.futo-milkdown .ProseMirror ol) {
    list-style: decimal;
  }

  :global(.futo-milkdown .ProseMirror li) {
    margin: 0.15em 0;
  }

  :global(.futo-milkdown .ProseMirror li[data-checked]) {
    list-style: none;
    position: relative;
  }

  :global(.futo-milkdown .ProseMirror li[data-checked]::before) {
    content: '☐';
    position: absolute;
    left: -1.15em;
    color: var(--color-muted, #737373);
  }

  :global(.futo-milkdown .ProseMirror li[data-checked='true']::before) {
    content: '☑';
    color: var(--color-primary, #f26b1f);
  }

  :global(.futo-milkdown .ProseMirror hr) {
    border: none;
    border-top: 1px solid var(--color-border, #e5e5e5);
  }

  :global(.futo-milkdown .ProseMirror img) {
    max-width: 100%;
    max-height: 300px;
    border-radius: 6px;
  }

  :global(.futo-milkdown .ProseMirror table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
    max-width: 100%;
  }

  :global(.futo-milkdown .ProseMirror th),
  :global(.futo-milkdown .ProseMirror td) {
    border: 1px solid var(--color-border, #e5e5e5);
    padding: 0.35em 0.6em;
  }

  :global(.futo-milkdown .ProseMirror ::selection) {
    background: var(--color-selection, #ffe4d1);
  }

  /* Notion-style block drag handle (SPIKE). Positioned by Milkdown's
   * BlockProvider (floating-ui, `data-show` toggled by it); shown for
   * mouse hover natively, and for tap/selection via a synthetic pointermove
   * dispatched from this component (see nudgeBlockHandle). */
  :global(.futo-milkdown .milkdown-block-handle) {
    position: absolute;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    line-height: 1;
    color: var(--color-muted, #737373);
    background: transparent;
    border-radius: 4px;
    cursor: grab;
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 0.12s ease,
      background-color 0.12s ease;
    /* iOS/WKWebView native HTML5 drag on a plain draggable div: touch-action
     * stops the browser eating the long-press-drag gesture as a scroll, and
     * -webkit-user-drag is WebKit's own opt-in for element drag sources. */
    touch-action: none;
    -webkit-user-drag: element;
    user-select: none;
    -webkit-user-select: none;
    z-index: 5;
  }

  :global(.futo-milkdown .milkdown-block-handle[data-show='true']) {
    opacity: 1;
    pointer-events: auto;
  }

  :global(.futo-milkdown .milkdown-block-handle:active) {
    cursor: grabbing;
    background: var(--color-surface, #f2f2f2);
  }

  /* Drop indicator DOM comes from `.use(cursor)` (prosemirror-drop-indicator);
   * color/width are configured via dropCursorConfig in the script block. Used
   * by the desktop mouse/native-HTML5-drag path only — see the touch
   * fallback's own indicator below for why it does not share this one. */
  :global(.milkdown-drop-indicator) {
    border-radius: 2px;
  }

  /* Touch drag fallback (SPIKE) — cheap "this block is being moved"
   * affordance for the source block while a touch drag is in flight (see
   * touchDrag in the script block); cleared on drop/cancel. */
  :global(.futo-milkdown .milkdown-block-drag-source) {
    opacity: 0.35;
    transition: opacity 0.1s ease;
  }

  /* Touch drag fallback's own drop indicator (see resolveTopLevelTarget /
   * showTouchDropIndicator in the script block): a plain absolutely-positioned
   * line rather than the reused `.use(cursor)` one above, because that plugin
   * only shows wherever ProseMirror's dropPoint() would land — the more
   * permissive, non-top-level-only position this fallback deliberately does
   * NOT use for the actual drop (see the block comment above touchDrag).
   * Same color/thickness as dropCursorConfig for visual consistency. */
  :global(.futo-milkdown .milkdown-touch-drop-indicator) {
    position: absolute;
    height: 3px;
    margin-top: -1.5px;
    border-radius: 2px;
    background: var(--color-primary, #f26b1f);
    opacity: 0;
    pointer-events: none;
    z-index: 6;
  }

  :global(.futo-milkdown .milkdown-touch-drop-indicator--visible) {
    opacity: 1;
  }
</style>

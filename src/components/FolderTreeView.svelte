<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { NotePreview } from '../types';
  import {
    buildFolderTree,
    flattenTree,
    isFolderOpen,
    toggleFolderOpen,
    setDragHoverExpanded,
    clearDragHoverExpanded,
    type TreeNode,
    type FolderNode,
  } from '$lib/folders.svelte';
  import { isMobile, isLinux } from '$lib/platform';
  import { idParent, idLeaf } from '$lib/platform/pathSafety';
  import { setItemDragging } from '$lib/dragState';

  // Custom MIME types used to thread the dragged item's ID through the
  // dataTransfer payload. Drop handlers read these to decide what to move.
  const NOTE_MIME = 'application/futo-note-id';
  const FOLDER_MIME = 'application/futo-folder-path';

  interface Props {
    items: NotePreview[];
    selectedId?: string | null;
    isDragging?: boolean;
    onselect?: (id: string, event?: MouseEvent) => void;
    onfoldercontextmenu?: (path: string, x: number, y: number) => void;
    onnotecontextmenu?: (id: string, x: number, y: number) => void;
    onnotedragstart?: (id: string, e: DragEvent) => void;
    onfolderdragstart?: (path: string, e: DragEvent) => void;
    oncreatefolder?: (parentPath: string) => void;
    onrenamefolder?: (path: string, newName: string) => Promise<string | null> | string | null;
    renameRequest?: { path: string; nonce: number } | null;
    ondropnoteonfolder?: (noteId: string, folderPath: string) => void;
    ondropfolderonfolder?: (folderPath: string, targetPath: string) => void;
    ondropnoteonroot?: (noteId: string) => void;
    ondropfolderonroot?: (folderPath: string) => void;
  }

  let {
    items,
    selectedId = null,
    isDragging = false,
    onselect,
    onfoldercontextmenu,
    onnotecontextmenu,
    onnotedragstart,
    onfolderdragstart,
    oncreatefolder,
    onrenamefolder,
    renameRequest = null,
    ondropnoteonfolder,
    ondropfolderonfolder,
    ondropnoteonroot,
    ondropfolderonroot,
  }: Props = $props();

  const tree = $derived(buildFolderTree(items));
  const flat = $derived(flattenTree(tree));

  // ── Virtualization ─────────────────────────────────────────────────
  // The vault can hold thousands of notes; rendering them all keeps the
  // sidebar's keyed each block at O(N) per Svelte diff. During drag,
  // every dropTarget mutation forces a re-evaluation across all rows
  // and tanks frame rate. We render only the rows in (and just outside)
  // the viewport.
  //
  // Row height matches `.folder-row`/`.note-row` height (48px) plus 1px
  // top + 1px bottom margin = 50px. Keep this in sync with the CSS.
  const ROW_HEIGHT = 50;
  const ROW_BUFFER = 6;
  const DEPTH_INDENT_PX = 16;
  let scrollTop = $state(0);
  let containerHeight = $state(0);
  let containerEl: HTMLDivElement | undefined = $state();
  const visibleRange = $derived.by(() => {
    if (containerHeight === 0) {
      // Initial render before ResizeObserver fires — show enough rows to
      // fill a typical viewport so the user doesn't see a blank list.
      return { start: 0, end: Math.min(flat.length, 40) };
    }
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_BUFFER);
    const end = Math.min(
      flat.length,
      Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + ROW_BUFFER,
    );
    return { start, end };
  });

  const visibleNodes = $derived(
    flat.slice(visibleRange.start, visibleRange.end).map((node, i) => ({
      node,
      index: visibleRange.start + i,
    })),
  );

  $effect(() => {
    const el = containerEl;
    if (!el) return;
    containerHeight = el.clientHeight;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) containerHeight = entry.contentRect.height;
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  function handleScroll(e: Event): void {
    scrollTop = (e.currentTarget as HTMLDivElement).scrollTop;
  }

  let hoverTimer: number | null = null;
  let hoveredFolder: string | null = null;

  // `dropTarget` drives the outline class on folder rows / root container.
  // '' = vault root, non-empty = folder path, null = no outline (cursor is
  // over the source's current parent, or no drag is in progress).
  let dropTarget = $state<string | null>(null);
  // Plain `let` — only read inside drag handlers, never observed by the
  // template, so they don't need $state reactivity.
  let sourceParent: string | null = null;
  let sourceFolderPath: string | null = null;
  let sourceNoteId: string | null = null;

  function clearHoverTimer(): void {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hoveredFolder = null;
  }

  function clearDragState(): void {
    clearHoverTimer();
    dropTarget = null;
    sourceParent = null;
    sourceFolderPath = null;
    sourceNoteId = null;
    // Per the dragHoverExpanded spec: the drag must NOT persist this
    // expand state once the drag ends — including cancels, drops on
    // invalid targets, and self-drops where no drop handler runs.
    // Drop handlers in DrawerSidebar also call clearDragHoverExpanded(),
    // but they only fire on successful drops; this is the unconditional
    // teardown path.
    clearDragHoverExpanded();
  }

  function isValidFolderTarget(targetPath: string): boolean {
    if (sourceFolderPath === null) return true;
    if (targetPath === sourceFolderPath) return false;
    if (targetPath.startsWith(`${sourceFolderPath}/`)) return false;
    return true;
  }

  function setDropTarget(path: string): void {
    const next =
      sourceFolderPath !== null && !isValidFolderTarget(path)
        ? null
        : sourceParent === path
          ? null
          : path;
    // dragover fires ~60Hz — avoid churning Svelte reactivity (and the
    // class binding on every visible row) when the value is unchanged.
    if (dropTarget === next) return;
    dropTarget = next;
  }

  function handleFolderClick(node: FolderNode): void {
    toggleFolderOpen(node.path);
  }

  let editingFolderPath = $state<string | null>(null);
  let editingFolderValue = $state('');
  let editingFolderError = $state<string | null>(null);
  let submittingFolderRename = $state(false);
  let inlineRenameInput: HTMLInputElement | undefined = $state();
  let lastRenameRequestNonce = -1;

  $effect(() => {
    if (!renameRequest || renameRequest.nonce === lastRenameRequestNonce) return;
    lastRenameRequestNonce = renameRequest.nonce;
    beginInlineRename(renameRequest.path);
  });

  async function beginInlineRename(path: string): Promise<void> {
    editingFolderPath = path;
    editingFolderValue = idLeaf(path);
    editingFolderError = null;
    await tick();
    inlineRenameInput?.focus();
    inlineRenameInput?.select();
  }

  function cancelInlineRename(): void {
    editingFolderPath = null;
    editingFolderValue = '';
    editingFolderError = null;
    submittingFolderRename = false;
  }

  async function submitInlineRename(): Promise<void> {
    if (!editingFolderPath || submittingFolderRename) return;
    submittingFolderRename = true;
    editingFolderError = null;
    try {
      const error = await onrenamefolder?.(editingFolderPath, editingFolderValue);
      if (error) {
        editingFolderError = error;
        await tick();
        inlineRenameInput?.focus();
        inlineRenameInput?.select();
        return;
      }
      cancelInlineRename();
    } catch (err) {
      editingFolderError = (err as Error).message ?? 'Rename failed';
      await tick();
      inlineRenameInput?.focus();
    } finally {
      submittingFolderRename = false;
    }
  }

  function handleFolderKeydown(e: KeyboardEvent, node: FolderNode): void {
    if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      void beginInlineRename(node.path);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleFolderClick(node);
    }
  }

  function handleInlineRenameKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void submitInlineRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelInlineRename();
    }
  }

  function handleNoteContextMenu(e: MouseEvent, id: string): void {
    if (isMobile) return;
    e.preventDefault();
    onnotecontextmenu?.(id, e.clientX, e.clientY);
  }

  function handleFolderContextMenu(e: MouseEvent, path: string): void {
    if (isMobile) return;
    e.preventDefault();
    onfoldercontextmenu?.(path, e.clientX, e.clientY);
  }

  // ── Mobile touch drag-and-drop ───────────────────────────────────
  // Tap-and-hold a row to "grab" it, then drag to a destination
  // folder. Mirrors the desktop HTML5 drag flow but is driven by
  // touch events: a long-press starts the drag (with a grab animation
  // + haptic), subsequent touchmove updates a DOM mirror that follows
  // the finger, and elementFromPoint resolves the drop target.
  const LONG_PRESS_MS = 350;
  const DRAG_THRESHOLD_PX = 8;

  let pressTimer: number | null = $state(null);
  let touchPressStart: { x: number; y: number } | null = null;
  // Last known touch coords during the active gesture — used to
  // position the context menu when a folder is held without moving.
  let lastTouchPoint: { x: number; y: number } = { x: 0, y: 0 };
  let touchDragKind: 'note' | 'folder' | null = $state(null);
  let touchDragId: string | null = $state(null);
  let touchDragMirror: HTMLElement | null = null;
  let touchDragMirrorRect: DOMRect | null = null;
  let touchDocMoveListener: ((e: TouchEvent) => void) | null = null;
  let touchDocEndListener: ((e: TouchEvent) => void) | null = null;
  let touchDocCancelListener: ((e: TouchEvent) => void) | null = null;
  let touchAutoScrollRaf: number | null = null;
  // Suppress the synthetic click that fires after a long-press tap so
  // a grabbed-then-released note doesn't also get selected.
  let suppressNextClick = false;
  let isTouchDragging = $state(false);
  let pressedRowId = $state<string | null>(null);

  function clearLongPressTimer(): void {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function triggerHaptic(): void {
    if (typeof navigator !== 'undefined') {
      const nav = navigator as Navigator & { vibrate?: (pattern: number | number[]) => boolean };
      try { nav.vibrate?.(20); } catch { /* unsupported */ }
    }
  }

  function beginTouchDrag(
    kind: 'note' | 'folder',
    id: string,
    srcEl: HTMLElement,
    x: number,
    y: number,
  ): void {
    touchDragKind = kind;
    touchDragId = id;
    sourceParent = idParent(id);
    sourceFolderPath = kind === 'folder' ? id : null;
    pressedRowId = id;
    lastTouchPoint = { x, y };
    // Tell the drawer swipe handler to stand down — once a note is
    // grabbed, sideways finger movement is the drag, not a request to
    // slide the sidebar.
    setItemDragging(true);

    const rect = srcEl.getBoundingClientRect();
    touchDragMirrorRect = rect;
    const computed = getComputedStyle(srcEl);
    const mirror = srcEl.cloneNode(true) as HTMLElement;
    // Strip any state classes that would be misleading on a floating
    // mirror (e.g. .selected, .pressed) so it reads as an in-flight
    // copy rather than the original row.
    mirror.classList.remove('selected', 'dragging', 'pressed');
    mirror.style.position = 'fixed';
    mirror.style.top = '0';
    mirror.style.left = '0';
    mirror.style.width = `${rect.width}px`;
    mirror.style.height = `${rect.height}px`;
    mirror.style.margin = '0';
    mirror.style.pointerEvents = 'none';
    mirror.style.zIndex = '99999';
    mirror.style.opacity = '0.96';
    mirror.style.background = 'var(--color-surface, rgba(0,0,0,0.06))';
    mirror.style.color = computed.color;
    mirror.style.font = computed.font;
    mirror.style.borderRadius = '10px';
    mirror.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--color-border, rgba(0,0,0,0.08))';
    mirror.style.transformOrigin = 'center';
    mirror.style.transform = `translate(${x - rect.width / 2}px, ${y - rect.height / 2}px) scale(0.96)`;
    mirror.style.transition = 'transform 140ms cubic-bezier(0.2, 0.9, 0.3, 1.4)';
    document.body.appendChild(mirror);
    touchDragMirror = mirror;

    // Animate up to grabbed scale on the next frame so the transition
    // actually plays (the initial transform is the "settled" pose).
    requestAnimationFrame(() => {
      if (touchDragMirror && touchDragMirrorRect) {
        const w = touchDragMirrorRect.width;
        const h = touchDragMirrorRect.height;
        touchDragMirror.style.transform = `translate(${x - w / 2}px, ${y - h / 2}px) scale(1.06)`;
      }
    });

    triggerHaptic();

    touchDocMoveListener = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (!t) return;
      // Suppress browser scrolling so the drag tracks the finger
      // instead of fighting native pan. Requires passive:false (set
      // when adding the listener).
      ev.preventDefault();
      isTouchDragging = true;
      moveTouchDrag(t.clientX, t.clientY);
    };
    touchDocEndListener = (ev: TouchEvent) => {
      if (ev.touches.length > 0) return; // multi-touch, wait for last finger
      finalizeTouchDrag(true);
    };
    touchDocCancelListener = () => {
      finalizeTouchDrag(false);
    };
    document.addEventListener('touchmove', touchDocMoveListener, { passive: false });
    document.addEventListener('touchend', touchDocEndListener);
    document.addEventListener('touchcancel', touchDocCancelListener);
  }

  function moveTouchDrag(x: number, y: number): void {
    lastTouchPoint = { x, y };
    if (touchDragMirror && touchDragMirrorRect) {
      const w = touchDragMirrorRect.width;
      const h = touchDragMirrorRect.height;
      touchDragMirror.style.transform = `translate(${x - w / 2}px, ${y - h / 2}px) scale(1.06)`;
    }
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) {
      dropTarget = null;
      clearHoverTimer();
    } else {
      const folderEl = el.closest('[data-folder-path]') as HTMLElement | null;
      const noteEl = folderEl ? null : (el.closest('[data-note-id]') as HTMLElement | null);
      if (folderEl) {
        const path = folderEl.getAttribute('data-folder-path') ?? '';
        setDropTarget(path);
        if (hoveredFolder !== path) {
          clearHoverTimer();
          hoveredFolder = path;
          if (!isFolderOpen(path)) {
            hoverTimer = window.setTimeout(() => {
              setDragHoverExpanded(path, true);
              hoverTimer = null;
            }, 600);
          }
        }
      } else if (noteEl) {
        // Hovering a note row inside an open folder routes the drop to
        // its parent folder — same as desktop's handleNoteRowDragOver.
        // The parent folder row picks up the orange outline because the
        // dropTarget binding matches its data-folder-path.
        const noteId = noteEl.getAttribute('data-note-id') ?? '';
        const parent = idParent(noteId);
        setDropTarget(parent);
        clearHoverTimer();
      } else if (
        containerEl?.contains(el) ||
        // Anywhere inside the drawer that isn't a row counts as a
        // root drop — this lets the user drag a nested folder out
        // by lifting it above the items (over the search bar /
        // header / FAB row) without having to hunt for empty space
        // in the scroll list.
        containerEl?.closest('.notes-drawer')?.contains(el)
      ) {
        setDropTarget('');
        clearHoverTimer();
      } else {
        dropTarget = null;
        clearHoverTimer();
      }
    }
    scheduleAutoScroll(y);
  }

  function scheduleAutoScroll(y: number): void {
    if (touchAutoScrollRaf !== null) return;
    touchAutoScrollRaf = requestAnimationFrame(() => {
      touchAutoScrollRaf = null;
      if (touchDragKind === null || !containerEl) return;
      const r = containerEl.getBoundingClientRect();
      const EDGE = 64;
      if (y < r.top + EDGE) {
        containerEl.scrollTop -= 10;
      } else if (y > r.bottom - EDGE) {
        containerEl.scrollTop += 10;
      }
    });
  }

  function finalizeTouchDrag(performDrop: boolean): void {
    if (touchDocMoveListener) {
      document.removeEventListener('touchmove', touchDocMoveListener);
      touchDocMoveListener = null;
    }
    if (touchDocEndListener) {
      document.removeEventListener('touchend', touchDocEndListener);
      touchDocEndListener = null;
    }
    if (touchDocCancelListener) {
      document.removeEventListener('touchcancel', touchDocCancelListener);
      touchDocCancelListener = null;
    }
    if (touchAutoScrollRaf !== null) {
      cancelAnimationFrame(touchAutoScrollRaf);
      touchAutoScrollRaf = null;
    }

    const target = performDrop ? dropTarget : null;
    const kind = touchDragKind;
    const id = touchDragId;
    const wasDragging = isTouchDragging;

    if (touchDragMirror) {
      touchDragMirror.remove();
      touchDragMirror = null;
    }
    touchDragMirrorRect = null;
    touchDragKind = null;
    touchDragId = null;
    isTouchDragging = false;
    pressedRowId = null;
    clearDragState();
    setItemDragging(false);

    if (wasDragging) {
      // The user lifted after moving — suppress the synthetic click
      // that some webviews fire on touchend so a dropped row doesn't
      // also get selected as a side-effect.
      suppressNextClick = true;
      window.setTimeout(() => { suppressNextClick = false; }, 350);
    }

    if (kind && id !== null && target !== null) {
      if (kind === 'note') {
        if (target === '') ondropnoteonroot?.(id);
        else ondropnoteonfolder?.(id, target);
      } else if (kind === 'folder') {
        if (id === target || target.startsWith(`${id}/`)) {
          // invalid — would move folder under itself
        } else if (target === '') {
          if (id.includes('/')) ondropfolderonroot?.(id);
        } else {
          ondropfolderonfolder?.(id, target);
        }
      }
    } else if (kind === 'folder' && id !== null && touchPressStart) {
      // Hold-without-move on a folder shows the context menu (rename,
      // delete, etc.). Notes don't get this fallback — long-press on a
      // note is a drag-only gesture. We measure displacement from the
      // initial press point instead of `wasDragging`, because any tiny
      // finger jitter trips `isTouchDragging`; a held finger commonly
      // wobbles a pixel or two without the user intending to drag.
      const dx = lastTouchPoint.x - touchPressStart.x;
      const dy = lastTouchPoint.y - touchPressStart.y;
      const stayed = Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX;
      if (stayed) {
        onfoldercontextmenu?.(id, lastTouchPoint.x, lastTouchPoint.y);
      }
    }
  }

  function handleNoteTouchStart(e: TouchEvent, id: string): void {
    if (!isMobile) return;
    if (e.touches.length !== 1 || touchDragKind !== null) return;
    const t = e.touches[0];
    touchPressStart = { x: t.clientX, y: t.clientY };
    pressedRowId = id;
    const srcEl = e.currentTarget as HTMLElement;
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      if (touchPressStart) {
        beginTouchDrag('note', id, srcEl, touchPressStart.x, touchPressStart.y);
      }
    }, LONG_PRESS_MS);
  }

  function handleFolderTouchStart(e: TouchEvent, path: string): void {
    if (!isMobile) return;
    if (e.touches.length !== 1 || touchDragKind !== null) return;
    const t = e.touches[0];
    touchPressStart = { x: t.clientX, y: t.clientY };
    pressedRowId = path;
    const srcEl = e.currentTarget as HTMLElement;
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      if (touchPressStart) {
        beginTouchDrag('folder', path, srcEl, touchPressStart.x, touchPressStart.y);
      }
    }, LONG_PRESS_MS);
  }

  function handleRowTouchMove(e: TouchEvent): void {
    if (!isMobile) return;
    // Cancel a pending long-press if the finger drifts beyond the
    // threshold — that movement is the user starting to scroll, not
    // settling in for a press.
    if (pressTimer !== null && touchPressStart) {
      const t = e.touches[0];
      if (!t) return;
      if (
        Math.abs(t.clientX - touchPressStart.x) > DRAG_THRESHOLD_PX ||
        Math.abs(t.clientY - touchPressStart.y) > DRAG_THRESHOLD_PX
      ) {
        clearLongPressTimer();
        pressedRowId = null;
      }
    }
    // Once the drag is active, the document-level touchmove handles
    // tracking — nothing to do here.
  }

  function handleRowTouchEnd(): void {
    if (!isMobile) return;
    if (pressTimer !== null) {
      clearLongPressTimer();
      pressedRowId = null;
    }
    // If a drag is active, the document-level touchend will finalize
    // it. We never finalize from here so the two paths can't race.
  }

  function handleRowTouchCancel(): void {
    if (!isMobile) return;
    clearLongPressTimer();
    pressedRowId = null;
    // Active drags are torn down by the document-level cancel path.
  }

  function handleNoteClick(id: string, event?: MouseEvent): void {
    if (suppressNextClick) return;
    onselect?.(id, event);
  }

  // WebKitGTK rasterizes the OS-supplied drag image at logical pixels and
  // upscales for hi-DPI displays — the result is blurry and oversized.
  // We hand WebKit a 1×1 transparent canvas to suppress its default and
  // maintain our own DOM mirror that `dragover` repositions, so the
  // user-visible ghost is a real DOM node at native DPR.
  //
  // This is WebKitGTK-ONLY. macOS WKWebView (and Windows WebView2) render the
  // native drag image crisply, so they don't need it — and worse, they abort
  // the drag if it runs: mutating the DOM during `dragstart` (appending the
  // 1×1 canvas + the cloned mirror to <body>, calling setDragImage on a node
  // that's then removed) makes WKWebView fire `dragend` immediately with zero
  // `dragover` events, so no folder ever highlights and drops never land.
  // (2026-07-08 macOS repro: drag note → folder silently failed.) Gate the
  // whole hack on Linux; elsewhere let the OS handle the drag image natively.
  let dragMirror: HTMLElement | null = null;
  let dragMirrorMove: ((ev: DragEvent) => void) | null = null;

  function setControlledDragImage(e: DragEvent): void {
    if (!isLinux) return;
    if (!e.dataTransfer) return;
    const src = e.currentTarget as HTMLElement | null;
    if (!src) return;

    // try/catch on each step so a failed visual override never breaks the
    // actual drag-and-drop.
    try {
      const blank = document.createElement('canvas');
      blank.width = 1;
      blank.height = 1;
      blank.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none;';
      // WebKitGTK requires the source element to be in the document tree
      // when setDragImage runs, otherwise it silently aborts the drag.
      document.body.appendChild(blank);
      e.dataTransfer.setDragImage(blank, 0, 0);
      setTimeout(() => blank.remove(), 0);
    } catch (err) {
      console.warn('[drag] setDragImage suppression failed', err);
    }

    try {
      teardownDragMirror();
      const rect = src.getBoundingClientRect();
      const computed = getComputedStyle(src);
      const mirror = src.cloneNode(true) as HTMLElement;
      mirror.style.position = 'fixed';
      mirror.style.top = '0';
      mirror.style.left = '0';
      mirror.style.width = `${rect.width}px`;
      mirror.style.height = `${rect.height}px`;
      mirror.style.pointerEvents = 'none';
      mirror.style.zIndex = '99999';
      mirror.style.opacity = '0.92';
      mirror.style.background = 'var(--color-surface, rgba(0,0,0,0.06))';
      mirror.style.color = computed.color;
      mirror.style.font = computed.font;
      mirror.style.borderRadius = '10px';
      mirror.style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.22)';
      mirror.style.willChange = 'transform';
      mirror.style.transform = `translate(${e.clientX - rect.width / 2}px, ${e.clientY - rect.height / 2}px)`;
      document.body.appendChild(mirror);
      dragMirror = mirror;

      // rAF-throttle: dragover fires faster than the display refreshes
      // on hi-DPR / Wayland. Coalesce multiple events per frame into one
      // transform write so the compositor sees at most one update per
      // animation frame.
      let pending = false;
      let lastEv: DragEvent | null = null;
      const move = (ev: DragEvent) => {
        if (ev.clientX === 0 && ev.clientY === 0) return; // drop-outside firings
        lastEv = ev;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          if (!lastEv) return;
          mirror.style.transform = `translate(${lastEv.clientX - rect.width / 2}px, ${lastEv.clientY - rect.height / 2}px)`;
        });
      };
      document.addEventListener('dragover', move, { capture: true });
      dragMirrorMove = move;
    } catch (err) {
      console.warn('[drag] mirror setup failed', err);
    }
  }

  function teardownDragMirror(): void {
    if (dragMirrorMove) {
      document.removeEventListener('dragover', dragMirrorMove, { capture: true } as EventListenerOptions);
      dragMirrorMove = null;
    }
    if (dragMirror) {
      dragMirror.remove();
      dragMirror = null;
    }
  }

  function handleNoteDragStart(e: DragEvent, id: string): void {
    if (isMobile || !e.dataTransfer) return;
    e.dataTransfer.setData(NOTE_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    sourceParent = idParent(id);
    sourceFolderPath = null;
    sourceNoteId = id;
    setControlledDragImage(e);
    onnotedragstart?.(id, e);
  }

  function handleFolderDragStart(e: DragEvent, path: string): void {
    if (isMobile || !e.dataTransfer) return;
    e.dataTransfer.setData(FOLDER_MIME, path);
    e.dataTransfer.effectAllowed = 'move';
    sourceParent = idParent(path);
    sourceFolderPath = path;
    sourceNoteId = null;
    setControlledDragImage(e);
    onfolderdragstart?.(path, e);
  }

  function handleDragEnd(): void {
    clearDragState();
    teardownDragMirror();
  }

  function dtCarriesNoteOrFolder(dt: DataTransfer | null): boolean {
    if (sourceNoteId !== null || sourceFolderPath !== null) return true;
    if (!dt) return false;
    return dt.types.includes(NOTE_MIME) || dt.types.includes(FOLDER_MIME);
  }

  function handleFolderRowDragOver(e: DragEvent, path: string): void {
    if (isMobile) return;
    const dt = e.dataTransfer;
    if (!dtCarriesNoteOrFolder(dt)) return;
    e.preventDefault();
    // The scroll container's dragover targets the root drop zone — without
    // stopPropagation it would fire AFTER this one and clobber dropTarget.
    e.stopPropagation();
    if (dt) dt.dropEffect = 'move';
    setDropTarget(path);
    if (hoveredFolder !== path) {
      clearHoverTimer();
      hoveredFolder = path;
      // 600ms hover over a closed folder expands it so the user can drop
      // into a sub-folder without an explicit click.
      if (!isFolderOpen(path)) {
        hoverTimer = window.setTimeout(() => {
          setDragHoverExpanded(path, true);
          hoverTimer = null;
        }, 600);
      }
    }
  }

  function handleNoteRowDragOver(e: DragEvent, parentPath: string): void {
    if (isMobile) return;
    const dt = e.dataTransfer;
    if (!dtCarriesNoteOrFolder(dt)) return;
    e.preventDefault();
    e.stopPropagation();
    if (dt) dt.dropEffect = 'move';
    // A note row inside an open folder counts as a drop into its parent.
    setDropTarget(parentPath);
    clearHoverTimer();
  }

  function handleRowDrop(e: DragEvent, target: string): void {
    if (isMobile) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    e.stopPropagation();
    const noteId = dt.getData(NOTE_MIME) || sourceNoteId || '';
    const folderPath = dt.getData(FOLDER_MIME) || sourceFolderPath || '';
    clearDragState();
    teardownDragMirror();
    if (noteId) {
      if (target === '') ondropnoteonroot?.(noteId);
      else ondropnoteonfolder?.(noteId, target);
    } else if (folderPath) {
      if (folderPath === target || target.startsWith(`${folderPath}/`)) return;
      if (target === '') {
        if (folderPath.includes('/')) ondropfolderonroot?.(folderPath);
      } else {
        ondropfolderonfolder?.(folderPath, target);
      }
    }
  }

  function handleFolderRowDragLeave(e: DragEvent): void {
    if (isMobile) return;
    void e;
    clearHoverTimer();
  }

  function handleRootDragOver(e: DragEvent): void {
    if (isMobile) return;
    const dt = e.dataTransfer;
    if (!dtCarriesNoteOrFolder(dt)) return;
    e.preventDefault();
    if (dt) dt.dropEffect = 'move';
    setDropTarget('');
  }

  function handleRootDragLeave(e: DragEvent): void {
    if (isMobile) return;
    const related = e.relatedTarget as Node | null;
    // WebKitGTK fires dragleave with relatedTarget=null on every
    // row→row transition during a drag. Treating null as "left
    // container" caused the outline to flicker on/off at ~60Hz. Only
    // act on dragleaves whose relatedTarget is genuinely outside;
    // window-level leaves with null relatedTarget are left to dragend
    // to clean up.
    if (!related) return;
    const container = e.currentTarget as Node;
    if (container.contains(related)) return;
    dropTarget = null;
    clearHoverTimer();
  }

  function handleRootDrop(e: DragEvent): void {
    if (isMobile) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    const noteId = dt.getData(NOTE_MIME) || sourceNoteId || '';
    const folderPath = dt.getData(FOLDER_MIME) || sourceFolderPath || '';
    clearDragState();
    teardownDragMirror();
    if (noteId) {
      ondropnoteonroot?.(noteId);
    } else if (folderPath && folderPath.includes('/')) {
      // Only nested folders can move back to root. A top-level folder
      // dropped on root is a no-op.
      ondropfolderonroot?.(folderPath);
    }
  }

  onDestroy(() => {
    clearHoverTimer();
    clearLongPressTimer();
    teardownDragMirror();
    // Make sure we don't leave document-level listeners attached if
    // the component is unmounted mid-drag.
    if (touchDocMoveListener) {
      document.removeEventListener('touchmove', touchDocMoveListener);
      touchDocMoveListener = null;
    }
    if (touchDocEndListener) {
      document.removeEventListener('touchend', touchDocEndListener);
      touchDocEndListener = null;
    }
    if (touchDocCancelListener) {
      document.removeEventListener('touchcancel', touchDocCancelListener);
      touchDocCancelListener = null;
    }
    if (touchAutoScrollRaf !== null) {
      cancelAnimationFrame(touchAutoScrollRaf);
      touchAutoScrollRaf = null;
    }
    if (touchDragMirror) {
      touchDragMirror.remove();
      touchDragMirror = null;
    }
    setItemDragging(false);
  });
</script>

<!-- The scroll container is the root drop target during a drag. The
     a11y_no_static_element_interactions rule fires because <div> has
     drag handlers — desktop uses HTML5 drag, mobile uses a touch-driven
     drag (long-press to grab, drag with finger), so a keyboard-only
     equivalent is not applicable to this element. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={containerEl}
  class="folder-tree-scroll"
  class:root-drop-target={dropTarget === ''}
  onscroll={handleScroll}
  ondragover={handleRootDragOver}
  ondragleave={handleRootDragLeave}
  ondrop={handleRootDrop}
  data-dragging={isDragging || undefined}
>
  {#if flat.length === 0}
    <div class="empty-state">No notes yet. Tap + to create one.</div>
  {:else}
    <div class="virtual-spacer" style="height: {flat.length * ROW_HEIGHT}px;">
      {#each visibleNodes as { node, index } (node.type === 'folder' ? `f:${node.path}` : node.type === 'empty' ? `e:${node.parentPath}` : `n:${node.note.id}`)}
        {#if node.type === 'folder'}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            role="button"
            tabindex="0"
            class="folder-row virtual-row"
            class:dragging={isDragging}
            class:drop-target={dropTarget === node.path}
            class:touch-grabbed={touchDragKind === 'folder' && touchDragId === node.path}
            class:touch-pressed={pressedRowId === node.path && touchDragKind === null && pressTimer !== null}
            style="top: {index * ROW_HEIGHT}px; left: {node.depth * DEPTH_INDENT_PX}px"
            onclick={() => handleFolderClick(node)}
            ondblclick={(e) => { e.preventDefault(); e.stopPropagation(); void beginInlineRename(node.path); }}
            onkeydown={(e) => handleFolderKeydown(e, node)}
            oncontextmenu={(e) => handleFolderContextMenu(e, node.path)}
            ontouchstart={(e) => handleFolderTouchStart(e, node.path)}
            ontouchend={handleRowTouchEnd}
            ontouchcancel={handleRowTouchCancel}
            ontouchmove={handleRowTouchMove}
            draggable={!isMobile}
            ondragstart={(e) => handleFolderDragStart(e, node.path)}
            ondragend={handleDragEnd}
            ondragover={(e) => handleFolderRowDragOver(e, node.path)}
            ondragleave={handleFolderRowDragLeave}
            ondrop={(e) => handleRowDrop(e, node.path)}
            data-folder-path={node.path}
          >
            <span class="folder-icon" aria-hidden="true">
              {#if isFolderOpen(node.path)}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>
                </svg>
              {:else}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
                </svg>
              {/if}
            </span>
            {#if editingFolderPath === node.path}
              <span
                class="folder-inline-edit"
                onclick={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
                onkeydown={(e) => e.stopPropagation()}
              >
                <input
                  bind:this={inlineRenameInput}
                  bind:value={editingFolderValue}
                  class:error={editingFolderError !== null}
                  disabled={submittingFolderRename}
                  aria-label="Folder name"
                  aria-invalid={editingFolderError !== null}
                  title={editingFolderError ?? 'Folder name'}
                  onkeydown={handleInlineRenameKeydown}
                  onblur={() => { if (!submittingFolderRename) void submitInlineRename(); }}
                  data-testid="folder-rename-input"
                />
              </span>
            {:else}
              <span class="folder-name">{node.name}</span>
            {/if}
            {#if isMobile}
              <button
                type="button"
                class="folder-add-btn"
                aria-label="New folder in {node.path}"
                title="New folder"
                onclick={(e) => { e.preventDefault(); e.stopPropagation(); oncreatefolder?.(node.path); }}
                onmousedown={(e) => e.stopPropagation()}
                ontouchstart={(e) => e.stopPropagation()}
                data-testid="folder-add-subfolder"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
            {/if}
          </div>
        {:else if node.type === 'empty'}
          <!-- Per-folder empty state (spec list.md "An empty folder shows an
               empty state"). Emitted by flattenTree as a real flattened row so
               the virtualization spacer/top math stays exact. Drag handlers
               route drops on it into the parent folder, matching the note-row
               behavior — without them this indented area would read as a
               root drop target. -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="folder-empty-row virtual-row"
            style="top: {index * ROW_HEIGHT}px; left: {node.depth * DEPTH_INDENT_PX}px"
            ondragover={(e) => handleNoteRowDragOver(e, node.parentPath)}
            ondrop={(e) => handleRowDrop(e, node.parentPath)}
            data-folder-path={node.parentPath}
            data-testid="folder-empty-state"
          >Nothing here yet</div>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <button
            type="button"
            class="note-row virtual-row"
            class:selected={node.note.id === selectedId}
            class:dragging={isDragging}
            class:touch-grabbed={touchDragKind === 'note' && touchDragId === node.note.id}
            class:touch-pressed={pressedRowId === node.note.id && touchDragKind === null && pressTimer !== null}
            style="top: {index * ROW_HEIGHT}px; left: {node.depth * DEPTH_INDENT_PX}px"
            onclick={(e) => handleNoteClick(node.note.id, e)}
            onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); handleNoteClick(node.note.id, e); } }}
            oncontextmenu={(e) => handleNoteContextMenu(e, node.note.id)}
            ontouchstart={(e) => handleNoteTouchStart(e, node.note.id)}
            ontouchend={handleRowTouchEnd}
            ontouchcancel={handleRowTouchCancel}
            ontouchmove={handleRowTouchMove}
            draggable={!isMobile}
            ondragstart={(e) => handleNoteDragStart(e, node.note.id)}
            ondragend={handleDragEnd}
            ondragover={(e) => handleNoteRowDragOver(e, node.parentPath)}
            ondrop={(e) => handleRowDrop(e, node.parentPath)}
            data-note-id={node.note.id}
          >
            <span class="note-title">{idLeaf(node.note.title)}</span>
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .folder-tree-scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px 8px calc(80px + env(safe-area-inset-bottom, 0));
  }
  .virtual-spacer {
    position: relative;
    width: 100%;
  }
  .virtual-row {
    position: absolute;
    left: 0;
    right: 0;
    margin: 0;
  }
  .empty-state {
    padding: 32px;
    text-align: center;
    color: var(--color-muted, #888);
    font-size: 0.95rem;
  }
  /* Per-folder empty state — same muted look as .empty-state, but shaped
     like a row (48px + 1px margins = ROW_HEIGHT) so it slots into the
     virtualized flow, indented under its folder row. */
  .folder-empty-row {
    display: flex;
    align-items: center;
    height: 48px;
    margin: 1px 0;
    padding: 0 12px;
    box-sizing: border-box;
    color: var(--color-muted, #888);
    font-size: 0.95rem;
    user-select: none;
  }
  .folder-row,
  .note-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0 12px;
    margin: 1px 0;
    box-sizing: border-box;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.1s ease, box-shadow 0.1s ease;
    /* Scope each row's layout/paint to itself so a hover or drop-target
       outline change doesn't trigger reflow/repaint of siblings. Dropped
       p95 frame time noticeably during long drags through 2k-row trees. */
    contain: layout style paint;
  }
  .folder-row:focus-visible,
  .note-row:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }
  .folder-row:hover,
  .note-row:hover {
    background: rgba(var(--ink-rgb), 0.06);
  }
  .note-row.selected {
    background: rgba(var(--primary-rgb), 0.12);
  }
  .note-row.selected .note-title {
    color: var(--color-primary-hover);
    font-weight: 600;
  }
  .note-row.selected:active {
    background: rgba(var(--primary-rgb), 0.18);
  }
  /* Drop-target outline shown while a drag hovers a different "home"
     than the dragged item's current parent. The 2px inset outline reads
     against both the transparent and the selected backgrounds. Only the
     folder row gets the outline — note rows route their drop to the
     parent folder, so the highlight always lands on the folder header. */
  .folder-row.drop-target {
    box-shadow: inset 0 0 0 2px var(--color-primary);
    background: rgba(var(--primary-rgb), 0.08);
  }
  .folder-icon {
    display: inline-flex;
    align-items: center;
    color: var(--color-muted, #555);
    flex: 0 0 auto;
  }
  .folder-name,
  .note-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.95rem;
    color: var(--color-text);
  }
  .folder-name {
    font-weight: 500;
    flex: 1 1 auto;
    min-width: 0;
  }
  .folder-inline-edit {
    flex: 1 1 auto;
    min-width: 0;
  }
  .folder-inline-edit input {
    width: 100%;
    height: 30px;
    border: 1px solid var(--color-primary);
    border-radius: 6px;
    padding: 3px 7px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    box-sizing: border-box;
  }
  .folder-inline-edit input.error {
    border-color: #b91c1c;
  }
  .folder-add-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-muted, #555);
    cursor: pointer;
    opacity: 0.72;
  }
  .folder-add-btn:hover,
  .folder-add-btn:focus-visible {
    background: rgba(var(--ink-rgb), 0.08);
    color: var(--color-text);
    opacity: 1;
  }
  /* Root drop target — when dragging an item out of any folder back to the
     vault root, outline the entire scroll area (only when applicable). */
  .folder-tree-scroll.root-drop-target {
    box-shadow: inset 0 0 0 2px var(--color-primary);
    border-radius: 10px;
  }

  /* Mobile touch-press feedback. While the long-press timer counts
     down, the row dims slightly so the user sees their touch is
     registering. */
  .folder-row.touch-pressed,
  .note-row.touch-pressed {
    background: rgba(var(--ink-rgb), 0.08);
    transition: background 0.18s ease;
  }

  /* The source row stays in place during a touch drag but fades out
     so the floating mirror reads as the live element. */
  .folder-row.touch-grabbed,
  .note-row.touch-grabbed {
    opacity: 0.35;
    transition: opacity 0.12s ease;
  }
</style>

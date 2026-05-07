<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NotePreview } from '../types';
  import {
    buildFolderTree,
    flattenTree,
    isFolderOpen,
    toggleFolderOpen,
    setDragHoverExpanded,
    type TreeNode,
    type FolderNode,
  } from '$lib/folders.svelte';
  import { isDesktop } from '$lib/platform';
  import { idParent, idLeaf } from '$lib/platform/pathSafety';

  // Custom MIME types used to thread the dragged item's ID through the
  // dataTransfer payload. Drop handlers read these to decide what to move.
  const NOTE_MIME = 'application/futo-note-id';
  const FOLDER_MIME = 'application/futo-folder-path';

  interface Props {
    items: NotePreview[];
    selectedId?: string | null;
    isDragging?: boolean;
    onselect?: (id: string) => void;
    onfoldercontextmenu?: (path: string, x: number, y: number) => void;
    onnotecontextmenu?: (id: string, x: number, y: number) => void;
    onnotedragstart?: (id: string, e: DragEvent) => void;
    onfolderdragstart?: (path: string, e: DragEvent) => void;
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

  function handleNoteContextMenu(e: MouseEvent, id: string): void {
    if (!isDesktop) return;
    e.preventDefault();
    onnotecontextmenu?.(id, e.clientX, e.clientY);
  }

  function handleFolderContextMenu(e: MouseEvent, path: string): void {
    if (!isDesktop) return;
    e.preventDefault();
    onfoldercontextmenu?.(path, e.clientX, e.clientY);
  }

  // Tap-and-hold for mobile context menus
  let pressTimer: number | null = null;

  function handleNoteTouchStart(e: TouchEvent, id: string): void {
    if (isDesktop) return;
    const t = e.touches[0];
    const x = t.clientX;
    const y = t.clientY;
    pressTimer = window.setTimeout(() => {
      onnotecontextmenu?.(id, x, y);
      pressTimer = null;
    }, 500);
  }

  function handleFolderTouchStart(e: TouchEvent, path: string): void {
    if (isDesktop) return;
    const t = e.touches[0];
    const x = t.clientX;
    const y = t.clientY;
    pressTimer = window.setTimeout(() => {
      onfoldercontextmenu?.(path, x, y);
      pressTimer = null;
    }, 500);
  }

  function clearPressTimer(): void {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  // WebKitGTK rasterizes the OS-supplied drag image at logical pixels and
  // upscales for hi-DPI displays — the result is blurry and oversized.
  // We hand WebKit a 1×1 transparent canvas to suppress its default and
  // maintain our own DOM mirror that `dragover` repositions, so the
  // user-visible ghost is a real DOM node at native DPR.
  let dragMirror: HTMLElement | null = null;
  let dragMirrorMove: ((ev: DragEvent) => void) | null = null;

  function setControlledDragImage(e: DragEvent): void {
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
    if (!isDesktop || !e.dataTransfer) return;
    e.dataTransfer.setData(NOTE_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    sourceParent = idParent(id);
    sourceFolderPath = null;
    setControlledDragImage(e);
    onnotedragstart?.(id, e);
  }

  function handleFolderDragStart(e: DragEvent, path: string): void {
    if (!isDesktop || !e.dataTransfer) return;
    e.dataTransfer.setData(FOLDER_MIME, path);
    e.dataTransfer.effectAllowed = 'move';
    sourceParent = idParent(path);
    sourceFolderPath = path;
    setControlledDragImage(e);
    onfolderdragstart?.(path, e);
  }

  function handleDragEnd(): void {
    clearDragState();
    teardownDragMirror();
  }

  function dtCarriesNoteOrFolder(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    return dt.types.includes(NOTE_MIME) || dt.types.includes(FOLDER_MIME);
  }

  function handleFolderRowDragOver(e: DragEvent, path: string): void {
    if (!isDesktop) return;
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
    if (!isDesktop) return;
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
    if (!isDesktop) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    e.stopPropagation();
    const noteId = dt.getData(NOTE_MIME);
    const folderPath = dt.getData(FOLDER_MIME);
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
    if (!isDesktop) return;
    void e;
    clearHoverTimer();
  }

  function handleRootDragOver(e: DragEvent): void {
    if (!isDesktop) return;
    const dt = e.dataTransfer;
    if (!dtCarriesNoteOrFolder(dt)) return;
    e.preventDefault();
    if (dt) dt.dropEffect = 'move';
    setDropTarget('');
  }

  function handleRootDragLeave(e: DragEvent): void {
    if (!isDesktop) return;
    // Only clear if we left the scroll container entirely. Leaving a row
    // inside the container fires dragleave too, so check relatedTarget.
    const related = e.relatedTarget as Node | null;
    const container = e.currentTarget as Node;
    if (related && container.contains(related)) return;
    dropTarget = null;
    clearHoverTimer();
  }

  function handleRootDrop(e: DragEvent): void {
    if (!isDesktop) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    const noteId = dt.getData(NOTE_MIME);
    const folderPath = dt.getData(FOLDER_MIME);
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
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    teardownDragMirror();
  });
</script>

<!-- The scroll container is the root drop target during a drag. The
     a11y_no_static_element_interactions rule fires because <div> has
     drag handlers — drag-and-drop is desktop-mouse-only by design (the
     mobile UX uses the long-press context menu's "Move to folder"), so
     a keyboard-equivalent is not applicable to this element. -->
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
      {#each visibleNodes as { node, index } (node.type === 'folder' ? `f:${node.path}` : `n:${node.note.id}`)}
        {#if node.type === 'folder'}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <button
            type="button"
            class="folder-row virtual-row"
            class:dragging={isDragging}
            class:drop-target={dropTarget === node.path}
            style="top: {index * ROW_HEIGHT}px; padding-left: {12 + node.depth * 16}px"
            onclick={() => handleFolderClick(node)}
            oncontextmenu={(e) => handleFolderContextMenu(e, node.path)}
            ontouchstart={(e) => handleFolderTouchStart(e, node.path)}
            ontouchend={clearPressTimer}
            ontouchcancel={clearPressTimer}
            ontouchmove={clearPressTimer}
            draggable={isDesktop}
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
            <span class="folder-name">{node.name}</span>
          </button>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <button
            type="button"
            class="note-row virtual-row"
            class:selected={node.note.id === selectedId}
            class:dragging={isDragging}
            style="top: {index * ROW_HEIGHT}px; padding-left: {12 + node.depth * 16}px"
            onclick={() => onselect?.(node.note.id)}
            oncontextmenu={(e) => handleNoteContextMenu(e, node.note.id)}
            ontouchstart={(e) => handleNoteTouchStart(e, node.note.id)}
            ontouchend={clearPressTimer}
            ontouchcancel={clearPressTimer}
            ontouchmove={clearPressTimer}
            draggable={isDesktop}
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
  .folder-row,
  .note-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 48px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    padding-right: 12px;
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
  }
  /* Root drop target — when dragging an item out of any folder back to the
     vault root, outline the entire scroll area (only when applicable). */
  .folder-tree-scroll.root-drop-target {
    box-shadow: inset 0 0 0 2px var(--color-primary);
    border-radius: 10px;
  }
</style>

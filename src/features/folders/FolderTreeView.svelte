<script lang="ts">
  import './folderTree.css';

  import { flushSync, onDestroy } from 'svelte';
  import type { NotePreview } from '$shared/types/note';
  import { isFolderOpen, toggleFolderOpen } from './folderExpansion.svelte';
  import { buildFolderTree, flattenFolderTree, type FlatNode, type FolderNode } from './folderTree';
  import { getEmptyFolders } from './emptyFolders.svelte';
  import { createFolderTreeDrag } from './createFolderTreeDrag.svelte';
  import FolderTreeEmptyRow from './FolderTreeEmptyRow.svelte';
  import FolderTreeFolderRow from './FolderTreeFolderRow.svelte';
  import FolderTreeNoteRow from './FolderTreeNoteRow.svelte';

  interface Props {
    items: NotePreview[];
    selectedId?: string | null;
    onselect?: (id: string, event?: MouseEvent) => void;
    onfoldercontextmenu?: (path: string, x: number, y: number) => void;
    onnotecontextmenu?: (id: string, x: number, y: number) => void;
    onnotedragstart?: (id: string, e: DragEvent) => void;
    onfolderdragstart?: (path: string, e: DragEvent) => void;
    onrenamefolder?: (path: string, newName: string) => Promise<string | null> | string | null;
    onrenamenote?: (id: string, newTitle: string) => Promise<string | null> | string | null;
    renameRequest?: { path: string; nonce: number } | null;
    noteRenameRequest?: { id: string; nonce: number } | null;
    ondropnoteonfolder?: (noteId: string, folderPath: string) => void;
    ondropfolderonfolder?: (folderPath: string, targetPath: string) => void;
    ondropnoteonroot?: (noteId: string) => void;
    ondropfolderonroot?: (folderPath: string) => void;
  }

  let {
    items,
    selectedId = null,
    onselect,
    onfoldercontextmenu,
    onnotecontextmenu,
    onnotedragstart,
    onfolderdragstart,
    onrenamefolder,
    onrenamenote,
    renameRequest = null,
    noteRenameRequest = null,
    ondropnoteonfolder,
    ondropfolderonfolder,
    ondropnoteonroot,
    ondropfolderonroot,
  }: Props = $props();

  const drag = createFolderTreeDrag({
    onNoteDragStart: (id, event) => onnotedragstart?.(id, event),
    onFolderDragStart: (path, event) => onfolderdragstart?.(path, event),
    onDropNoteOnFolder: (noteId, folderPath) => ondropnoteonfolder?.(noteId, folderPath),
    onDropFolderOnFolder: (folderPath, targetPath) =>
      ondropfolderonfolder?.(folderPath, targetPath),
    onDropNoteOnRoot: (noteId) => ondropnoteonroot?.(noteId),
    onDropFolderOnRoot: (folderPath) => ondropfolderonroot?.(folderPath),
  });

  const tree = $derived(buildFolderTree(items, getEmptyFolders()));
  const flat = $derived(flattenFolderTree(tree, isFolderOpen));

  const DEPTH_INDENT_PX = 16;

  // ── Virtualization ──────────────────────────────────────────────────────
  // Only the rows near the viewport are mounted; the rest are represented by
  // two spacer divs. Every row is the same height (folderTree.css sizes
  // .folder-row/.note-row/.folder-empty-row identically), so a scroll offset
  // maps to an index arithmetically and no per-row measurement is needed.
  //
  // This is what keeps switching notes fast on a large vault. A note switch
  // dirties layout, and WebKit then lays out every mounted row: at 2,533 rows
  // that measured ~125 ms of a ~148 ms Ctrl+Tab, and CSS containment does not
  // avoid it (the rows already set `contain: layout style paint`). Rendering
  // only the visible window is the only thing that removes the work.
  // → docs/perf/tab-switch-baseline.md
  const OVERSCAN_ROWS = 8;
  // WebKit scrolls this container on its own thread, so it can paint a new
  // scroll offset before the main thread is told about it. Measured on a
  // 3,207-note vault, a wheel fling moves 1,000-5,500px between consecutive
  // scroll notifications, while 8 rows of overscan cover only ~390px — so the
  // painted viewport lands entirely on the spacer and the sidebar goes blank
  // and label-less for several frames. Flushing the projection synchronously
  // does NOT help (the paint already happened); the window has to be wide
  // enough to cover where the scroll is going. So lead the window by however
  // far the last notification jumped, and let it collapse back to the cheap
  // window once scrolling settles, so a note switch never pays for it.
  // → docs/perf/tab-switch-baseline.md
  const SCROLL_SETTLE_MS = 120;
  // Peak-hold decay: a fling decelerates, so shrink the lead gradually instead
  // of tracking each smaller delta straight down and re-exposing the spacer.
  const LEAD_DECAY_ROWS = 4;
  // A scrollbar-thumb drag can jump the whole list at once, and leading by that
  // much would mount every row — exactly the cost virtualization exists to
  // avoid. Cap the lead at more than the largest fling jump measured (~5,500px
  // ≈ 112 rows); a single teleport frame can still miss, but a sustained fling
  // cannot.
  const MAX_LEAD_ROWS = 128;
  // Used until a real pitch can be measured. Rows are 48px tall with 1px
  // collapsed vertical margins; measureRowPitch() corrects any CSS drift.
  const FALLBACK_ROW_PITCH = 49;

  let scroller: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let rowPitch = $state(FALLBACK_ROW_PITCH);
  // Rows to mount beyond the viewport in the direction of travel, and its sign.
  let scrollLeadRows = $state(0);
  let scrollLeadDown = $state(true);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function keyOf(node: FlatNode): string {
    if (node.type === 'folder') return `f:${node.path}`;
    if (node.type === 'empty') return `e:${node.parentPath}`;
    return `n:${node.note.id}`;
  }

  const window_ = $derived.by(() => {
    const total = flat.length;
    // No measured viewport (jsdom, or the frame before the ResizeObserver
    // first reports): render everything rather than guess a window and hide
    // rows a caller expects to be present.
    if (viewportHeight <= 0) return { start: 0, end: total, padTop: 0, padBottom: 0 };

    const pitch = rowPitch > 0 ? rowPitch : FALLBACK_ROW_PITCH;
    const leadUp = scrollLeadDown ? 0 : scrollLeadRows;
    const leadDown = scrollLeadDown ? scrollLeadRows : 0;
    let start = Math.max(0, Math.floor(scrollTop / pitch) - OVERSCAN_ROWS - leadUp);
    let end = Math.min(
      total,
      Math.ceil((scrollTop + viewportHeight) / pitch) + OVERSCAN_ROWS + leadDown,
    );

    // An inline folder rename must stay mounted even if the user scrolls away,
    // or the input unmounts mid-edit and silently drops what they typed. The
    // rename always starts on a visible row, so in practice this widens the
    // window by nothing; the unbounded case is a user scrolling away while
    // renaming, where correctness beats row count.
    const pinnedKey = renameRequest
      ? `f:${renameRequest.path}`
      : noteRenameRequest
        ? `n:${noteRenameRequest.id}`
        : null;
    if (pinnedKey) {
      const pinned = flat.findIndex((node) => keyOf(node) === pinnedKey);
      if (pinned >= 0) {
        start = Math.min(start, pinned);
        end = Math.max(end, pinned + 1);
      }
    }

    return {
      start,
      end,
      padTop: start * pitch,
      padBottom: Math.max(0, (total - end) * pitch),
    };
  });

  const visible = $derived(flat.slice(window_.start, window_.end));

  function handleScroll(): void {
    if (!scroller) return;
    const next = scroller.scrollTop;
    const pitch = rowPitch > 0 ? rowPitch : FALLBACK_ROW_PITCH;
    const jumpedRows = Math.ceil(Math.abs(next - scrollTop) / pitch);
    // A fling's first notification is small, so the jump alone under-predicts
    // where the next painted frame lands; cover at least one viewport ahead
    // for as long as the list is moving at all.
    const viewportRows = Math.ceil(viewportHeight / pitch);
    // WebKit can paint the new scroll offset before Svelte's normal microtask
    // flush. With only the old virtual window mounted, a large wheel/thumb jump
    // then shows spacer-only blank rows for one frame. Mount the destination
    // slice inside the scroll event so every paint has labels; the lead above
    // covers the frames WebKit paints before notifying the main thread at all.
    flushSync(() => {
      if (next !== scrollTop) scrollLeadDown = next > scrollTop;
      scrollLeadRows = Math.min(
        MAX_LEAD_ROWS,
        Math.max(jumpedRows, viewportRows, scrollLeadRows - LEAD_DECAY_ROWS),
      );
      scrollTop = next;
    });
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      scrollLeadRows = 0;
    }, SCROLL_SETTLE_MS);
  }

  // Two adjacent mounted rows give the real pitch including collapsed margins,
  // so a CSS height change can never silently desync the scroll math.
  function measureRowPitch(): void {
    if (!scroller) return;
    const rows = scroller.querySelectorAll<HTMLElement>(
      '.folder-row, .note-row, .folder-empty-row',
    );
    if (rows.length < 2) return;
    const measured = rows[1].offsetTop - rows[0].offsetTop;
    if (measured > 0 && measured !== rowPitch) rowPitch = measured;
  }

  $effect(() => {
    const el = scroller;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      viewportHeight = el.clientHeight;
      measureRowPitch();
    });
    observer.observe(el);
    viewportHeight = el.clientHeight;
    return () => observer.disconnect();
  });

  $effect(() => {
    // Re-measure whenever the rendered set changes (row heights are uniform,
    // but a theme or font change can alter the pitch).
    void visible.length;
    measureRowPitch();
  });

  function handleFolderClick(node: FolderNode): void {
    toggleFolderOpen(node.path);
  }

  function handleNoteContextMenu(e: MouseEvent, id: string): void {
    e.preventDefault();
    onnotecontextmenu?.(id, e.clientX, e.clientY);
  }

  function handleFolderContextMenu(e: MouseEvent, path: string): void {
    e.preventDefault();
    onfoldercontextmenu?.(path, e.clientX, e.clientY);
  }

  function handleNoteClick(id: string, event?: MouseEvent): void {
    onselect?.(id, event);
  }

  onDestroy(() => {
    clearTimeout(settleTimer);
    drag.destroy();
  });
</script>

<!-- The scroll container is the root drop target during a drag. The
     a11y_no_static_element_interactions rule fires because <div> has
     drag handlers — the desktop HTML5 drag has no keyboard-only
     equivalent applicable to this element. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={scroller}
  class="folder-tree-scroll"
  class:root-drop-target={drag.dropTarget === ''}
  onscroll={handleScroll}
  ondragover={drag.handleRootDragOver}
  ondragleave={drag.handleRootDragLeave}
  ondrop={(event) => drag.handleRowDrop(event, '')}
>
  {#if flat.length === 0}
    <div class="empty-state">No notes yet. Tap + to create one.</div>
  {:else}
    {#if window_.padTop > 0}
      <div class="tree-spacer" style:height={`${window_.padTop}px`} aria-hidden="true"></div>
    {/if}
    {#each visible as node (node.type === 'folder' ? `f:${node.path}` : node.type === 'empty' ? `e:${node.parentPath}` : `n:${node.note.id}`)}
      {#if node.type === 'folder'}
        <FolderTreeFolderRow
          {node}
          indentPixels={DEPTH_INDENT_PX}
          isOpen={isFolderOpen(node.path)}
          isDropTarget={drag.dropTarget === node.path}
          {renameRequest}
          onclick={() => handleFolderClick(node)}
          oncontextmenu={(event) => handleFolderContextMenu(event, node.path)}
          onrename={onrenamefolder}
          ondragstart={(event) => drag.handleFolderDragStart(event, node.path)}
          ondragend={drag.handleDragEnd}
          ondragover={(event) => drag.handleFolderDragOver(event, node.path)}
          ondragleave={drag.clearHoverTimer}
          ondrop={(event) => drag.handleRowDrop(event, node.path)}
        />
      {:else if node.type === 'empty'}
        <FolderTreeEmptyRow
          {node}
          indentPixels={DEPTH_INDENT_PX}
          ondragover={(event) => drag.handleNoteDragOver(event, node.parentPath)}
          ondrop={(event) => drag.handleRowDrop(event, node.parentPath)}
        />
      {:else}
        <FolderTreeNoteRow
          {node}
          indentPixels={DEPTH_INDENT_PX}
          selected={node.note.id === selectedId}
          renameRequest={noteRenameRequest}
          onselect={(event) => handleNoteClick(node.note.id, event)}
          oncontextmenu={(event) => handleNoteContextMenu(event, node.note.id)}
          onrename={onrenamenote}
          ondragstart={(event) => drag.handleNoteDragStart(event, node.note.id)}
          ondragend={drag.handleDragEnd}
          ondragover={(event) => drag.handleNoteDragOver(event, node.parentPath)}
          ondrop={(event) => drag.handleRowDrop(event, node.parentPath)}
        />
      {/if}
    {/each}
    {#if window_.padBottom > 0}
      <div class="tree-spacer" style:height={`${window_.padBottom}px`} aria-hidden="true"></div>
    {/if}
  {/if}
</div>

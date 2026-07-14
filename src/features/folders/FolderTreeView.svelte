<script lang="ts">
  import './folderTree.css';

  import { onDestroy } from 'svelte';
  import type { NotePreview } from '$shared/types/note';
  import { isFolderOpen, toggleFolderOpen } from './folderExpansion.svelte';
  import { buildFolderTree, flattenFolderTree, type FolderNode } from './folderTree';
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
    renameRequest?: { path: string; nonce: number } | null;
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
    renameRequest = null,
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

  const ROW_HEIGHT = 50;
  const ROW_BUFFER = 6;
  const DEPTH_INDENT_PX = 16;
  let scrollTop = $state(0);
  let containerHeight = $state(0);
  let containerEl: HTMLDivElement | undefined = $state();
  const visibleRange = $derived.by(() => {
    if (containerHeight === 0) {
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

  onDestroy(drag.destroy);
</script>

<!-- The scroll container is the root drop target during a drag. The
     a11y_no_static_element_interactions rule fires because <div> has
     drag handlers — the desktop HTML5 drag has no keyboard-only
     equivalent applicable to this element. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={containerEl}
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
    <div class="virtual-spacer" style="height: {flat.length * ROW_HEIGHT}px;">
      {#each visibleNodes as { node, index } (node.type === 'folder' ? `f:${node.path}` : node.type === 'empty' ? `e:${node.parentPath}` : `n:${node.note.id}`)}
        {#if node.type === 'folder'}
          <FolderTreeFolderRow
            {node}
            {index}
            rowHeight={ROW_HEIGHT}
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
            {index}
            rowHeight={ROW_HEIGHT}
            indentPixels={DEPTH_INDENT_PX}
            ondragover={(event) => drag.handleNoteDragOver(event, node.parentPath)}
            ondrop={(event) => drag.handleRowDrop(event, node.parentPath)}
          />
        {:else}
          <FolderTreeNoteRow
            {node}
            {index}
            rowHeight={ROW_HEIGHT}
            indentPixels={DEPTH_INDENT_PX}
            selected={node.note.id === selectedId}
            onselect={(event) => handleNoteClick(node.note.id, event)}
            oncontextmenu={(event) => handleNoteContextMenu(event, node.note.id)}
            ondragstart={(event) => drag.handleNoteDragStart(event, node.note.id)}
            ondragend={drag.handleDragEnd}
            ondragover={(event) => drag.handleNoteDragOver(event, node.parentPath)}
            ondrop={(event) => drag.handleRowDrop(event, node.parentPath)}
          />
        {/if}
      {/each}
    </div>
  {/if}
</div>

<script lang="ts">
  import type { NotePreview } from '$shared/types/note';
  import CreateFolderModal from '$features/folders/CreateFolderModal.svelte';
  import FolderPickerModal from '$features/folders/FolderPickerModal.svelte';
  import FolderTreeView from '$features/folders/FolderTreeView.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import SidebarCreateActions from './components/SidebarCreateActions.svelte';
  import SidebarHeader from './components/SidebarHeader.svelte';
  import SidebarViewSelector, { type SidebarView } from './components/SidebarViewSelector.svelte';
  import SidebarImageView from './SidebarImageView.svelte';
  import SidebarTagView from './SidebarTagView.svelte';
  import { createSidebarFolderWorkflows } from './createSidebarFolderWorkflows.svelte';

  interface Props {
    notes: NotePreview[];
    activeNoteId: string | null;
    view: SidebarView;
    showCollapse: boolean;
    showResize: boolean;
    onselectview: (view: SidebarView) => void;
    onselectnote: (id: string, event?: MouseEvent) => void;
    onrunwithactivenotelock: <T>(operation: () => Promise<T>) => Promise<T>;
    onnoteidsrenamed: (renames: Array<{ from: string; to: string }>) => void;
    onnoteidsdeleted: (ids: string[]) => void;
    onactivenotedeleted: () => void;
    onactivenotemoved: (fromId: string, toId: string, title: string) => void;
    onnewnote: () => void;
    onnewnoteinfolder: (folder: string) => void;
    onhome: () => void;
    onsettings: () => void;
    oncollapse: () => void;
    onopensearch: () => void;
    onresize: (width: number) => void;
    onresizeend: (width: number) => void;
  }

  let {
    notes,
    activeNoteId,
    view,
    showCollapse,
    showResize,
    onselectview,
    onselectnote,
    onrunwithactivenotelock,
    onnoteidsrenamed,
    onnoteidsdeleted,
    onactivenotedeleted,
    onactivenotemoved,
    onnewnote,
    onnewnoteinfolder,
    onhome,
    onsettings,
    oncollapse,
    onopensearch,
    onresize,
    onresizeend,
  }: Props = $props();

  const workflows = createSidebarFolderWorkflows({
    getActiveNoteId: () => activeNoteId,
    runWithActiveNoteLock: (operation) => onrunwithactivenotelock(operation),
    onNoteIdsRenamed: (renames) => onnoteidsrenamed(renames),
    onNoteIdsDeleted: (ids) => onnoteidsdeleted(ids),
    onSelect: (id) => onselectnote(id),
    onActiveNoteDeleted: () => onactivenotedeleted(),
    onActiveNoteMoved: (fromId, toId, title) => onactivenotemoved(fromId, toId, title),
    onNewNoteInFolder: (folder) => onnewnoteinfolder(folder),
  });

  let asideEl: HTMLElement | undefined = $state();
  let resizing = false;
  let resizeWidth = 0;

  function startResize(event: PointerEvent): void {
    event.preventDefault();
    resizing = true;
    resizeWidth = asideEl?.getBoundingClientRect().width ?? 0;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
  }

  function moveResize(event: PointerEvent): void {
    if (!resizing || !asideEl) return;
    const width = event.clientX - asideEl.getBoundingClientRect().left;
    resizeWidth = width;
    onresize(width);
  }

  function endResize(event: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    onresizeend(resizeWidth);
  }
</script>

<aside class="notes-drawer" bind:this={asideEl}>
  <SidebarHeader {showCollapse} {oncollapse} {onhome} {onsettings} />

  <div class="drawer-search-area">
    <button class="search-button" onclick={onopensearch}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      Search
    </button>
  </div>

  <SidebarViewSelector selected={view} onselect={onselectview} />
  <SidebarCreateActions
    onclicknewnote={onnewnote}
    onclicknewfolder={() => workflows.openCreateFolder('')}
  />

  {#if view === 'notes'}
    <FolderTreeView
      items={notes}
      selectedId={activeNoteId}
      onselect={onselectnote}
      onfoldercontextmenu={workflows.showFolderContextMenu}
      onnotecontextmenu={workflows.showNoteContextMenu}
      onrenamefolder={workflows.renameFolder}
      renameRequest={workflows.renameRequest}
      ondropnoteonfolder={workflows.moveNoteToFolder}
      ondropfolderonfolder={workflows.moveFolder}
      ondropnoteonroot={workflows.moveNoteToRoot}
      ondropfolderonroot={workflows.moveFolderToRoot}
    />
  {:else if view === 'tags'}
    <SidebarTagView {notes} selectedId={activeNoteId} onselect={onselectnote} />
  {:else}
    <SidebarImageView />
  {/if}

  {#if showResize}
    <div
      class="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onpointerdown={startResize}
      onpointermove={moveResize}
      onpointerup={endResize}
      onpointercancel={endResize}
    ></div>
  {/if}
</aside>

{#if workflows.isCreateFolderOpen}
  <CreateFolderModal
    title={workflows.createFolderParent
      ? `New folder in "${workflows.createFolderParent}"`
      : 'New folder'}
    onsubmit={workflows.submitCreateFolder}
    validate={workflows.validateCreateFolder}
    oncancel={workflows.closeCreateFolder}
  />
{/if}

{#if workflows.contextMenu}
  <ContextMenu
    x={workflows.contextMenu.x}
    y={workflows.contextMenu.y}
    items={workflows.contextMenu.items}
    onclose={workflows.closeContextMenu}
  />
{/if}

{#if workflows.folderPicker}
  <FolderPickerModal
    title={workflows.folderPicker.title}
    {notes}
    excludePaths={workflows.folderPicker.excludePaths}
    onpick={workflows.folderPicker.onpick}
    oncancel={workflows.closeFolderPicker}
  />
{/if}

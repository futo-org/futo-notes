<script lang="ts">
  import type { NotePreview } from '$shared/types/note';
  import { isDesktop } from '$lib/platform';
  import FolderTreeView from '$features/folders/FolderTreeView.svelte';
  import SidebarTagView from './SidebarTagView.svelte';
  import SidebarImageView from './SidebarImageView.svelte';
  import CreateFolderModal from '$features/folders/CreateFolderModal.svelte';
  import FolderPickerModal from '$features/folders/FolderPickerModal.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import SidebarCreateActions from './components/SidebarCreateActions.svelte';
  import SidebarHeader from './components/SidebarHeader.svelte';
  import SidebarViewSelector, { type SidebarView } from './components/SidebarViewSelector.svelte';
  import { createSidebarFolderWorkflows } from './createSidebarFolderWorkflows.svelte';

  interface Props {
    notes: NotePreview[];
    activeNoteId: string | null;
    drawerOpen: boolean;
    sidebarWidth: number;
    onselect: (id: string, event?: MouseEvent) => void;
    onsearch: () => void;
    onsettings: () => void;
    onnewnote: () => void;
    onnewnoteinfolder?: (folderPath: string) => void;
    oncreatetestnote: () => void;
    ontogglecollapse: (collapsed?: boolean) => void;
    drawerEl?: HTMLElement | undefined;
    sidebarResizing?: boolean;
  }

  let {
    notes,
    activeNoteId,
    drawerOpen,
    sidebarWidth = $bindable(280),
    onselect,
    onsearch,
    onsettings,
    onnewnote,
    onnewnoteinfolder,
    oncreatetestnote,
    ontogglecollapse,
    drawerEl = $bindable(undefined),
    sidebarResizing = $bindable(false),
  }: Props = $props();

  const folders = createSidebarFolderWorkflows({
    getActiveNoteId: () => activeNoteId,
    onSelect: (id) => onselect(id),
    onNewNoteInFolder: (path) => onnewnoteinfolder?.(path),
  });

  let sidebarView: SidebarView = $state(
    (typeof localStorage !== 'undefined' &&
      (localStorage.getItem('futo-notes:sidebarView') as 'notes' | 'tags' | 'images')) ||
      'notes',
  );

  function handleBrandClick(): void {
    onselect('__home__');
  }

  function selectSidebarView(view: SidebarView): void {
    sidebarView = view;
    localStorage.setItem('futo-notes:sidebarView', view);
  }

  let fabPressTimer: number | null = null;
  let ignoreFabClick = false;

  function handleFabTouchStart(): void {
    fabPressTimer = window.setTimeout(() => {
      oncreatetestnote();
      fabPressTimer = null;
    }, 500);
  }

  function handleFabTouchEnd(): void {
    ignoreFabClick = true;
    window.setTimeout(() => {
      ignoreFabClick = false;
    }, 350);
    if (fabPressTimer !== null) {
      clearTimeout(fabPressTimer);
      fabPressTimer = null;
      onnewnote();
    }
  }

  function handleFabTouchCancel(): void {
    ignoreFabClick = true;
    window.setTimeout(() => {
      ignoreFabClick = false;
    }, 350);
    if (fabPressTimer !== null) {
      clearTimeout(fabPressTimer);
      fabPressTimer = null;
    }
  }

  function handleFabClick(): void {
    if (ignoreFabClick) return;
    if (fabPressTimer !== null) return;
    onnewnote();
  }

  let resizeStartX = 0;
  let resizeStartWidth = 0;

  function handleResizeStart(e: PointerEvent): void {
    e.preventDefault();
    sidebarResizing = true;
    resizeStartX = e.clientX;
    resizeStartWidth = sidebarWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleResizeMove(e: PointerEvent): void {
    if (!sidebarResizing) return;
    sidebarWidth = Math.max(200, Math.min(600, resizeStartWidth + (e.clientX - resizeStartX)));
  }

  function handleResizeEnd(): void {
    if (!sidebarResizing) return;
    sidebarResizing = false;
    persistSidebarWidth(sidebarWidth);
  }

  function persistSidebarWidth(width: number): void {
    if (isDesktop) {
      import('$lib/platform/tauri').then(({ saveConfig }) => {
        saveConfig({ sidebarWidth: width }).catch((err) => {
          console.warn('Failed to persist sidebar width:', err);
        });
      });
    } else {
      localStorage.setItem('futo-notes:sidebarWidth', String(width));
    }
  }
</script>

<aside bind:this={drawerEl} class="notes-drawer" aria-hidden={!drawerOpen}>
  <SidebarHeader
    onhome={handleBrandClick}
    {onsettings}
    oncollapse={() => ontogglecollapse(true)}
    showCollapse={!isDesktop}
  />
  <div class="drawer-search-area">
    <button class="search-button" onclick={onsearch}>
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      Search
    </button>
  </div>
  <SidebarViewSelector selected={sidebarView} onselect={selectSidebarView} />
  {#if sidebarView === 'tags'}
    <SidebarTagView {notes} selectedId={activeNoteId !== 'new' ? activeNoteId : null} {onselect} />
  {:else if sidebarView === 'images'}
    <SidebarImageView />
  {:else}
    <FolderTreeView
      items={notes}
      selectedId={activeNoteId !== 'new' ? activeNoteId : null}
      {onselect}
      onfoldercontextmenu={folders.showFolderContextMenu}
      onnotecontextmenu={folders.showNoteContextMenu}
      onrenamefolder={folders.renameFolder}
      renameRequest={folders.renameRequest}
      ondropnoteonfolder={folders.moveNoteToFolder}
      ondropfolderonfolder={folders.moveFolder}
      ondropnoteonroot={folders.moveNoteToRoot}
      ondropfolderonroot={folders.moveFolderToRoot}
    />
  {/if}
  <SidebarCreateActions
    onclicknewnote={handleFabClick}
    onclicknewfolder={() => folders.openCreateFolder('')}
    ontouchstart={handleFabTouchStart}
    ontouchend={handleFabTouchEnd}
    ontouchcancel={handleFabTouchCancel}
  />
  {#if folders.isCreateFolderOpen}
    <CreateFolderModal
      title={folders.createFolderParent
        ? `New folder in "${folders.createFolderParent}"`
        : 'New folder'}
      validate={folders.validateCreateFolder}
      onsubmit={folders.submitCreateFolder}
      oncancel={folders.closeCreateFolder}
    />
  {/if}
  {#if folders.folderPicker}
    <FolderPickerModal
      title={folders.folderPicker.title}
      {notes}
      excludePaths={folders.folderPicker.excludePaths}
      onpick={folders.folderPicker.onpick}
      oncancel={folders.closeFolderPicker}
    />
  {/if}
  {#if folders.contextMenu}
    <ContextMenu
      x={folders.contextMenu.x}
      y={folders.contextMenu.y}
      items={folders.contextMenu.items}
      onclose={folders.closeContextMenu}
    />
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="sidebar-resize-handle"
    onpointerdown={handleResizeStart}
    onpointermove={handleResizeMove}
    onpointerup={handleResizeEnd}
    onpointercancel={handleResizeEnd}
  ></div>
</aside>

<style>
  /* The "+" New note button and the new-folder button share the same row at
     the bottom of the sidebar. The folder button uses a neutral light-gray
     background with a dark-gray folder-plus icon (per spec § UI/Add-folder
     button). It sits to the right of the New button at the same height. */
  :global(.notes-drawer .fab-row) {
    position: absolute;
    bottom: max(16px, calc(16px + env(safe-area-inset-bottom)));
    right: max(16px, calc(16px + env(safe-area-inset-right)));
    display: flex;
    align-items: center;
    gap: 10px;
    z-index: 100;
  }
  :global(.notes-drawer .fab-row > .fab) {
    position: static;
    bottom: auto;
    right: auto;
  }
  :global(.notes-drawer .fab-row > .fab.fab-folder) {
    width: 48px;
    padding: 0;
    background: var(--color-surface, rgba(0, 0, 0, 0.06));
    color: var(--color-muted, #555);
    box-shadow:
      0 1px 4px rgba(0, 0, 0, 0.1),
      0 0 0 1px var(--color-border, rgba(0, 0, 0, 0.08));
  }
  :global(.notes-drawer .fab-row > .fab.fab-folder:active) {
    transform: scale(0.96);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  }
  :global(.notes-shell.desktop-layout .notes-drawer .fab-row) {
    bottom: 16px;
    right: 16px;
  }
</style>

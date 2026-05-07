<script lang="ts">
  import { getContext } from 'svelte';
  import { APP_CONTEXT_KEY, type AppContext } from '$lib/appContext.svelte';
  import { isMobile, isDesktop } from '$lib/platform';
  import FolderTreeView from './FolderTreeView.svelte';
  import SidebarTagView from './SidebarTagView.svelte';
  import SidebarImageView from './SidebarImageView.svelte';
  import CreateFolderModal from './CreateFolderModal.svelte';
  import FolderPickerModal from './FolderPickerModal.svelte';
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte';
  import {
    createFolder,
    deleteFolder,
    renameOrMoveFolder,
    clearDragHoverExpanded,
    refreshEmptyFolders,
    getEmptyFolders,
  } from '$lib/folders.svelte';
  import { moveNote, moveNotesUnderPrefix, deleteNote, getAllNotes } from '$lib/notes.svelte';
  import { idLeaf } from '$lib/platform/pathSafety';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { showGlobalToast as showToast } from '$lib/toast';

  const appCtx = getContext<AppContext>(APP_CONTEXT_KEY);

  interface Props {
    drawerOpen: boolean;
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    isDragging: boolean;
    onselect: (id: string) => void;
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
    drawerOpen,
    sidebarCollapsed,
    sidebarWidth = $bindable(280),
    isDragging,
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

  // ── Folder UI state ──────────────────────────────────────────────────

  let showCreateFolder = $state(false);
  let createFolderParent = $state(''); // '' = root
  let renameModal = $state<{ path: string; name: string } | null>(null);
  let folderPicker = $state<{
    title: string;
    onpick: (target: string) => void;
    excludePaths: string[];
  } | null>(null);
  let contextMenu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function openCreateFolder(parent: string): void {
    createFolderParent = parent;
    showCreateFolder = true;
  }

  async function handleCreateFolderSubmit(name: string): Promise<string | null> {
    const trimmed = name.trim();
    const siblings = collectSiblings(createFolderParent);
    const result = await createFolder(createFolderParent, trimmed, siblings);
    if (!result.ok) return result.error ?? 'Failed to create folder';
    showCreateFolder = false;
    await refreshEmptyFolders(getAllNotes());
    return null;
  }

  function collectSiblings(parentPath: string): string[] {
    const result = new Set<string>();
    const prefix = parentPath ? `${parentPath}/` : '';
    // Include sibling folders implied by note paths (e.g. parent/Foo/note.md
    // proves "Foo" is a sibling under parent).
    for (const note of getAllNotes()) {
      if (parentPath && !note.id.startsWith(prefix)) continue;
      const rel = parentPath ? note.id.slice(prefix.length) : note.id;
      const slash = rel.indexOf('/');
      if (slash !== -1) {
        result.add(rel.slice(0, slash));
      }
    }
    // Include empty folders too — they're real on disk and must collide
    // case-insensitively with attempted siblings.
    for (const folder of getEmptyFolders()) {
      if (parentPath && !folder.startsWith(prefix)) {
        if (folder !== parentPath) continue;
      }
      const rel = parentPath ? folder.slice(prefix.length) : folder;
      if (!rel || rel.startsWith('/')) continue;
      const slash = rel.indexOf('/');
      const name = slash !== -1 ? rel.slice(0, slash) : rel;
      if (name) result.add(name);
    }
    return [...result];
  }

  function showFolderContextMenu(path: string, x: number, y: number): void {
    const items: MenuItem[] = [
      { label: 'New Note', onclick: () => onnewnoteinfolder?.(path) },
      {
        label: 'Rename',
        onclick: () => {
          renameModal = { path, name: idLeaf(path) };
        },
      },
    ];
    if (isMobile) {
      items.push({
        label: 'Move folder',
        onclick: () => openMoveFolderPicker(path),
      });
    }
    items.push({
      label: 'Delete',
      destructive: true,
      onclick: () => void confirmDeleteFolder(path),
    });
    contextMenu = { x, y, items };
  }

  function showNoteContextMenu(id: string, x: number, y: number): void {
    const items: MenuItem[] = [
      {
        label: 'Move to folder',
        onclick: () => openMoveNotePicker(id),
      },
      {
        label: 'Delete',
        destructive: true,
        onclick: () => void confirmDeleteNote(id),
      },
    ];
    contextMenu = { x, y, items };
  }

  async function handleRenameFolder(newName: string): Promise<string | null> {
    if (!renameModal) return 'No folder selected';
    const trimmed = newName.trim();
    const components = renameModal.path.split('/');
    const parent = components.slice(0, -1).join('/');
    const newPath = parent ? `${parent}/${trimmed}` : trimmed;
    if (newPath === renameModal.path) {
      renameModal = null;
      return null;
    }
    const siblings = collectSiblings(parent).filter((s) => s !== components[components.length - 1]);
    const result = await renameOrMoveFolder(renameModal.path, newPath, siblings);
    if (!result.ok) return result.error ?? 'Failed to rename';
    // Wikilinks in every contained note rewrite themselves via the
    // moveNote → updateNote → rewriteWikilinksForRename path during
    // the bulk move.
    await moveNotesUnderPrefix(renameModal.path, newPath);
    renameModal = null;
    await refreshEmptyFolders(getAllNotes());
    return null;
  }

  function openMoveFolderPicker(path: string): void {
    folderPicker = {
      title: 'Move folder',
      excludePaths: [path],
      onpick: async (target: string) => {
        const tail = idLeaf(path);
        const newPath = target ? `${target}/${tail}` : tail;
        if (newPath === path) {
          folderPicker = null;
          return;
        }
        const siblings = collectSiblings(target);
        const result = await renameOrMoveFolder(path, newPath, siblings);
        if (!result.ok) {
          showToast(result.error ?? 'Failed to move folder');
          folderPicker = null;
          return;
        }
        await moveNotesUnderPrefix(path, newPath);
        await refreshEmptyFolders(getAllNotes());
        folderPicker = null;
        showToast(target ? `Moved to ${target}` : 'Moved to Notes');
      },
    };
  }

  function openMoveNotePicker(noteId: string): void {
    folderPicker = {
      title: 'Move to folder',
      excludePaths: [],
      onpick: async (target: string) => {
        const components = noteId.split('/');
        const leaf = components[components.length - 1];
        const newId = target ? `${target}/${leaf}` : leaf;
        if (newId === noteId) {
          folderPicker = null;
          return;
        }
        try {
          await moveNote(noteId, newId);
          await refreshEmptyFolders(getAllNotes());
          showToast(target ? `Moved to ${target}` : 'Moved to Notes');
        } catch (err) {
          showToast((err as Error).message ?? 'Move failed');
        }
        folderPicker = null;
      },
    };
  }

  async function confirmDeleteFolder(path: string): Promise<void> {
    let confirmed = false;
    try {
      confirmed = await ask(
        'Are you sure you want to delete this folder? Deleting this folder will erase the folder and all of its contents.',
        { title: 'Delete folder', kind: 'warning' },
      );
    } catch {
      // Fallback to window.confirm in non-Tauri/test environments
      confirmed = typeof window !== 'undefined' && window.confirm
        ? window.confirm(`Delete folder "${path}" and all of its contents?`)
        : true;
    }
    if (!confirmed) return;
    // Delete every contained note (in parallel — IPC-bound) so they sync
    // as individual deletions; then trash the folder itself. Aggregate
    // failures so the user knows if some notes couldn't be deleted.
    const noteIds = getAllNotes()
      .filter((n) => n.id === path || n.id.startsWith(`${path}/`))
      .map((n) => n.id);
    const results = await Promise.all(
      noteIds.map((id) => deleteNote(id).then(() => true, () => false)),
    );
    const failed = results.filter((ok) => !ok).length;
    const folderResult = await deleteFolder(path);
    if (!folderResult.ok) {
      showToast(folderResult.error ?? 'Failed to delete folder');
      return;
    }
    await refreshEmptyFolders(getAllNotes());
    showToast(failed > 0 ? `Folder deleted (${failed} note${failed > 1 ? 's' : ''} failed)` : 'Folder deleted');
  }

  async function confirmDeleteNote(id: string): Promise<void> {
    let confirmed = false;
    try {
      confirmed = await ask(`Delete note "${idLeaf(id)}"?`, {
        title: 'Delete note',
        kind: 'warning',
      });
    } catch {
      confirmed = typeof window !== 'undefined' && window.confirm
        ? window.confirm(`Delete note "${id}"?`)
        : true;
    }
    if (!confirmed) return;
    try {
      await deleteNote(id);
      showToast('Note deleted');
    } catch (err) {
      showToast((err as Error).message ?? 'Delete failed');
    }
  }

  async function handleDropNoteOnFolder(noteId: string, folderPath: string): Promise<void> {
    const newId = `${folderPath}/${idLeaf(noteId)}`;
    if (newId === noteId) return;
    try {
      await moveNote(noteId, newId);
      // Empty-folder reconcile doesn't gate the visible move — fire and
      // forget so the toast/animation don't wait on a full listFolders IPC.
      void refreshEmptyFolders(getAllNotes());
      showToast(`Moved to ${folderPath}`);
    } catch (err) {
      showToast((err as Error).message ?? 'Move failed');
    } finally {
      clearDragHoverExpanded();
    }
  }

  async function handleDropNoteOnRoot(noteId: string): Promise<void> {
    const leaf = idLeaf(noteId);
    if (noteId === leaf) return;
    try {
      await moveNote(noteId, leaf);
      void refreshEmptyFolders(getAllNotes());
      showToast('Moved to Notes');
    } catch (err) {
      showToast((err as Error).message ?? 'Move failed');
    } finally {
      clearDragHoverExpanded();
    }
  }

  async function handleDropFolderOnFolder(
    folderPath: string,
    targetPath: string,
  ): Promise<void> {
    if (folderPath === targetPath) return;
    if (targetPath.startsWith(`${folderPath}/`)) return;
    const newPath = `${targetPath}/${idLeaf(folderPath)}`;
    const siblings = collectSiblings(targetPath);
    const result = await renameOrMoveFolder(folderPath, newPath, siblings);
    if (!result.ok) {
      showToast(result.error ?? 'Failed to move folder');
      return;
    }
    await moveNotesUnderPrefix(folderPath, newPath);
    await refreshEmptyFolders(getAllNotes());
    showToast(`Moved to ${targetPath}`);
    clearDragHoverExpanded();
  }

  async function handleDropFolderOnRoot(folderPath: string): Promise<void> {
    const leaf = idLeaf(folderPath);
    if (folderPath === leaf) return;
    const siblings = collectSiblings('');
    const result = await renameOrMoveFolder(folderPath, leaf, siblings);
    if (!result.ok) {
      showToast(result.error ?? 'Failed to move folder');
      return;
    }
    await moveNotesUnderPrefix(folderPath, leaf);
    await refreshEmptyFolders(getAllNotes());
    showToast('Moved to Notes');
    clearDragHoverExpanded();
  }

  let sidebarView: 'notes' | 'tags' | 'images' = $state(
    (typeof localStorage !== 'undefined' && localStorage.getItem('futo-notes:sidebarView') as 'notes' | 'tags' | 'images') || 'notes'
  );

  function handleBrandClick(): void {
    onselect('__home__');
  }

  // FAB long-press
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

  // Sidebar resize
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
    sidebarWidth = Math.max(180, Math.min(600, resizeStartWidth + (e.clientX - resizeStartX)));
  }

  function handleResizeEnd(): void {
    if (!sidebarResizing) return;
    sidebarResizing = false;
    persistSidebarWidth(sidebarWidth);
  }

  function persistSidebarWidth(width: number): void {
    if (isDesktop) {
      import('$lib/platform/tauri').then(({ saveConfig }) => {
        saveConfig({ sidebarWidth: width });
      });
    } else {
      localStorage.setItem('futo-notes:sidebarWidth', String(width));
    }
  }
</script>

<aside bind:this={drawerEl} class="notes-drawer" aria-hidden={!drawerOpen}>
  <div class="sidebar-header">
    <div class="sidebar-brand">
      <button class="brand-text" onclick={handleBrandClick}>FUTO Notes{#if import.meta.env.DEV}<span class="dev-badge">DEV</span>{/if}</button>
    </div>
    <div class="sidebar-header-actions">
      <button
        class="sidebar-settings-btn"
        aria-label="Settings"
        onclick={onsettings}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      {#if !isMobile}
        <button class="sidebar-collapse-btn" aria-label="Collapse sidebar"
          onclick={() => { ontogglecollapse(true); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
            <polyline points="15 8 12 12 15 16"/>
          </svg>
        </button>
      {/if}
    </div>
  </div>
  <div class="drawer-search-area">
    <button class="search-button" onclick={onsearch}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Search
    </button>
  </div>
  <div class="sidebar-view-toggle">
    <button class:active={sidebarView === 'notes'} aria-label="Notes view" onclick={() => { sidebarView = 'notes'; localStorage.setItem('futo-notes:sidebarView', 'notes'); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>
      </svg>
    </button>
    <button class:active={sidebarView === 'tags'} aria-label="Tags view" onclick={() => { sidebarView = 'tags'; localStorage.setItem('futo-notes:sidebarView', 'tags'); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>
      </svg>
    </button>
    <button class:active={sidebarView === 'images'} aria-label="Images view" onclick={() => { sidebarView = 'images'; localStorage.setItem('futo-notes:sidebarView', 'images'); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
      </svg>
    </button>
  </div>
  {#if sidebarView === 'tags'}
    <SidebarTagView
      notes={appCtx.notes}
      selectedId={appCtx.activeNoteId !== 'new' ? appCtx.activeNoteId : null}
      onselect={onselect}
    />
  {:else if sidebarView === 'images'}
    <SidebarImageView />
  {:else}
    <FolderTreeView
      items={appCtx.notes}
      selectedId={appCtx.activeNoteId !== 'new' ? appCtx.activeNoteId : null}
      onselect={onselect}
      {isDragging}
      onfoldercontextmenu={showFolderContextMenu}
      onnotecontextmenu={showNoteContextMenu}
      ondropnoteonfolder={handleDropNoteOnFolder}
      ondropfolderonfolder={handleDropFolderOnFolder}
      ondropnoteonroot={handleDropNoteOnRoot}
      ondropfolderonroot={handleDropFolderOnRoot}
    />
  {/if}
  <div class="fab-row">
    <button
      class="fab"
      aria-label="New note"
      ontouchstart={handleFabTouchStart}
      ontouchend={handleFabTouchEnd}
      ontouchcancel={handleFabTouchCancel}
      onclick={handleFabClick}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      New
    </button>
    <button
      class="fab fab-folder"
      aria-label="New folder"
      data-testid="new-folder-btn"
      onclick={() => openCreateFolder('')}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
        <line x1="12" y1="11" x2="12" y2="17"/>
        <line x1="9" y1="14" x2="15" y2="14"/>
      </svg>
    </button>
  </div>
  {#if showCreateFolder}
    <CreateFolderModal
      title={createFolderParent ? `New folder in "${createFolderParent}"` : 'New folder'}
      onsubmit={handleCreateFolderSubmit}
      oncancel={() => (showCreateFolder = false)}
    />
  {/if}
  {#if renameModal}
    <CreateFolderModal
      title="Rename folder"
      confirmLabel="Rename"
      initialValue={renameModal.name}
      onsubmit={handleRenameFolder}
      oncancel={() => (renameModal = null)}
    />
  {/if}
  {#if folderPicker}
    <FolderPickerModal
      title={folderPicker.title}
      notes={appCtx.notes}
      excludePaths={folderPicker.excludePaths}
      onpick={folderPicker.onpick}
      oncancel={() => (folderPicker = null)}
    />
  {/if}
  {#if contextMenu}
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      items={contextMenu.items}
      onclose={() => (contextMenu = null)}
    />
  {/if}
  {#if !isMobile}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sidebar-resize-handle"
      onpointerdown={handleResizeStart}
      onpointermove={handleResizeMove}
      onpointerup={handleResizeEnd}
      onpointercancel={handleResizeEnd}
    ></div>
  {/if}
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
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1), 0 0 0 1px var(--color-border, rgba(0, 0, 0, 0.08));
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

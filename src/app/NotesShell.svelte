<script lang="ts">
  import { hasFileSystem, isDesktop, isTauri } from '$lib/platform';
  import MarkdownEditor from '$features/editor/MarkdownEditor.svelte';
  import type SettingsScreenComponent from '$features/settings/SettingsScreen.svelte';
  import type SearchPopupComponent from '$features/search/SearchPopup.svelte';
  let SettingsScreen: typeof SettingsScreenComponent | null = $state(null);
  let SearchPopup: typeof SearchPopupComponent | null = $state(null);
  import { getAllNotes, createNote } from '$features/notes/notes.svelte';
  import { sanitizeFilename } from '$lib/rules';
  import { createNoteSession } from '$features/notes/noteSession.svelte';
  import SyncStatusBar from '$features/sync/SyncStatusBar.svelte';
  import GraphSidebarPanel from '$features/graph/GraphSidebarPanel.svelte';
  import FolderPickerModal from '$features/folders/FolderPickerModal.svelte';
  import DrawerSidebar from '$features/sidebar/DrawerSidebar.svelte';
  import DesktopTopBand from './components/DesktopTopBand.svelte';
  import DeleteNoteDialog from './components/DeleteNoteDialog.svelte';
  import NoteActionsMenu from './components/NoteActionsMenu.svelte';
  import { createSyncManager } from '$features/sync/syncManager.svelte';
  import { keyboard } from '$features/editor/keyboard.svelte';
  import { navigate, noteIdFromHash } from './router';
  import { tabsStore, type OpenMode } from '$features/tabs/tabsStore.svelte';
  import { onToast } from '$shared/notifications/toastBus';
  import { startNativeShell } from './startNativeShell';
  import { startTabsPersistence } from './startTabsPersistence';
  import { registerNotesShellShortcuts } from './registerNotesShellShortcuts';
  import { installNotesShellTestHook } from './installNotesShellTestHook';
  import { createCurrentNoteActions } from './createCurrentNoteActions.svelte';
  import NoteWorkspace from './components/NoteWorkspace.svelte';
  import { createTabNoteTransition } from './createTabNoteTransition';

  interface Props {
    noteId: string | null;
  }

  let { noteId }: Props = $props();

  let drawerOpen = $state(true);
  let drawerProgress = $state(1);
  const notes = $derived(hasFileSystem ? getAllNotes() : []);

  let lastIdSignature = '';
  $effect(() => {
    const sig = notes
      .map((n) => n.id)
      .sort()
      .join('\n');
    if (sig === lastIdSignature) return;
    lastIdSignature = sig;
    graphPanel?.clearGraphData();
    editor?.refreshDecorations?.();
  });

  let editor: ReturnType<typeof MarkdownEditor> | null = $state(null);
  let graphPanel: ReturnType<typeof GraphSidebarPanel> | null = $state(null);
  let editorFocused = $state(false);
  let drawer: HTMLElement | undefined = $state(undefined);
  let noteBody: HTMLElement | undefined = $state(undefined);
  let titleTextarea: HTMLTextAreaElement | undefined = $state(undefined);

  let drawerWidth = $state(0);

  let sidebarWidth = $state(280);
  let sidebarCollapsed = $state(false);
  let sidebarResizing = $state(false);

  function toggleSidebar(collapsed?: boolean) {
    sidebarCollapsed = collapsed ?? !sidebarCollapsed;
    localStorage.setItem('futo-notes:sidebarCollapsed', String(sidebarCollapsed));
  }
  let graphSidebarWidth = $state(320);

  let settingsOpen = $state(false);

  let searchOpen = $state(false);

  async function openSearch(): Promise<void> {
    if (!SearchPopup) {
      SearchPopup = (await import('$features/search/SearchPopup.svelte')).default;
    }
    searchOpen = true;
  }

  function openFromEvent(id: string | null, event?: MouseEvent): OpenMode {
    const mode = isDesktop ? tabsStore.modeFromEvent(event) : 'current';
    tabsStore.openNote(id, mode);
    return mode;
  }

  function handleSearchSelect(id: string, event?: MouseEvent): void {
    const mode = openFromEvent(id, event);
    if (mode === 'current') searchOpen = false;
  }

  let graphSidebarOpen = $state(false);
  let graphPanelResizing = $state(false);

  const tabNoteTransition = createTabNoteTransition({
    getEditor: () => editor,
    getNoteBody: () => noteBody,
    getCurrentNoteId: () => noteId,
    loadNote: loadNoteAndResetUI,
  });

  const session = createNoteSession({
    getEditorContent: () => editor?.getContent(),
    setEditorContent: (text, opts) => editor?.setContent(text, opts),
    focusEditor: () => editor?.focus(),
    isEditorFocused: () => editor?.hasFocus?.() ?? false,
    isComposing: () => Boolean(editor?.isComposing?.()),
    getNotes: () => notes,
    patchGraphNode: (from, to, t) => graphPanel?.patchGraphNode(from, to, t),
    getNoteBody: () => noteBody,
    getTitleTextarea: () => titleTextarea,
    getNoteId: () => noteId,
    setPrevNoteId: tabNoteTransition.setPreviousNoteId,
    getPendingFolder: () => tabsStore.activeTab.pendingFolder ?? null,
    clearPendingFolder: () => {
      tabsStore.setPendingFolder(tabsStore.activeTabId, null);
    },
    onNoteRenamed: tabNoteTransition.handleNoteRenamed,
    navigate,
  });

  const sync = createSyncManager({
    session,
    showToast,
    onRename: (fromId, toId, title) => {
      tabsStore.applyRename(fromId, toId);
      graphPanel?.patchGraphNode(fromId, toId, title);
      if (noteId === fromId) {
        tabNoteTransition.setPreviousNoteId(toId);
        navigate(`/note/${encodeURIComponent(toId)}`);
      }
    },
    pruneTabsForDeletedIds: (goneIds) => {
      const gone = new Set(goneIds);
      tabsStore.pruneMissingNoteIds((id) => !gone.has(id));
    },
  });

  const noteActions = createCurrentNoteActions({
    getNoteId: () => noteId,
    getOriginalId: () => session.originalId,
    cancelSession: session.cancelAndClear,
    notifySaved: sync.notifySaved,
    showToast,
  });

  let toastMessage = $state('');
  let toastTimer: number | null = null;

  function showToast(message: string): void {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastMessage = message;
    toastTimer = window.setTimeout(() => {
      toastMessage = '';
      toastTimer = null;
    }, 3000);
  }

  const unsubToast = onToast(showToast);
  $effect(() => () => unsubToast());

  function updateDrawerMetrics(): void {
    if (drawer) {
      drawerWidth = drawer.getBoundingClientRect().width || 1;
    }
  }

  function editorIsComposing(): boolean {
    return editor?.isComposing?.() ?? false;
  }

  function setDrawerOpen(open: boolean): void {
    drawerOpen = open;
    if (open && !editorIsComposing()) {
      editor?.blur();
    }
    setDrawerProgress(open ? 1 : 0);
  }

  function setDrawerProgress(progress: number): void {
    drawerProgress = Math.min(1, Math.max(0, progress));
    if (drawerProgress > 0 && !editorIsComposing()) {
      editor?.blur();
    }
  }

  function handleNoteSelect(id: string, event?: MouseEvent): void {
    openFromEvent(id, event);
  }

  function handleDrawerSelect(id: string, event?: MouseEvent): void {
    if (id === '__home__') {
      openFromEvent(null, event);
    } else {
      handleNoteSelect(id, event);
    }
  }

  async function handleOpenSettings(): Promise<void> {
    if (!SettingsScreen) {
      SettingsScreen = (await import('$features/settings/SettingsScreen.svelte')).default;
    }
    settingsOpen = true;
  }

  async function createNewNote(): Promise<void> {
    await session.flushSave();
    tabsStore.openNote('new', 'current');
  }

  async function createNewNoteInFolder(folderPath: string): Promise<void> {
    await session.flushSave();
    const tab = tabsStore.openNote('new', 'current');
    tabsStore.setPendingFolder(tab.id, folderPath);
  }

  async function createTestNote(): Promise<void> {
    if (!hasFileSystem) return;
    const [{ GFM_TEST_CONTENT }, { SCROLL_TEST_NOTES }] = await Promise.all([
      import('$features/editor/gfmTestContent'),
      import('$features/editor/scrollTestNotes'),
    ]);
    await createNote(sanitizeFilename('Markdown test note'), GFM_TEST_CONTENT);
    for (const note of SCROLL_TEST_NOTES) {
      await createNote(sanitizeFilename(note.title), note.content);
    }
  }

  function handleEditorFocusChange(focused: boolean): void {
    if (focused) {
      if (noteId) editorFocused = true;
      void sync.handleEditorFocusChange(true);
      void session.flushSave();
    } else {
      editorFocused = false;
      void sync.handleEditorFocusChange(false);
    }
  }

  function handleNoteBodyFocusIn(event: FocusEvent): void {
    keyboard.refresh();
    const target = event.target as HTMLElement | null;
    if (target?.closest('.cm-editor') && noteId) {
      editorFocused = true;
    }
  }

  function openGraphSidebar(): void {
    graphPanel?.openGraph();
  }

  function closeGraphSidebar(): void {
    graphSidebarOpen = false;
  }

  function handleWikilinkOpen(title: string, event: MouseEvent): void {
    openFromEvent(title, event);
  }

  function registerBackSwipeHandler(): void {
    const win = window as typeof window & { __toggleNotesDrawer?: () => void };
    win.__toggleNotesDrawer = () => setDrawerOpen(!drawerOpen);
  }

  async function loadNoteAndResetUI(id: string | null): Promise<void> {
    noteActions.closeTransientUi();
    if (!id) editorFocused = false;
    await session.loadNote(id);
  }

  $effect(() => {
    keyboard.init();
    registerBackSwipeHandler();
    updateDrawerMetrics();

    const cleanupSync = sync.start();
    const cleanupTabs = startTabsPersistence({
      initialNoteId: noteIdFromHash(window.location.hash),
      setSidebarCollapsed: (collapsed) => {
        sidebarCollapsed = collapsed;
      },
      setSidebarWidth: (width) => {
        sidebarWidth = width;
      },
      setGraphSidebarWidth: (width) => {
        graphSidebarWidth = width;
      },
    });

    const cleanupNativeShell = startNativeShell({
      createNote: () => void createNewNote(),
      enqueueFileChange: sync.enqueueFileChange,
      flushSave: session.flushSave,
      toggleSidebar: () => toggleSidebar(),
    });

    const cleanupShortcuts = registerNotesShellShortcuts({
      openSearch: () => void openSearch(),
      createNote: () => void createNewNote(),
    });

    return () => {
      cleanupSync();
      cleanupTabs();
      cleanupNativeShell();
      void session.flushSave();
      cleanupShortcuts();
    };
  });
  $effect(() => {
    tabNoteTransition.update(noteId);
  });

  const drawerOffset = $derived(drawerProgress * drawerWidth);

  $effect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_INCLUDE_TEST_HOOKS === 'true')) return;
    return installNotesShellTestHook({
      handleSyncComplete: sync.handleSyncComplete,
      handleLiveState: sync.handleLiveState,
      handleFileChange: sync.handleFileChange,
      seedOpenNote: session.seedOpenNote,
      flushSave: session.flushSave,
      getEditorView: () => editor?.getView() ?? null,
      focusEditor: () => editor?.focus(),
      getState: () => ({
        originalId: session.originalId,
        title: session.title,
        toastMessage,
        hash: window.location.hash,
        editorContent: editor?.getContent() ?? '',
        savePending: session.savePending,
      }),
    });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="notes-shell desktop-layout"
  class:sidebar-collapsed={sidebarCollapsed}
  class:sidebar-resizing={sidebarResizing}
  class:graph-resizing={graphPanelResizing}
  class:drawer-open={drawerOpen}
  class:graph-sidebar-open={graphSidebarOpen}
  style="--drawer-offset: {drawerOffset}px; --sidebar-width: {sidebarWidth}px; --graph-sidebar-width: {graphSidebarWidth}px; --vv-offset: {keyboard.offsetTop}px"
>
  <!-- Full-width top band (desktop): traffic-light gutter + sidebar toggle +
       tabs. Owns the macOS window-button clearance so sidebar collapse can't
       affect it. -->
  {#if isDesktop}
    <DesktopTopBand
      {notes}
      {sidebarCollapsed}
      ontoggle={() => {
        toggleSidebar();
      }}
    />
  {/if}

  <div class="desktop-body">
    <!-- Drawer -->
    <DrawerSidebar
      {notes}
      activeNoteId={noteId}
      {drawerOpen}
      bind:sidebarWidth
      onselect={handleDrawerSelect}
      onsearch={() => {
        void openSearch();
      }}
      onsettings={handleOpenSettings}
      onnewnote={createNewNote}
      onnewnoteinfolder={createNewNoteInFolder}
      oncreatetestnote={createTestNote}
      ontogglecollapse={toggleSidebar}
      bind:drawerEl={drawer}
      bind:sidebarResizing
    />

    <!-- Main content -->
    <div class="note-main">
      {#if noteId}
        <NoteActionsMenu
          {noteId}
          bind:open={noteActions.menuOpen}
          showNativeActions={isTauri}
          ongraph={openGraphSidebar}
          oncopy={() => void noteActions.copyPath()}
          onmove={noteActions.openMovePicker}
          ondelete={noteActions.requestDelete}
        />
      {/if}
      {#if !isDesktop && sidebarCollapsed}
        <button
          class="sidebar-expand-fallback-btn"
          aria-label="Expand sidebar"
          onclick={() => {
            toggleSidebar(false);
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <polyline points="14 8 17 12 14 16" />
          </svg>
        </button>
      {/if}
      <NoteWorkspace
        {noteId}
        {notes}
        {session}
        {editorFocused}
        bind:editor
        bind:noteBody
        bind:titleTextarea
        oneditorfocuschange={handleEditorFocusChange}
        onbodyfocusin={handleNoteBodyFocusIn}
        onopenwikilink={handleWikilinkOpen}
        onnavigate={(id) => {
          openFromEvent(id);
        }}
      />
      <SyncStatusBar
        statusMessage={sync.syncStatusMessage}
        indicatorVisible={sync.syncIndicatorVisible}
        offline={sync.syncOffline}
        error={sync.syncError}
        errorMessage={sync.syncErrorMessage}
        connected={sync.live}
        onclear={sync.clearSyncError}
      />
    </div>

    <!-- Graph sidebar -->
    <GraphSidebarPanel
      bind:this={graphPanel}
      open={graphSidebarOpen}
      bind:graphSidebarWidth
      onclose={closeGraphSidebar}
      ontoast={showToast}
      bind:resizing={graphPanelResizing}
    />
  </div>
</div>

{#if settingsOpen && SettingsScreen}
  <SettingsScreen
    onclose={() => {
      settingsOpen = false;
    }}
    syncError={sync.syncError}
    syncErrorMessage={sync.syncErrorMessage}
    {...import.meta.env.DEV ? { simulateSyncSummary: sync.handleSyncComplete } : {}}
  />
{/if}

{#if noteActions.deleteConfirmationOpen}
  <DeleteNoteDialog oncancel={noteActions.cancelDelete} onconfirm={noteActions.deleteCurrentNote} />
{/if}

{#if searchOpen && SearchPopup}
  <SearchPopup
    onclose={() => {
      searchOpen = false;
    }}
    onselect={handleSearchSelect}
  />
{/if}

{#if noteActions.movePickerNoteId}
  <FolderPickerModal
    title="Move to folder"
    {notes}
    onpick={noteActions.moveCurrentNote}
    oncancel={noteActions.closeMovePicker}
  />
{/if}

{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}

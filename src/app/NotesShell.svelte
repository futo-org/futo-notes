<script lang="ts">
  import { untrack } from 'svelte';

  import { isDesktop } from '$lib/platform';
  import { saveConfig } from '$lib/platform/tauri';
  import { getAllNotes } from '$features/notes/notes.svelte';
  import { createNoteSession } from '$features/notes/noteSession.svelte';
  import ForYouPage from '$features/notes/ForYouPage.svelte';
  import SearchPopup from '$features/search/SearchPopup.svelte';
  import SettingsScreen from '$features/settings/SettingsScreen.svelte';
  import DrawerSidebar from '$features/sidebar/DrawerSidebar.svelte';
  import type { SidebarView } from '$features/sidebar/components/SidebarViewSelector.svelte';
  import { createSyncManager } from '$features/sync/syncManager.svelte';
  import SyncStatusBar from '$features/sync/SyncStatusBar.svelte';
  import { tabsStore, type OpenMode } from '$features/tabs/tabsStore.svelte';
  import { keyboard } from '$features/editor/keyboard.svelte';
  import { showGlobalToast, currentToastMessage } from '$shared/notifications/toastBus.svelte';

  import DesktopTopBand from './components/DesktopTopBand.svelte';
  import NoteWorkspace, { type EditorApi } from './components/NoteWorkspace.svelte';
  import { createCurrentNoteActions } from './createCurrentNoteActions.svelte';
  import { createTabNoteTransition } from './createTabNoteTransition';
  import { installNotesShellTestHook } from './installNotesShellTestHook';
  import { registerNotesShellShortcuts } from './registerNotesShellShortcuts';
  import { resetAllNotes } from './resetAllNotes';
  import {
    hashForNoteId,
    noteIdFromPath,
    parseNoteIdFromHash,
    resolveDesktopWikilinkTarget,
  } from './router';
  import { startNativeShell } from './startNativeShell';
  import { SIDEBAR_COLLAPSED_KEY, startTabsPersistence } from './startTabsPersistence';

  const MIN_SIDEBAR_WIDTH = 200;
  const MAX_SIDEBAR_WIDTH = 600;
  const DEFAULT_SIDEBAR_WIDTH = 280;
  const SIDEBAR_VIEW_KEY = 'futo-notes:sidebarView';

  let editor: EditorApi | undefined = $state();
  let noteBody: HTMLElement | undefined = $state();
  let titleTextarea: HTMLTextAreaElement | undefined = $state();
  let sidebarCollapsed = $state(false);
  let sidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
  let sidebarResizing = $state(false);
  let sidebarView = $state<SidebarView>(readSidebarView());
  let settingsOpen = $state(false);
  let searchOpen = $state(false);

  const notes = $derived(getAllNotes());
  const activeNoteId = $derived(tabsStore.activeNoteId);

  function navigate(path: string): void {
    const noteId = noteIdFromPath(path);
    if (tabsStore.activeNoteId !== noteId) tabsStore.openNote(noteId, 'current');
    writeHash(noteId);
  }

  const session = createNoteSession({
    getEditorContent: () => editor?.getContent(),
    setEditorContent: (content, options) => editor?.setContent(content, options),
    focusEditor: () => editor?.focus(),
    isEditorFocused: () => editor?.hasFocus() ?? false,
    isComposing: () => editor?.isComposing() ?? false,
    getNotes: getAllNotes,
    getNoteBody: () => noteBody,
    getTitleTextarea: () => titleTextarea,
    getNoteId: () => tabsStore.activeNoteId,
    setPrevNoteId: (id) => tabTransition.setLoadedNoteId(id),
    getPendingFolder: () => tabsStore.activeTab.pendingFolder ?? null,
    clearPendingFolder: () => tabsStore.setPendingFolder(tabsStore.activeTabId, null),
    onNoteRenamed: (fromId, toId) => {
      if (fromId) tabsStore.applyRename(fromId, toId);
      else tabsStore.replaceTabNoteId(tabsStore.activeTabId, toId);
      tabTransition.setLoadedNoteId(toId);
    },
    navigate,
  });

  const sync = createSyncManager({
    session,
    showToast: showGlobalToast,
    onRename: (fromId, toId) => {
      tabsStore.applyRename(fromId, toId);
      if (session.originalId === fromId) tabTransition.setLoadedNoteId(toId);
    },
    pruneTabsForDeletedIds: (goneIds) => {
      const gone = new Set(goneIds);
      tabsStore.pruneMissingNoteIds((id) => !gone.has(id));
    },
  });

  function closeActiveNote(): void {
    tabsStore.openNote(null, 'current');
    session.cancelAndClear();
  }

  function retargetActiveNote(fromId: string, toId: string, title: string): void {
    tabsStore.applyRename(fromId, toId);
    session.applyRemoteRename(toId, title);
    tabTransition.setLoadedNoteId(toId);
  }

  const noteActions = createCurrentNoteActions({
    getActiveNoteId: () => session.originalId,
    showToast: showGlobalToast,
    onMoved: retargetActiveNote,
    onDeleteConfirmed: closeActiveNote,
  });

  const tabTransition = createTabNoteTransition({
    loadNote: session.loadNote,
    getNoteBody: () => noteBody,
  });

  function readSidebarView(): SidebarView {
    try {
      const stored = localStorage.getItem(SIDEBAR_VIEW_KEY);
      if (stored === 'tags' || stored === 'images') return stored;
    } catch {
      // Storage is optional in the plain-web test harness.
    }
    return 'notes';
  }

  function writeHash(noteId: string | null): void {
    const next = hashForNoteId(noteId);
    if (window.location.hash !== next) window.location.hash = next;
  }

  function selectSidebarView(view: SidebarView): void {
    sidebarView = view;
    try {
      localStorage.setItem(SIDEBAR_VIEW_KEY, view);
    } catch {
      // Storage is optional in the plain-web test harness.
    }
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    sidebarCollapsed = collapsed;
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Storage is optional in the plain-web test harness.
    }
  }

  function toggleSidebar(): void {
    setSidebarCollapsed(!sidebarCollapsed);
  }

  function resizeSidebar(width: number): void {
    sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
    sidebarResizing = true;
    if (isDesktop) {
      void saveConfig({ sidebarWidth }).catch((error) =>
        console.warn('Failed to persist sidebar width:', error),
      );
    }
    window.clearTimeout(resizeEndTimer);
    resizeEndTimer = window.setTimeout(() => {
      sidebarResizing = false;
    }, 120);
  }

  let resizeEndTimer = 0;

  function openNote(noteId: string, event?: MouseEvent): void {
    if (noteId === '__home__') {
      tabsStore.openNote(null, 'current');
      return;
    }
    const mode: OpenMode = tabsStore.modeFromEvent(event);
    tabsStore.openNote(noteId, mode);
    if (mode !== 'background') searchOpen = false;
  }

  function createNewNote(folder = ''): void {
    const tab = tabsStore.openNote('new', 'current');
    tabsStore.setPendingFolder(tab.id, folder || null);
  }

  function openWikilink(title: string, event: MouseEvent): void {
    const noteId = resolveDesktopWikilinkTarget(
      title,
      getAllNotes().map((note) => note.id),
    );
    openNote(noteId, event);
  }

  function handleHashChange(): void {
    if (!tabsStore.hydrated) return;
    const noteId = parseNoteIdFromHash(window.location.hash);
    if (tabsStore.activeNoteId !== noteId) tabsStore.openNote(noteId, 'current');
  }

  function handleEditorFocusChange(focused: boolean): void {
    void sync.handleEditorFocusChange(focused);
  }

  keyboard.init();

  const stopTabsPersistence = startTabsPersistence({
    initialNoteId: parseNoteIdFromHash(window.location.hash),
    setSidebarCollapsed,
    setSidebarWidth: (width) => {
      sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
    },
  });
  const stopSync = sync.start();
  const stopShortcuts = registerNotesShellShortcuts({
    openSearch: () => {
      searchOpen = true;
    },
    createNote: () => createNewNote(),
  });
  const stopNativeShell = startNativeShell({
    enqueueFileChange: sync.enqueueFileChange,
    flushSave: session.flushSave,
  });

  window.addEventListener('hashchange', handleHashChange);

  const removeTestHook = installNotesShellTestHook({
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
      toastMessage: currentToastMessage(),
      hash: window.location.hash,
      editorContent: editor?.getContent() ?? '',
      savePending: session.savePending,
    }),
  });

  $effect(() => {
    if (!tabsStore.hydrated) return;
    const tab = tabsStore.activeTab;
    const tabId = tab.id;
    const noteId = tab.noteId;
    const savedScroll = tab.state?.scroll ?? 0;
    void untrack(() => tabTransition.transition(tabId, noteId, savedScroll));
  });

  $effect(() => {
    if (!tabsStore.hydrated) return;
    writeHash(tabsStore.activeNoteId);
  });

  $effect(() => {
    return () => {
      window.clearTimeout(resizeEndTimer);
      window.removeEventListener('hashchange', handleHashChange);
      removeTestHook();
      stopNativeShell();
      stopShortcuts();
      stopSync();
      stopTabsPersistence();
    };
  });
</script>

<div
  class="notes-shell desktop-layout"
  class:sidebar-collapsed={sidebarCollapsed}
  class:sidebar-resizing={sidebarResizing}
  style:--sidebar-width={`${sidebarWidth}px`}
  style:--vv-offset={`${keyboard.offsetTop}px`}
>
  {#if isDesktop}
    <DesktopTopBand {sidebarCollapsed} ontoggle={toggleSidebar} {notes} />
  {/if}

  <div class="desktop-body">
    <DrawerSidebar
      {notes}
      activeNoteId={session.originalId}
      view={sidebarView}
      showCollapse={!isDesktop}
      showResize={isDesktop}
      onselectview={selectSidebarView}
      onselectnote={openNote}
      onactivenotedeleted={closeActiveNote}
      onactivenotemoved={retargetActiveNote}
      onnewnote={() => createNewNote()}
      onnewnoteinfolder={createNewNote}
      onhome={() => tabsStore.openNote(null, 'current')}
      onsettings={() => {
        settingsOpen = true;
      }}
      oncollapse={toggleSidebar}
      onopensearch={() => {
        searchOpen = true;
      }}
      onresize={resizeSidebar}
    />

    <main class="note-main">
      {#if activeNoteId === null}
        <ForYouPage {notes} onnavigate={(id) => openNote(id)} />
      {/if}

      <NoteWorkspace
        {session}
        {notes}
        actions={noteActions}
        active={activeNoteId !== null}
        onopenlink={openWikilink}
        onfocuschange={handleEditorFocusChange}
        bind:editorApi={editor}
        bind:noteBodyEl={noteBody}
        bind:titleEl={titleTextarea}
      />

      {#if !isDesktop && sidebarCollapsed}
        <button
          class="sidebar-expand-fallback-btn"
          aria-label="Expand sidebar"
          onclick={toggleSidebar}
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
            <polyline points="13 8 16 12 13 16" />
          </svg>
        </button>
      {/if}
    </main>
  </div>
</div>

<SyncStatusBar
  statusMessage={sync.syncStatusMessage}
  indicatorVisible={sync.syncIndicatorVisible}
  offline={sync.syncOffline}
  error={sync.syncError}
  errorMessage={sync.syncErrorMessage}
  connected={sync.live}
  onclear={sync.clearSyncError}
/>

{#if searchOpen}
  <SearchPopup
    onclose={() => {
      searchOpen = false;
    }}
    onselect={openNote}
  />
{/if}

{#if settingsOpen}
  <SettingsScreen
    onclose={() => {
      settingsOpen = false;
    }}
    backgroundSyncError={sync.syncError}
    backgroundSyncErrorMessage={sync.syncErrorMessage}
    onsimulatesync={sync.handleSyncComplete}
    onreset={resetAllNotes}
  />
{/if}

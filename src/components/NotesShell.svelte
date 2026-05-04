<script lang="ts">
  import { hasFileSystem, isMobile, isDesktop, isTauri, showSoftKeyboard } from '$lib/platform';
  import { setContext } from 'svelte';
  import { createAppContext, APP_CONTEXT_KEY } from '$lib/appContext.svelte';
  import { createTouchSwipe } from '$lib/touchSwipe.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';
  // Lazy-loaded: MarkdownToolbar only shown on mobile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MarkdownToolbar: any = $state(null);
  // Lazy-loaded: SettingsScreen only needed when user opens settings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SettingsScreen: any = $state(null);
  // Lazy-loaded: SearchPopup only needed when user opens search (Ctrl+P or button)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SearchPopup: any = $state(null);
  import {
    getAllNotes,
    createNote,
    deleteNote,
  } from '$lib/notes.svelte';
  import { sanitizeFilename } from '$lib/utils';
  import type { SyncSummary } from '$lib/syncServiceE2ee';
  import { createNoteSession } from '$lib/noteSession.svelte';
  import ForYouPage from './ForYouPage.svelte';
  import NoteTagBar from './NoteTagBar.svelte';
  import SyncStatusBar from './SyncStatusBar.svelte';
  import GraphSidebarPanel from './GraphSidebarPanel.svelte';
  import DrawerSidebar from './DrawerSidebar.svelte';
  import { createSyncManager } from '$lib/syncManager.svelte';
  import { keyboard } from '$lib/keyboard.svelte';
  import { navigate } from '../router';
  import { onToast } from '$lib/toast';


  interface Props {
    noteId: string | null;
  }

  let { noteId }: Props = $props();

  // ── AppContext ──────────────────────────────────────────────
  const appCtx = createAppContext();
  setContext(APP_CONTEXT_KEY, appCtx);

  let drawerOpen = $state(!isMobile);
  let drawerProgress = $state(!isMobile ? 1 : 0);

  $effect(() => { appCtx.activeNoteId = noteId; });

  $effect(() => {
    appCtx.notes = hasFileSystem ? getAllNotes() : [];
    graphPanel?.clearGraphData();
  });

  let editor: ReturnType<typeof MarkdownEditor> | null = $state(null);
  let graphPanel: ReturnType<typeof GraphSidebarPanel> | null = $state(null);
  let editorFocused = $state(false);
  let toolbarTouching = $state(false);
  let cursorOnListLine = $state(false);
  let shell: HTMLElement | undefined = $state(undefined);
  let drawer: HTMLElement | undefined = $state(undefined);
  let noteBody: HTMLElement | undefined = $state(undefined);
  let titleTextarea: HTMLTextAreaElement | undefined = $state(undefined);

  let drawerWidth = $state(0);

  // Desktop sidebar
  let sidebarWidth = $state(280);
  let sidebarCollapsed = $state(false);
  let sidebarResizing = $state(false);

  function toggleSidebar(collapsed?: boolean) {
    sidebarCollapsed = collapsed ?? !sidebarCollapsed;
    localStorage.setItem('futo-notes:sidebarCollapsed', String(sidebarCollapsed));
  }
  // Desktop graph sidebar width (bound to GraphSidebarPanel)
  let graphSidebarWidth = $state(320);

  // Settings
  let settingsOpen = $state(false);

  // Search
  let searchOpen = $state(false);

  async function openSearch(): Promise<void> {
    if (!SearchPopup) {
      SearchPopup = (await import('./SearchPopup.svelte')).default;
    }
    searchOpen = true;
  }

  function handleSearchSelect(id: string): void {
    searchOpen = false;
    if (isMobile) setDrawerOpen(false);
    navigate(`/note/${encodeURIComponent(id)}`);
  }

  // Note menu
  let noteMenuOpen = $state(false);
  let deleteConfirmOpen = $state(false);


  // Graph sidebar
  let graphSidebarOpen = $state(false);
  let graphLoading = $state(false);
  let graphPanelResizing = $state(false);

  let graphSidebarEl: HTMLElement | undefined = $state(undefined);
  let graphOverlayEl: HTMLElement | undefined = $state(undefined);

  // Direct DOM refs for bypassing reactivity during drag
  let noteMainEl: HTMLElement | undefined = $state(undefined);
  let menuButtonEl: HTMLElement | undefined = $state(undefined);
  let noteMenuAnchorEl: HTMLElement | undefined = $state(undefined);
  let overlayEl: HTMLElement | undefined = $state(undefined);

  // ── Touch/swipe gesture handler ──────────────────────────
  const touch = createTouchSwipe({
    getDrawerWidth: () => drawerWidth,
    getDrawerOpen: () => drawerOpen,
    getGraphSidebarOpen: () => graphSidebarOpen,
    getGraphSidebarEl: () => graphSidebarEl,
    getGraphOverlayEl: () => graphOverlayEl,
    getNoteMainEl: () => noteMainEl,
    getDrawerEl: () => drawer,
    getMenuButtonEl: () => menuButtonEl,
    getNoteMenuAnchorEl: () => noteMenuAnchorEl,
    getOverlayEl: () => overlayEl,
    isSwipeExcluded: isSwipeExcludedTarget,
    isComposing: () => editor?.isComposing?.() ?? false,
    blurEditor: () => editor?.blur(),
    setDrawerOpen,
    setDrawerProgress,
    openGraphSidebar: () => graphPanel?.openGraph(),
    closeGraphSidebar,
    isMobile,
  });

  // prevNoteId is tracked here because the $effect that calls session.loadNote
  // compares it against the current noteId prop to detect real transitions.
  let prevNoteId: string | null | undefined = undefined;

  // Sync manager — owns writeSuppressor, watcherBatch, syncCoord, and all
  // sync coordination state. Extracted from this component for testability.
  const sync = createSyncManager({
    getOriginalId: () => session.originalId,
    getEditVersion: () => session.editVersion,
    isSavePending: () => session.isSavePending(),
    hasOpenDraftChanges: () => session.hasOpenDraftChanges(),
    getLastEditTime: () => session.lastEditTime,
    applyExternalContent: (content) => session.applyExternalContent(content),
    applyRemoteRename: (newId, newTitle) => session.applyRemoteRename(newId, newTitle),
    cancelAndClear: () => session.cancelAndClear(),
    flushSave: () => session.flushSave(),
    seedOpenNote: (id, body) => session.seedOpenNote(id, body),

    getEditorContent: () => editor?.getContent(),
    isComposing: () => Boolean(editor?.isComposing?.()),

    patchGraphNode: (from, to, title) => graphPanel?.patchGraphNode(from, to, title),
    clearGraphData: () => graphPanel?.clearGraphData(),

    showToast,
    navigate: (path) => navigate(path),
    getNoteId: () => noteId,
    getPrevNoteId: () => prevNoteId,
    setPrevNoteId: (id) => { prevNoteId = id; },
  });

  // Note session controller — owns title, content, save queue, title validation
  const session = createNoteSession({
    getEditorContent: () => editor?.getContent(),
    setEditorContent: (text, opts) => editor?.setContent(text, opts),
    focusEditor: () => editor?.focus(),
    getNotes: () => appCtx.notes,
    writeSuppressor: sync.writeSuppressor,
    patchGraphNode: (from, to, t) => graphPanel?.patchGraphNode(from, to, t),
    showToast,
    notifySaved: () => sync.notifySaved(),
    getNoteBody: () => noteBody,
    getTitleTextarea: () => titleTextarea,
    getNoteId: () => noteId,
    setPrevNoteId: (id) => { prevNoteId = id; },
  });


  // Toast
  let toastMessage = $state('');
  let toastTimer: number | null = null;

  function showToast(message: string): void {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastMessage = message;
    toastTimer = window.setTimeout(() => { toastMessage = ''; toastTimer = null; }, 3000);
  }

  // Let non-component code (e.g. queryEmbedder) surface messages as toasts
  const unsubToast = onToast(showToast);
  $effect(() => () => unsubToast());

  function handleImported(count: number): void {
    if (count === 0) {
      session.cancelAndClear();
    }
    settingsOpen = false;
    showToast(count > 0 ? `Imported ${count} notes` : 'All notes deleted');
  }

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
    void updateNativeDrawerState(open);
  }

  function setDrawerProgress(progress: number): void {
    drawerProgress = Math.min(1, Math.max(0, progress));
    if (drawerProgress > 0 && !editorIsComposing()) {
      editor?.blur();
    }
  }

  async function updateNativeDrawerState(open: boolean): Promise<void> {
    void open;
  }

  function handleNoteSelect(id: string): void {
    if (isMobile) setDrawerOpen(false);
    navigate(`/note/${encodeURIComponent(id)}`);
  }

  function handleDrawerSelect(id: string): void {
    if (id === '__home__') {
      if (isMobile) setDrawerOpen(false);
      navigate('/');
    } else {
      handleNoteSelect(id);
    }
  }

  async function handleOpenSettings(): Promise<void> {
    if (!SettingsScreen) {
      SettingsScreen = (await import('./SettingsScreen.svelte')).default;
    }
    settingsOpen = true;
  }


  async function createNewNote(): Promise<void> {
    if (isMobile) setDrawerOpen(false);
    await session.flushSave();
    navigate('/note/new');
  }

  async function createTestNote(): Promise<void> {
    if (!hasFileSystem) return;
    const [{ GFM_TEST_CONTENT }, { SCROLL_TEST_NOTES }] = await Promise.all([
      import('$lib/gfmTestContent'),
      import('$lib/scrollTestNotes'),
    ]);
    await createNote(sanitizeFilename('Markdown test note'), GFM_TEST_CONTENT);
    for (const note of SCROLL_TEST_NOTES) {
      await createNote(sanitizeFilename(note.title), note.content);
    }
  }

  function handleEditorFocusOut(): void {
    if (toolbarTouching) {
      // Don't drop editorFocused — user is interacting with the toolbar.
      // Refocus the editor so the keyboard doesn't dismiss.
      requestAnimationFrame(() => {
        if (toolbarTouching) editor?.focus();
      });
      return;
    }
    editorFocused = false;
  }

  function handleEditorFocusChange(focused: boolean): void {
    if (focused) {
      if (noteId) editorFocused = true;
    } else {
      handleEditorFocusOut();
    }
  }

  function handleNoteBodyClick(event: MouseEvent): void {
    if (!editor) return;
    // On mobile, clicking the dimmed area behind the drawer closes it — don't focus
    if (isMobile && drawerOpen) return;
    const target = event.target as HTMLElement;
    // Let CodeMirror handle taps within the editor so the cursor lands at tap coordinates.
    if (target.closest('.cm-editor')) return;
    // Don't steal focus from title input or interactive elements
    if (target.closest('.note-title-row, a, button')) return;
    editor.focus();
    // Android: explicitly raise the IME so the keyboard appears even when
    // the focus came from JS rather than the system tap-on-EditText path.
    void showSoftKeyboard();
  }



  async function handleDeleteNote(): Promise<void> {
    deleteConfirmOpen = false;
    noteMenuOpen = false;
    const idToDelete = session.originalId;
    if (!idToDelete) return;
    sync.writeSuppressor.recordWrite(`${idToDelete}.md`);
    session.cancelAndClear();
    await deleteNote(idToDelete);
    sync.notifySaved();
    showToast('Note deleted');
  }

  function isSwipeExcludedTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest('.cm-md-table-wrapper, .cm-md-table-rendered, .cm-md-table, .markdown-toolbar, .title-input, .graph-sidebar, .graph-fullscreen')
    );
  }

  async function copyNotePath(): Promise<void> {
    if (!noteId || noteId === 'new') return;
    try {
      const [{ getConfig }, { writeText }] = await Promise.all([
        import('$lib/platform/tauri'),
        import('@tauri-apps/plugin-clipboard-manager'),
      ]);
      const cfg = await getConfig();
      const fullPath = `${cfg.notesDir}/${noteId}.md`;
      await writeText(fullPath);
      showToast('Path copied');
    } catch {
      showToast('Failed to copy path');
    }
  }

  function openGraphSidebar(): void {
    graphPanel?.openGraph();
  }

  function closeGraphSidebar(): void {
    graphSidebarOpen = false;
  }

  function handleGraphNavigate(targetNoteId: string): void {
    navigate(`/note/${encodeURIComponent(targetNoteId)}`);
  }

  function handleDismissWindowKeydown(event: KeyboardEvent, dismiss: () => void): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  }

  $effect(() => {
    if (!deleteConfirmOpen) return;

    const handleWindowKeydown = (event: KeyboardEvent) => {
      handleDismissWindowKeydown(event, () => {
        deleteConfirmOpen = false;
      });
    };

    window.addEventListener('keydown', handleWindowKeydown);
    return () => window.removeEventListener('keydown', handleWindowKeydown);
  });

  function registerBackSwipeHandler(): void {
    const win = window as typeof window & { __toggleNotesDrawer?: () => void };
    win.__toggleNotesDrawer = () => setDrawerOpen(!drawerOpen);
  }

  async function loadNoteAndResetUI(id: string | null): Promise<void> {
    noteMenuOpen = false;
    deleteConfirmOpen = false;
    if (!id) editorFocused = false;
    await session.loadNote(id);
  }

  // Toolbar height constant (matches .markdown-toolbar height in components.css)
  const TOOLBAR_HEIGHT = 44;

  // Total bottom inset: keyboard + toolbar when keyboard is visible, just
  // toolbar height while the focused mobile editor is waiting on keyboard
  // metrics.
  const keyboardInset = $derived(
    keyboard.visible ? keyboard.height + TOOLBAR_HEIGHT :
    isMobile && editorFocused ? TOOLBAR_HEIGHT : 0
  );

  // Scroll cursor into view when keyboard opens or resizes.
  // CM's scrollIntoView is a no-op here because .cm-scroller has overflow:visible,
  // so we manually scroll the external .note-body container.
  $effect(() => {
    const inset = keyboardInset;
    if (inset > 0) {
      const v = editor?.getView();
      const scrollEl = noteBody;
      if (v && scrollEl) {
        requestAnimationFrame(() => {
          const cursor = v.coordsAtPos(v.state.selection.main.head);
          if (!cursor) return;
          const scrollRect = scrollEl.getBoundingClientRect();
          // If cursor is below the visible area, scroll it into view
          const visibleBottom = scrollRect.bottom;
          if (cursor.bottom > visibleBottom) {
            scrollEl.scrollTop += cursor.bottom - visibleBottom + 20;
          }
        });
      }
    }
  });

  $effect(() => {
    keyboard.init();
    if (isMobile && !MarkdownToolbar) {
      import('./MarkdownToolbar.svelte').then(m => { MarkdownToolbar = m.default; });
    }
    registerBackSwipeHandler();
    updateDrawerMetrics();

    // Sync manager lifecycle (autoSync, syncCoord, watcherBatch cleanup)
    const cleanupSync = sync.start();

    // Desktop sidebar: load persisted width + collapsed state
    if (isDesktop) {
      if (localStorage.getItem('futo-notes:sidebarCollapsed') === 'true') sidebarCollapsed = true;
      import('$lib/platform/tauri')
        .then(({ getConfig }) => getConfig())
        .then((cfg) => {
          if (cfg.sidebarWidth) sidebarWidth = cfg.sidebarWidth;
          if (cfg.graphSidebarWidth) graphSidebarWidth = cfg.graphSidebarWidth;
        })
        .catch(() => {
          const stored = localStorage.getItem('futo-notes:sidebarWidth');
          if (stored) sidebarWidth = parseInt(stored, 10) || 280;
          const graphStored = localStorage.getItem('futo-notes:graphSidebarWidth');
          if (graphStored) graphSidebarWidth = parseInt(graphStored, 10) || 320;
        });
    }

    // Native menu actions + file watcher
    const cleanupNativeListeners: Array<() => void> = [];
    if (isTauri) {
      import('$lib/platform/tauri').then(({ onMenuAction, onFileChange }) => {
        cleanupNativeListeners.push(onMenuAction((action) => {
          if (action === 'toggle-sidebar') toggleSidebar();
          else if (action === 'new-note') void createNewNote();
        }));

        cleanupNativeListeners.push(onFileChange((event) => {
          sync.enqueueFileChange(event);
        }));
      });

      // H10: Await save durability before window closes
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        getCurrentWindow().onCloseRequested(async (e) => {
          e.preventDefault();
          // Flush with a 3s timeout so a stuck save never blocks close
          await Promise.race([session.flushSave(), new Promise((r) => setTimeout(r, 3000))]);
          try {
            const { exit } = await import('@tauri-apps/plugin-process');
            await exit(0);
          } catch {
            getCurrentWindow().destroy();
          }
        }).then((unlisten) => {
          cleanupNativeListeners.push(unlisten);
        });
      }).catch(() => { /* non-Tauri environment */ });
    }

    // Global keyboard shortcuts
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    function handleGlobalShortcut(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      if (e.key === 'p') {
        e.preventDefault();
        void openSearch();
      } else if (e.key === 'n') {
        e.preventDefault();
        createNewNote();
      }
    }
    window.addEventListener('keydown', handleGlobalShortcut);

    return () => {
      cleanupSync();
      session.flushSave();
      cleanupNativeListeners.forEach((cleanup) => cleanup());
      window.removeEventListener('keydown', handleGlobalShortcut);
    };
  });

  $effect(() => {
    const currentNoteId = noteId;
    if (prevNoteId !== currentNoteId) {
      prevNoteId = currentNoteId;
      void loadNoteAndResetUI(currentNoteId);
    }
  });

  const drawerOffset = $derived(drawerProgress * drawerWidth);

  $effect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_INCLUDE_TEST_HOOKS === 'true')) return;
    const win = window as typeof window & {
      __notesShellTest?: {
        handleSyncComplete: (summary: SyncSummary) => Promise<void>;
        handleFileChange: (event: { type: 'add' | 'change' | 'unlink'; filename: string }) => Promise<void>;
        seedOpenNote: (id: string, body: string) => void;
        flushSave: () => Promise<void>;
        typeInEditor: (text: string) => string;
        getState: () => {
          originalId: string | null;
          title: string;
          toastMessage: string;
          hash: string;
          editorContent: string;
          savePending: boolean;
        };
      };
    };
    win.__notesShellTest = {
      handleSyncComplete: sync.handleSyncComplete,
      handleFileChange: sync.handleFileChange,
      seedOpenNote: (id: string, body: string) => {
        session.seedOpenNote(id, body);
        // Match the user-driven flow: opening a note focuses the editor so
        // the caret is visible. Done in a microtask so the editor has
        // applied the new content before we ask for focus.
        queueMicrotask(() => editor?.focus());
      },
      flushSave: () => session.flushSave(),
      typeInEditor: (text: string) => {
        const view = editor?.getView();
        if (!view) throw new Error('editor view not ready');
        view.focus();
        const { main } = view.state.selection;
        view.dispatch({
          changes: { from: main.from, to: main.to, insert: text },
          selection: { anchor: main.from + text.length },
          scrollIntoView: true,
          userEvent: 'input.type',
        });
        return view.state.doc.toString();
      },
      getState: () => ({
        originalId: session.originalId,
        title: session.title,
        toastMessage,
        hash: window.location.hash,
        editorContent: editor?.getContent() ?? '',
        savePending: session.isSavePending(),
      }),
    };
    return () => {
      delete win.__notesShellTest;
    };
  });
  const overlayOpacity = $derived(isMobile ? drawerProgress * 0.5 : 0);


</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={shell}
  class="notes-shell"
  class:desktop-layout={!isMobile}
  class:sidebar-collapsed={!isMobile && sidebarCollapsed}
  class:sidebar-resizing={sidebarResizing}
  class:graph-resizing={graphPanelResizing}
  class:drawer-open={drawerOpen}
  class:drawer-dragging={touch.isDragging}
  class:graph-sidebar-open={!isMobile && graphSidebarOpen}

  style="--drawer-offset: {drawerOffset}px; --sidebar-width: {sidebarWidth}px; --graph-sidebar-width: {graphSidebarWidth}px; --vv-offset: {keyboard.offsetTop}px"
  ontouchstart={touch.handleTouchStart}
  ontouchmove={touch.handleTouchMove}
  ontouchend={touch.handleTouchEnd}
  ontouchcancel={touch.handleTouchEnd}
>
  <!-- Drawer -->
  <DrawerSidebar
    {drawerOpen}
    {sidebarCollapsed}
    bind:sidebarWidth={sidebarWidth}
    isDragging={touch.isDragging}
    onselect={handleDrawerSelect}
    onsearch={() => { void openSearch(); }}
    onsettings={handleOpenSettings}
    onnewnote={createNewNote}
    oncreatetestnote={createTestNote}
    ontogglecollapse={toggleSidebar}
    bind:drawerEl={drawer}
    bind:sidebarResizing={sidebarResizing}
  />

  <!-- Menu button (mobile only) -->
  {#if isMobile}
    <button
      bind:this={menuButtonEl}
      class="drawer-toggle floating"
      aria-label="Open notes list"
      aria-expanded={drawerOpen}
      onclick={() => setDrawerOpen(!drawerOpen)}
    >&#9776;</button>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <!-- Main content -->
  <div bind:this={noteMainEl} class="note-main" style:bottom={keyboardInset > 0 ? `${keyboardInset}px` : undefined} onclick={() => { if (isMobile && drawerOpen) setDrawerOpen(false); }}>
    <!-- Note menu button (three-dot) -->
    {#if noteId && noteMenuOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="note-menu-backdrop" onclick={() => { noteMenuOpen = false; }}></div>
    {/if}
    {#if noteId}
      <div bind:this={noteMenuAnchorEl} class="note-menu-anchor">
        <button
          class="note-menu-toggle"
          aria-label="Note options"
          aria-expanded={noteMenuOpen}
          onclick={() => { noteMenuOpen = !noteMenuOpen; }}
        >&#8942;</button>
        {#if noteMenuOpen}
          <div class="note-menu-dropdown">
            {#if isTauri}
              <button onclick={() => { noteMenuOpen = false; void openGraphSidebar(); }}>Graph view</button>
              <button onclick={() => { noteMenuOpen = false; void copyNotePath(); }}>Copy file path</button>
            {/if}
            <button class="danger" onclick={() => { noteMenuOpen = false; deleteConfirmOpen = true; }}>Delete note</button>
          </div>
        {/if}
      </div>
    {/if}
    {#if !isMobile && sidebarCollapsed}
      <button class="sidebar-expand-btn" aria-label="Expand sidebar"
        onclick={() => { toggleSidebar(false); }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="9" y1="3" x2="9" y2="21"/>
          <polyline points="14 8 17 12 14 16"/>
        </svg>
      </button>
    {/if}
    <!-- Overlay replaces filter: brightness/contrast for GPU-composited dimming -->
    <div
      bind:this={overlayEl}
      class="drawer-overlay"
      class:active={isMobile && drawerOpen}
      style="opacity: {overlayOpacity}"
      onclick={() => setDrawerOpen(false)}
    ></div>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="note-body" data-editor-focused={editorFocused ? '' : undefined} bind:this={noteBody} onclick={handleNoteBodyClick} onfocusin={() => { if (noteId) editorFocused = true; }} onfocusout={handleEditorFocusOut}>
      {#if noteId}
        <div class="note-title-row">
          <textarea
            rows="1"
            class="title-input w-full border-none bg-transparent p-0 focus:outline-none"
            style="font-family: var(--font-serif); font-size: 30px; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; color: var(--color-text); resize: none; overflow: hidden; min-height: 36px;"
            placeholder="Untitled"
            bind:value={session.title}
            oninput={session.handleTitleInput}
            onkeydown={session.handleTitleKeydown}
            onfocus={session.handleTitleFocus}
            onpointerdown={session.handleTitlePointerDown}
            maxlength={200}
            enterkeyhint="done"
            bind:this={titleTextarea}
          ></textarea>
          {#if session.titleWarning}
            <div class="text-xs pt-0.5" style="color: var(--color-danger)">{session.titleWarning}</div>
          {/if}
        </div>
        <NoteTagBar
          content={session.content}
          getEditorView={() => editor?.getView() ?? null}
          notes={appCtx.notes}
        />
        <div class="editor-container">
          <MarkdownEditor
            bind:this={editor}
            content={session.content}
            onchange={session.debouncedSave}
            onfocuschange={handleEditorFocusChange}
            oncursorcontext={(ctx) => { cursorOnListLine = ctx.onListLine; }}
            scrollParent={noteBody ?? null}
          />
        </div>
      {:else}
        <ForYouPage onbrowse={() => setDrawerOpen(true)} onquickcapture={createNewNote} />
      {/if}
    </div>
    <SyncStatusBar statusMessage={sync.syncStatusMessage} indicatorVisible={sync.syncIndicatorVisible} offline={sync.syncOffline} />
  </div>

  {#if isMobile && MarkdownToolbar}
    <MarkdownToolbar
      getView={() => editor?.getView() ?? null}
      {editorFocused}
      {cursorOnListLine}
      ontoolbartouch={(touching) => toolbarTouching = touching}
    />
  {/if}


  <!-- Graph sidebar -->
  <GraphSidebarPanel
    bind:this={graphPanel}
    open={graphSidebarOpen}
    currentNoteId={noteId}
    bind:graphSidebarWidth={graphSidebarWidth}
    notes={appCtx.notes}
    onclose={closeGraphSidebar}
    onnavigate={handleGraphNavigate}
    onopen={() => { graphSidebarOpen = true; }}
    ontoast={showToast}
    bind:graphSidebarEl={graphSidebarEl}
    bind:graphOverlayEl={graphOverlayEl}
    bind:resizing={graphPanelResizing}
    bind:loading={graphLoading}
  />
</div>

{#if settingsOpen && SettingsScreen}
  <SettingsScreen
    onclose={() => { settingsOpen = false; }}
    onimported={handleImported}
  />
{/if}

{#if deleteConfirmOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="delete-confirm-overlay"
    onclick={() => { deleteConfirmOpen = false; }}
    onkeydown={(event) => handleDismissWindowKeydown(event, () => { deleteConfirmOpen = false; })}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="delete-confirm-dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
      <h3>Delete this note?</h3>
      <p>This action cannot be undone.</p>
      <div class="delete-confirm-actions">
        <button class="delete-confirm-cancel" onclick={() => { deleteConfirmOpen = false; }}>Cancel</button>
        <button class="delete-confirm-delete" onclick={handleDeleteNote}>Delete</button>
      </div>
    </div>
  </div>
{/if}

{#if searchOpen && SearchPopup}
  <SearchPopup onclose={() => { searchOpen = false; }} onselect={handleSearchSelect} />
{/if}

{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}

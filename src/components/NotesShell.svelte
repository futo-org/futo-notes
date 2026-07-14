<script lang="ts">
  import { hasFileSystem, isDesktop, isTauri, isMac } from '$lib/platform';
  import { setContext } from 'svelte';
  import { createAppContext, APP_CONTEXT_KEY } from '$lib/appContext.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';
  // Lazy-loaded: SettingsScreen only needed when user opens settings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SettingsScreen: any = $state(null);
  // Lazy-loaded: SearchPopup only needed when user opens search (Ctrl+P or button)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SearchPopup: any = $state(null);
  import { getAllNotes, createNote, deleteNote, moveNote, whenNotesReady } from '$lib/notes.svelte';
  import { sanitizeFilename } from '$lib/utils';
  import type { SyncSummary } from '$lib/syncServiceE2ee';
  import { createNoteSession } from '$lib/noteSession.svelte';
  import ForYouPage from './ForYouPage.svelte';
  import NoteTagBar from './NoteTagBar.svelte';
  import SyncStatusBar from './SyncStatusBar.svelte';
  import GraphSidebarPanel from './GraphSidebarPanel.svelte';
  import FolderPickerModal from './FolderPickerModal.svelte';
  import DrawerSidebar from './DrawerSidebar.svelte';
  import TabsStrip from './TabsStrip.svelte';
  import { createSyncManager } from '$lib/syncManager.svelte';
  import { keyboard } from '$lib/keyboard.svelte';
  import { navigate, noteIdFromHash } from '../router';
  import { tabsStore, type OpenMode } from '$lib/tabsStore.svelte';
  import { onToast } from '$lib/toast';

  interface Props {
    noteId: string | null;
  }

  let { noteId }: Props = $props();

  // ── AppContext ──────────────────────────────────────────────
  const appCtx = createAppContext();
  setContext(APP_CONTEXT_KEY, appCtx);

  $effect(() => {
    appCtx.activeNoteId = noteId;
  });

  // Mirror notes to appCtx on every change. This fans out to ForYouPage,
  // the tag sidebar, the note list, etc.
  $effect(() => {
    appCtx.notes = hasFileSystem ? getAllNotes() : [];
  });

  // Refreshing editor decorations is expensive — it forces a full
  // re-decoration pass (wikilink resolution, shortest-unique-suffix, tag
  // scans). Only do it when the *set of note IDs* changes, which is
  // what wikilink resolution actually depends on. Content edits and
  // mtime bumps don't change the ID set, so we don't pay this cost on
  // every keystroke-triggered save.
  let lastIdSignature = '';
  $effect(() => {
    const notes = appCtx.notes;
    // Sort to canonicalize so insertion order doesn't false-positive.
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
  let noteBody: HTMLElement | undefined = $state(undefined);
  let titleTextarea: HTMLTextAreaElement | undefined = $state(undefined);

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
      SearchPopup = (await import('$features/search/SearchPopup.svelte')).default;
    }
    searchOpen = true;
  }

  // Resolve the click's intent: on desktop honor modifier/middle-click for
  // tab semantics; on mobile a click always replaces the current view.
  function openFromEvent(id: string | null, event?: MouseEvent): OpenMode {
    const mode = isDesktop ? tabsStore.modeFromEvent(event) : 'current';
    tabsStore.openNote(id, mode);
    return mode;
  }

  function handleSearchSelect(id: string, event?: MouseEvent): void {
    const mode = openFromEvent(id, event);
    if (mode === 'current') searchOpen = false;
  }

  // Note menu
  let noteMenuOpen = $state(false);
  let deleteConfirmOpen = $state(false);

  // Graph sidebar
  let graphSidebarOpen = $state(false);
  let graphPanelResizing = $state(false);

  // prevNoteId is tracked here because the $effect that calls session.loadNote
  // compares it against the current noteId prop to detect real transitions.
  let prevNoteId: string | null | undefined = undefined;
  // prevTabId is tracked so we can snapshot scroll+cursor onto the OUTGOING
  // tab when the user switches tabs, then restore those on tab return.
  let prevTabId: string | null = null;

  const session = createNoteSession({
    getEditorContent: () => editor?.getContent(),
    setEditorContent: (text, opts) => editor?.setContent(text, opts),
    focusEditor: () => editor?.focus(),
    isEditorFocused: () => editor?.hasFocus?.() ?? false,
    isComposing: () => Boolean(editor?.isComposing?.()),
    getNotes: () => appCtx.notes,
    getNoteBody: () => noteBody,
    getTitleTextarea: () => titleTextarea,
    getNoteId: () => noteId,
    getPendingFolder: () => tabsStore.activeTab.pendingFolder ?? null,
    clearPendingFolder: () => {
      tabsStore.setPendingFolder(tabsStore.activeTabId, null);
    },
    onNoteRenamed: (savedOriginalId, realId) => {
      // The 'new' sentinel is what brand-new tabs carry until first save.
      const oldKey = savedOriginalId ?? 'new';
      const activeTab = tabsStore.activeTab;
      if (activeTab.noteId === oldKey) {
        // Bypass the noteId-change effect: it'd otherwise re-load the
        // just-saved content from disk and clobber the cursor.
        prevNoteId = realId;
        prevTabId = activeTab.id;
      }
      for (const t of tabsStore.tabs) {
        if (t.noteId === oldKey) {
          tabsStore.replaceTabNoteId(t.id, realId);
        }
      }
    },
  });

  const sync = createSyncManager({
    session,
    showToast,
    onRename: (fromId, toId, title) => {
      tabsStore.applyRename(fromId, toId);
      graphPanel?.patchGraphNode(fromId, toId, title);
      if (noteId === fromId) {
        prevNoteId = toId;
        navigate(`/note/${encodeURIComponent(toId)}`);
      }
    },
    pruneTabsForDeletedIds: (goneIds) => {
      const gone = new Set(goneIds);
      tabsStore.pruneMissingNoteIds((id) => !gone.has(id));
    },
  });

  // Toast
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
      SettingsScreen = (await import('./SettingsScreen.svelte')).default;
    }
    settingsOpen = true;
  }

  async function createNewNote(): Promise<void> {
    await session.flushSave();
    tabsStore.openNote('new', 'current');
  }

  /**
   * Create a new note inside a specific folder. The flow is identical
   * to createNewNote, but we stash the target folder on the resulting
   * tab so the editor's first save lands at `${folderPath}/${title}`
   * instead of the root.
   */
  async function createNewNoteInFolder(folderPath: string): Promise<void> {
    await session.flushSave();
    const tab = tabsStore.openNote('new', 'current');
    tabsStore.setPendingFolder(tab.id, folderPath);
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

  function handleEditorFocusChange(focused: boolean): void {
    if (focused) {
      if (noteId) editorFocused = true;
      void sync.handleEditorFocusChange(true);
      // Moving focus from the title into the body means the user is done
      // naming the note — flush the aggressively-debounced title save now so
      // the rename lands before content edits, instead of waiting out the 10s.
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

  function handleNoteBodyClick(event: MouseEvent): void {
    if (!editor) return;
    const target = event.target as HTMLElement;
    // Let CodeMirror handle taps within the editor so the cursor lands at tap coordinates.
    if (target.closest('.cm-editor')) return;
    // Don't steal focus from title/tag controls or interactive elements.
    if (target.closest('.note-title-row, .note-tag-bar, a, button, input, textarea, select'))
      return;

    // Tap below the rendered editor → caret at end of doc, otherwise the
    // caret stays at its previous position (often 0) and the tap looks
    // like a no-op or a jump to the top.
    const editorRect = editor.getView()?.dom.getBoundingClientRect();
    if (editorRect && event.clientY > editorRect.bottom) {
      editor.placeCaretAtEnd();
    }
    editor.focus();
  }

  async function handleDeleteNote(): Promise<void> {
    deleteConfirmOpen = false;
    noteMenuOpen = false;
    const idToDelete = session.originalId;
    if (!idToDelete) return;
    session.cancelAndClear();
    await deleteNote(idToDelete);
    sync.notifySaved();
    showToast('Note deleted');
  }

  // Move-to-folder for the currently open note. Reuses the FolderPickerModal
  // already wired in DrawerSidebar by exposing a simple `pickFolderFor` hook.
  let movePickerOpen = $state(false);
  let movePickerNoteId = $state<string | null>(null);

  function openMoveCurrentNoteToFolder(): void {
    if (!noteId || noteId === 'new') return;
    movePickerNoteId = noteId;
    movePickerOpen = true;
  }

  async function handleMovePick(target: string): Promise<void> {
    const id = movePickerNoteId;
    movePickerOpen = false;
    movePickerNoteId = null;
    if (!id) return;
    const components = id.split('/');
    const leaf = components[components.length - 1];
    const newId = target ? `${target}/${leaf}` : leaf;
    if (newId === id) return;
    try {
      const result = await moveNote(id, newId);
      // Keep the user on the moved note: update any tab pointing at the
      // old id to the new one (active tab tracks the live note).
      if (result.id !== id) {
        tabsStore.applyRename(id, result.id);
      }
      showToast(target ? `Moved to ${target}` : 'Moved to Notes');
    } catch (err) {
      showToast((err as Error).message ?? 'Move failed');
    }
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

  function handleGraphNavigate(targetNoteId: string, event?: MouseEvent): void {
    openFromEvent(targetNoteId, event);
  }

  function handleWikilinkOpen(title: string, event: MouseEvent): void {
    openFromEvent(title, event);
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

  async function loadNoteAndResetUI(id: string | null): Promise<void> {
    noteMenuOpen = false;
    deleteConfirmOpen = false;
    if (!id) editorFocused = false;
    await session.loadNote(id);
  }

  $effect(() => {
    keyboard.init();

    // Sync manager lifecycle (autoSync, syncCoord, watcherBatch cleanup)
    const cleanupSync = sync.start();

    // Desktop sidebar: load persisted width + collapsed state, persisted tabs.
    // `initialHashNoteId` is read here (not pre-rendered into the store)
    // so a persisted-tabs snapshot can still hydrate cleanly — see
    // `tabsStore.hydrate` for the rationale.
    let tabsPersistTimer: number | null = null;
    const initialHashNoteId = noteIdFromHash(window.location.hash);
    if (isDesktop) {
      if (localStorage.getItem('futo-notes:sidebarCollapsed') === 'true') sidebarCollapsed = true;
      // Wait for the initial note scan to finish BEFORE we build the
      // valid-noteIds predicate. Otherwise on a cold sandbox (especially
      // iOS) `getConfig()` resolves faster than `initNotes()` populates
      // `appCtx.notes`, every persisted noteId fails the predicate, and
      // the user silently loses every tab from the prior session.
      Promise.all([
        import('$lib/platform/tauri').then(({ getConfig, saveConfig }) =>
          getConfig().then((cfg) => ({ cfg, saveConfig })),
        ),
        whenNotesReady(),
      ])
        .then(([{ cfg, saveConfig }]) => {
          if (cfg.sidebarWidth) sidebarWidth = cfg.sidebarWidth;
          if (cfg.graphSidebarWidth) graphSidebarWidth = cfg.graphSidebarWidth;
          // Read live notes here (not the captured `appCtx.notes`) so we
          // catch any updates that landed between the await and now.
          const live = hasFileSystem ? getAllNotes() : [];
          const noteIndex = new Set(live.map((n) => n.id));
          tabsStore.hydrate(cfg.openTabs ?? null, (id) => noteIndex.has(id), initialHashNoteId);
          // Wire the persister with a small debounce — tab edits can burst
          // (drag-reorder fires many moves per second).
          tabsStore.setPersister((snapshot) => {
            if (tabsPersistTimer !== null) clearTimeout(tabsPersistTimer);
            tabsPersistTimer = window.setTimeout(() => {
              tabsPersistTimer = null;
              void saveConfig({ openTabs: snapshot }).catch((err) => {
                console.warn('Failed to persist open tabs:', err);
              });
            }, 250);
          });
        })
        .catch((err) => {
          // Config or platform-FS dynamic import failed. Do NOT call
          // `tabsStore.hydrate(null, () => false, …)` — that marks the
          // store hydrated for the session AND would refuse subsequent
          // restore attempts. Worse, since we'd also not wire the
          // persister, the user's persisted tabs on disk would be
          // intact but the in-memory state would be a single fresh
          // Home with no path back. Instead, hydrate ONLY for hash
          // navigation; leave the persisted config on disk untouched.
          console.warn('[tabs] hydrate path failed, falling back without persister:', err);
          const stored = localStorage.getItem('futo-notes:sidebarWidth');
          if (stored) sidebarWidth = parseInt(stored, 10) || 280;
          const graphStored = localStorage.getItem('futo-notes:graphSidebarWidth');
          if (graphStored) graphSidebarWidth = parseInt(graphStored, 10) || 320;
          // Pristine + hash → reuses the lone Home tab for the deep link;
          // no persisted-tab destruction.
          tabsStore.hydrate(null, () => true, initialHashNoteId);
        });
    } else {
      tabsStore.hydrate(null, () => true, initialHashNoteId);
    }

    // Native menu actions + file watcher
    const cleanupNativeListeners: Array<() => void> = [];
    if (isTauri) {
      import('$lib/platform/tauri').then(({ onMenuAction, onFileChange }) => {
        cleanupNativeListeners.push(
          onMenuAction((action) => {
            if (action === 'toggle-sidebar') toggleSidebar();
            else if (action === 'new-note') void createNewNote();
          }),
        );

        cleanupNativeListeners.push(
          onFileChange((event) => {
            sync.enqueueFileChange(event);
          }),
        );
      });

      // H10: Await save durability before window closes
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => {
          getCurrentWindow()
            .onCloseRequested(async (e) => {
              e.preventDefault();
              // Flush with a 3s timeout so a stuck save never blocks close
              await Promise.race([session.flushSave(), new Promise((r) => setTimeout(r, 3000))]);
              try {
                const { exit } = await import('@tauri-apps/plugin-process');
                await exit(0);
              } catch {
                getCurrentWindow().destroy();
              }
            })
            .then((unlisten) => {
              // Wrap so a stray double-cleanup doesn't double-unregister
              // the Tauri event (which throws "listeners[eventId] is undefined").
              let called = false;
              cleanupNativeListeners.push(() => {
                if (called) return;
                called = true;
                unlisten();
              });
            });
        })
        .catch(() => {
          /* non-Tauri environment */
        });
    }

    // Global keyboard shortcuts
    function handleGlobalShortcut(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // ── Tab shortcuts (desktop only) ────────────────────────────────
      if (isDesktop) {
        // Next/prev via Ctrl+PageDown/PageUp — works on all platforms and
        // is the documented fallback when Ctrl+Tab is swallowed by the
        // webview (GTK WebKit on Linux has historically eaten it).
        if (e.ctrlKey && !e.shiftKey && e.key === 'PageDown') {
          e.preventDefault();
          tabsStore.nextTab();
          return;
        }
        if (e.ctrlKey && !e.shiftKey && e.key === 'PageUp') {
          e.preventDefault();
          tabsStore.prevTab();
          return;
        }
        // Ctrl+Tab / Ctrl+Shift+Tab cycle when delivered (Windows/macOS).
        if (e.ctrlKey && e.key === 'Tab') {
          e.preventDefault();
          if (e.shiftKey) tabsStore.prevTab();
          else tabsStore.nextTab();
          return;
        }
        // macOS extras (Cmd+Tab is OS-owned): match Safari/Chrome.
        if (isMac && e.metaKey && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          e.preventDefault();
          if (e.key === 'ArrowRight') tabsStore.nextTab();
          else tabsStore.prevTab();
          return;
        }

        if (mod) {
          if (e.key === 't' && !e.shiftKey) {
            e.preventDefault();
            tabsStore.newTab();
            return;
          }
          if (e.key === 'w') {
            e.preventDefault();
            tabsStore.closeActive();
            return;
          }
          if (e.key === 'T' || (e.shiftKey && e.key === 't')) {
            e.preventDefault();
            tabsStore.reopenLastClosed();
            return;
          }
          if (e.key >= '1' && e.key <= '9') {
            e.preventDefault();
            const n = Number(e.key);
            if (n === 9) tabsStore.activateLast();
            else tabsStore.activateByIndex(n - 1);
            return;
          }
        }
      }

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
      if (tabsPersistTimer !== null) clearTimeout(tabsPersistTimer);
      tabsStore.setPersister(null);
    };
  });

  $effect(() => {
    const currentNoteId = noteId;
    const currentTabId = tabsStore.activeTabId;
    if (prevNoteId === currentNoteId && prevTabId === currentTabId) return;

    // Snapshot the outgoing tab's editor state when leaving it.
    if (prevTabId && prevTabId !== currentTabId && editor) {
      const sel = editor.getSelection?.();
      const scroll = noteBody?.scrollTop ?? 0;
      tabsStore.setTabState(
        prevTabId,
        sel ? { scroll, selFrom: sel.from, selTo: sel.to } : undefined,
      );
    }

    const incomingTabId = currentTabId;
    const incomingState = tabsStore.tabs.find((t) => t.id === incomingTabId)?.state;
    const incomingNoteId = currentNoteId;

    prevNoteId = currentNoteId;
    prevTabId = currentTabId;

    void loadNoteAndResetUI(currentNoteId).then(() => {
      // Restore only if the user hasn't switched tabs or notes since the load began.
      if (!incomingState) return;
      if (tabsStore.activeTabId !== incomingTabId) return;
      if (incomingNoteId !== noteId) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (tabsStore.activeTabId !== incomingTabId) return;
          editor?.setSelection?.(incomingState.selFrom, incomingState.selTo);
          if (noteBody) noteBody.scrollTop = incomingState.scroll;
        }),
      );
    });
  });

  $effect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_INCLUDE_TEST_HOOKS === 'true')) return;
    const win = window as typeof window & {
      __notesShellTest?: {
        handleSyncComplete: (summary: SyncSummary) => Promise<void>;
        handleLiveState: (payload: { live: boolean; status: string; message?: string }) => void;
        handleFileChange: (event: {
          type: 'add' | 'change' | 'unlink';
          filename: string;
        }) => Promise<void>;
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
      handleLiveState: sync.handleLiveState,
      handleFileChange: sync.handleFileChange,
      seedOpenNote: (id: string, body: string) => {
        // The seeded note is intentionally not on disk. Mark the route as
        // loaded before navigation so the route effect does not replace the
        // seeded body with readNote(id)'s missing-file empty string.
        prevNoteId = id;
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
        savePending: session.savePending,
      }),
    };
    return () => {
      delete win.__notesShellTest;
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="notes-shell desktop-layout"
  class:sidebar-collapsed={sidebarCollapsed}
  class:sidebar-resizing={sidebarResizing}
  class:graph-resizing={graphPanelResizing}
  class:graph-sidebar-open={graphSidebarOpen}
  style="--sidebar-width: {sidebarWidth}px; --graph-sidebar-width: {graphSidebarWidth}px; --vv-offset: {keyboard.offsetTop}px"
>
  <!-- Drawer -->
  <DrawerSidebar
    drawerOpen={true}
    {sidebarCollapsed}
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
    bind:sidebarResizing
  />

  <!-- Main content -->
  <div class="note-main">
    <!-- Note menu button (three-dot) -->
    {#if noteId && noteMenuOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div
        class="note-menu-backdrop"
        onclick={() => {
          noteMenuOpen = false;
        }}
      ></div>
    {/if}
    {#if noteId}
      <div class="note-menu-anchor">
        <button
          class="note-menu-toggle"
          aria-label="Note options"
          aria-expanded={noteMenuOpen}
          onclick={() => {
            noteMenuOpen = !noteMenuOpen;
          }}>&#8942;</button
        >
        {#if noteMenuOpen}
          <div class="note-menu-dropdown">
            {#if isTauri}
              <button
                onclick={() => {
                  noteMenuOpen = false;
                  void openGraphSidebar();
                }}>Graph view</button
              >
              <button
                onclick={() => {
                  noteMenuOpen = false;
                  void copyNotePath();
                }}>Copy file path</button
              >
            {/if}
            {#if noteId && noteId !== 'new'}
              <button
                onclick={() => {
                  noteMenuOpen = false;
                  openMoveCurrentNoteToFolder();
                }}
                data-testid="note-menu-move">Move to folder</button
              >
            {/if}
            <button
              class="danger"
              onclick={() => {
                noteMenuOpen = false;
                deleteConfirmOpen = true;
              }}>Delete note</button
            >
          </div>
        {/if}
      </div>
    {/if}
    {#if !isDesktop && sidebarCollapsed}
      <button
        class="sidebar-expand-btn sidebar-expand-fallback-btn"
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
    {#if isDesktop}
      <TabsStrip
        {sidebarCollapsed}
        onExpandSidebar={() => {
          toggleSidebar(false);
        }}
      />
    {/if}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="note-body"
      data-editor-focused={editorFocused ? '' : undefined}
      bind:this={noteBody}
      onclick={handleNoteBodyClick}
      onfocusin={handleNoteBodyFocusIn}
    >
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
            bind:this={titleTextarea}></textarea>
          {#if session.titleWarning}
            <div class="text-xs pt-0.5" style="color: var(--color-danger)">
              {session.titleWarning}
            </div>
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
            scrollParent={noteBody ?? null}
            onopenlink={handleWikilinkOpen}
          />
        </div>
      {:else}
        <ForYouPage />
      {/if}
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
  </div>

  <!-- Graph sidebar -->
  <GraphSidebarPanel
    bind:this={graphPanel}
    open={graphSidebarOpen}
    currentNoteId={noteId}
    bind:graphSidebarWidth
    notes={appCtx.notes}
    onclose={closeGraphSidebar}
    onnavigate={handleGraphNavigate}
    onopen={() => {
      graphSidebarOpen = true;
    }}
    ontoast={showToast}
    bind:resizing={graphPanelResizing}
  />
</div>

{#if settingsOpen && SettingsScreen}
  <SettingsScreen
    onclose={() => {
      settingsOpen = false;
    }}
    onimported={handleImported}
    syncError={sync.syncError}
    syncErrorMessage={sync.syncErrorMessage}
    {...import.meta.env.DEV ? { simulateSyncSummary: sync.handleSyncComplete } : {}}
  />
{/if}

{#if deleteConfirmOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="delete-confirm-overlay"
    onclick={() => {
      deleteConfirmOpen = false;
    }}
    onkeydown={(event) =>
      handleDismissWindowKeydown(event, () => {
        deleteConfirmOpen = false;
      })}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div
      class="delete-confirm-dialog"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <h3>Delete this note?</h3>
      <p>This action cannot be undone.</p>
      <div class="delete-confirm-actions">
        <button
          class="delete-confirm-cancel"
          onclick={() => {
            deleteConfirmOpen = false;
          }}>Cancel</button
        >
        <button class="delete-confirm-delete" onclick={handleDeleteNote}>Delete</button>
      </div>
    </div>
  </div>
{/if}

{#if searchOpen && SearchPopup}
  <SearchPopup
    onclose={() => {
      searchOpen = false;
    }}
    onselect={handleSearchSelect}
  />
{/if}

{#if movePickerOpen}
  <FolderPickerModal
    title="Move to folder"
    notes={appCtx.notes}
    onpick={handleMovePick}
    oncancel={() => {
      movePickerOpen = false;
      movePickerNoteId = null;
    }}
  />
{/if}

{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}

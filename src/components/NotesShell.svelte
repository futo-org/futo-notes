<script lang="ts">
  import { hasFileSystem, isMobile, isDesktop, isTauri } from '$lib/platform';
  import type { FileChangeEvent } from '$lib/platform/types';
  import { createWriteSuppressor } from '$lib/writeSuppression';
  import { createWatcherBatch } from '$lib/watcherBatch';
  import { createSyncCoordinator } from '$lib/syncCoordinator';
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
  import VirtualList from './VirtualList.svelte';
  import type { NotePreview } from '../types';
  import {
    getAllNotes,
    updateNote,
    readNote,
    createNote,
    getNoteById,
    deleteNote,
    handleExternalFileChange,
    refreshNotesFromStorage
  } from '$lib/notes';
  import { sanitizeFilename } from '$lib/utils';
  import { FORBIDDEN_CHARS_RE, validateTitle } from '@futo-notes/shared';
  import type { SyncSummary } from '$lib/sync';
  import { trackOpen } from '$lib/engagement';
  import ForYouPage from './ForYouPage.svelte';
  import NoteTagBar from './NoteTagBar.svelte';
  import SidebarTagView from './SidebarTagView.svelte';
  import SidebarImageView from './SidebarImageView.svelte';
  // AutoSync is loaded lazily — not needed for initial render
  let _autoSync: typeof import('$lib/autoSync') | null = null;
  const getAutoSync = (): Promise<typeof import('$lib/autoSync')> => _autoSync ? Promise.resolve(_autoSync) : import('$lib/autoSync').then(m => { _autoSync = m; return m; });
  const notifySaved = () => { _autoSync?.notifySaved(); };
  import { keyboard } from '$lib/keyboard.svelte';
  import { navigate } from '../router';
  import { getCachedPreferences } from '$lib/preferences';
  import { authFetch } from '$lib/authFetch';
  import { onToast } from '$lib/toast';

  import type { GraphData } from '$lib/supersearch/graphData';
  // Lazy-loaded: GraphCanvas component + graphData pipeline
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GraphCanvas: any = $state(null);

  interface Props {
    noteId: string | null;
  }

  let { noteId }: Props = $props();

  let drawerOpen = $state(!isMobile);
  let drawerProgress = $state(!isMobile ? 1 : 0);
  let title = $state('');
  let content = $state('');
  let originalId: string | null = $state(null);
  let savedTitle = $state('');
  let notes: NotePreview[] = $state([]);

  let editor: ReturnType<typeof MarkdownEditor> | null = $state(null);
  let editorFocused = $state(false);
  let toolbarTouching = $state(false);
  let cursorOnListLine = $state(false);
  let shell: HTMLElement | undefined = $state(undefined);
  let drawer: HTMLElement | undefined = $state(undefined);
  let noteBody: HTMLElement | undefined = $state(undefined);
  let titleTextarea: HTMLTextAreaElement | undefined = $state(undefined);

  let sidebarView: 'notes' | 'tags' | 'images' = $state((typeof localStorage !== 'undefined' && localStorage.getItem('futo-notes:sidebarView') as 'notes' | 'tags' | 'images') || 'notes');
  let drawerWidth = $state(0);
  let saveTimeout: number | null = null;
  let saveInFlight: Promise<void> | null = null;
  let saveQueued = false;
  let lastEditTime = 0;
  let editVersion = 0;
  let notesLoaded = false;
  let loading = false;
  let titleWarning = $state('');
  let titleWarningTimer: number | null = null;

  // Edge swipe tracking
  let tracking = false;
  let isDragging = $state(false);
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let ignoreSwipe = false;
  let startProgress = 0;

  // FAB long-press
  let fabPressTimer: number | null = null;
  let ignoreFabClick = false;

  // Desktop sidebar
  let sidebarWidth = $state(280);
  let sidebarCollapsed = $state(false);
  let resizing = $state(false);

  function toggleSidebar(collapsed?: boolean) {
    sidebarCollapsed = collapsed ?? !sidebarCollapsed;
    localStorage.setItem('futo-notes:sidebarCollapsed', String(sidebarCollapsed));
  }
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  // Desktop graph sidebar resize
  let graphSidebarWidth = $state(320);
  let graphResizing = $state(false);
  let graphResizeStartX = 0;
  let graphResizeStartWidth = 0;

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
  let graphData: GraphData | null = $state(null);
  let graphLoading = $state(false);
  let graphFullscreenOpen = $state(false);

  // Right-edge swipe tracking (plain JS, not reactive — same pattern as left drawer)
  let rightSwipe = false;
  let rightDragProgress = 0;
  let graphSidebarEl: HTMLElement | undefined = $state(undefined);
  let graphOverlayEl: HTMLElement | undefined = $state(undefined);
  let noteLoadVersion = 0;

  // File watcher self-write suppression (desktop native)
  const writeSuppressor = createWriteSuppressor();
  let externalRescanTimer: number | null = null;
  let externalRescanInFlight = false;
  let externalRescanQueued = false;

  // Watcher batch — initialized after handleSingleWatcherEvent is defined (see below)
  let watcherBatch: ReturnType<typeof createWatcherBatch> | null = null;
  // Sync coordinator — initialized in the mount $effect after watcherBatch
  let syncCoord: ReturnType<typeof createSyncCoordinator> | null = null;

  let syncStatusMessage = $state('');
  let syncIndicatorVisible = $state(false);
  let syncOffline = $state(false);


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
      // Nuke: cancel any pending auto-save so it doesn't re-create the open note
      if (saveTimeout !== null) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      originalId = null;
      navigate('/');
    }
    refreshNotesList();
    settingsOpen = false;
    showToast(count > 0 ? `Imported ${count} notes` : 'All notes deleted');
  }

  const ARTIFACT_CHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
  let lastArtifactCheckAt = 0;
  let artifactCheckInFlight = false;

  async function checkSupersearchArtifacts(force = false): Promise<void> {
    const prefs = getCachedPreferences();
    if (!prefs.sync.serverUrl || !prefs.sync.token) return;
    const now = Date.now();
    if (artifactCheckInFlight) return;
    if (!force && lastArtifactCheckAt > 0 && now - lastArtifactCheckAt < ARTIFACT_CHECK_MIN_INTERVAL_MS) return;
    artifactCheckInFlight = true;
    let completed = false;
    try {
      const { checkForUpdate, downloadArtifact } = await import('$lib/supersearch/artifactManager');
      const { hasUpdate, capabilities } = await checkForUpdate();
      if (hasUpdate && capabilities) {
        const downloaded = await downloadArtifact(capabilities);
        if (!downloaded) return;
      }
      completed = true;
    } catch (e) {
      console.warn('[supersearch] artifact check failed:', e);
    } finally {
      if (completed) {
        lastArtifactCheckAt = Date.now();
      }
      artifactCheckInFlight = false;
    }
  }

  async function handleSyncComplete(summary: SyncSummary): Promise<void> {

    const hasRemoteNoteChanges = summary.updatedIds.length > 0 || summary.deletedIds.length > 0 || summary.renamed.length > 0;
    for (const id of summary.updatedIds) writeSuppressor.recordSyncWrite(`${id}.md`);
    for (const id of summary.deletedIds) writeSuppressor.recordSyncWrite(`${id}.md`);
    for (const rename of summary.renamed) {
      writeSuppressor.recordSyncWrite(`${rename.fromId}.md`);
      writeSuppressor.recordSyncWrite(`${rename.toId}.md`);
      writeSuppressor.recordRemoteRename(rename.fromId, rename.toId);
    }
    if (hasRemoteNoteChanges) {
      // Defer note list refresh so it doesn't block active typing.
      // requestIdleCallback yields to pending input events first.
      const schedule = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => setTimeout(cb, 50));
      schedule(() => refreshNotesList());
    }

    // Check once after first sync, then on remote note changes (throttled).
    if (lastArtifactCheckAt === 0 || hasRemoteNoteChanges) {
      void checkSupersearchArtifacts();
    }

    const activeRename = originalId
      ? summary.renamed.find((rename) => rename.fromId === originalId)
      : undefined;
    if (activeRename) {
      const previousId = activeRename.fromId;
      originalId = activeRename.toId;
      const meta = getNoteById(activeRename.toId);
      title = meta?.title ?? activeRename.toId;
      savedTitle = title;

      if (graphData) {
        const idx = graphData.nodeIndex.get(previousId);
        if (idx !== undefined) {
          graphData.nodes[idx].noteId = activeRename.toId;
          graphData.nodes[idx].title = title;
          graphData.nodeIndex.delete(previousId);
          graphData.nodeIndex.set(activeRename.toId, idx);
        }
      }

      const currentPath = window.location.hash.slice(1) || '/';
      if (currentPath === `/note/${encodeURIComponent(previousId)}`) {
        prevNoteId = activeRename.toId;
        navigate(`/note/${encodeURIComponent(activeRename.toId)}`);
      }
    }

    // Reload only when sync actually touched the currently-open note.
    // Download/delete activity for other notes should not disturb editor focus.
    if (originalId && (summary.updatedIds.includes(originalId) || summary.deletedIds.includes(originalId))) {
      try {
        const freshContent = await readNote(originalId);
        // Only replace editor content if the current note actually changed.
        // Skipping avoids a full document dispatch that loses focus (and
        // dismisses the keyboard on mobile).
        if (freshContent !== editor?.getContent()) {
          // If the user typed while sync was in flight, local state is newer — skip overwrite.
          // editVersion is incremented on every keystroke; syncStartEditVersion is
          // captured when sync begins. A mismatch means the user edited during sync.
          const editedDuringSync = editVersion !== (syncCoord?.getSyncStartEditVersion() ?? 0);
          if (!editedDuringSync) {
            content = freshContent;
            suppressSaveOnChange = true;
            editor?.setContent(freshContent, { preserveSelection: true });
            suppressSaveOnChange = false;
          }
        }
        // H13: Always refresh metadata (title/savedTitle) even when content
        // replacement was skipped due to active editing.
        const meta = getNoteById(originalId);
        if (meta) {
          title = meta.title;
          savedTitle = meta.title;
        }
      } catch {
        // Note was deleted by sync — navigate away
        if (saveTimeout !== null) {
          clearTimeout(saveTimeout);
          saveTimeout = null;
        }
        originalId = null;
        navigate('/');
      }
    }

    // Sync status banner
    const totalChanges = summary.updatedIds.length + summary.deletedIds.length + summary.renamed.length;
    if (totalChanges > 20) {
      syncCoord?.setStatusWithTimeout(`Synced ${totalChanges} notes`, 3000);
    } else {
      syncStatusMessage = '';
    }

  }

  async function handleBulkWatcherRefresh(events: FileChangeEvent[]): Promise<void> {
    await refreshNotesFromStorage();
    refreshNotesList();
    // Handle active note if affected
    const activeFilename = originalId ? `${originalId}.md` : null;
    if (activeFilename) {
      const activeEvent = events.find(ev => ev.filename === activeFilename);
      if (activeEvent) {
        await handleSingleWatcherEvent(activeEvent);
      }
    }
  }

  async function handleSingleWatcherEvent(event: FileChangeEvent): Promise<void> {
    const { type, filename } = event;
    if (!filename.endsWith('.md')) return;
    if (writeSuppressor.isRecentSyncWrite(filename)) return;
    if (writeSuppressor.isRecentWrite(filename)) return;

    const id = filename.replace(/\.md$/, '');
    if (type === 'unlink' && writeSuppressor.getRecentRemoteRename(id)) return;
    // Suppress change events for open note when save is pending or in-flight
    if (id === originalId && (saveTimeout !== null || saveInFlight !== null) && type === 'change') return;
    if (id === originalId && hasOpenDraftChanges() && (type === 'change' || type === 'unlink')) {
      showToast(
        type === 'unlink'
          ? 'Open note was deleted externally; keeping local draft'
          : 'Open note changed externally; keeping local draft',
      );
      await refreshNotesFromStorage();
      refreshNotesList();
      if (type === 'change') {
        scheduleExternalRescan(250);
      }
      return;
    }

    if (type === 'unlink' && id === originalId) {
      if (saveTimeout !== null) { clearTimeout(saveTimeout); saveTimeout = null; }
      originalId = null;
      navigate('/');
      showToast('Note was deleted externally');
    } else if (type === 'change' && id === originalId) {
      if (saveTimeout !== null) { clearTimeout(saveTimeout); saveTimeout = null; }
      try {
        const freshContent = await readNote(id);
        content = freshContent;
        suppressSaveOnChange = true;
        editor?.setContent(freshContent, { preserveSelection: true });
        suppressSaveOnChange = false;
        const meta = getNoteById(id);
        if (meta) {
          title = meta.title;
          savedTitle = meta.title;
        }
      } catch {
        // Ignore read errors for transient file events.
      }
    }

    await handleExternalFileChange(type, filename);
    refreshNotesList();
    if (type === 'add' || type === 'change') {
      scheduleExternalRescan();
    }
    if (type === 'add' || type === 'change') {
      notifySaved();
    }
  }

  // Initialize the watcher batch now that the event handlers are defined
  watcherBatch = createWatcherBatch({
    onEvent: handleSingleWatcherEvent,
    onBulkRefresh: handleBulkWatcherRefresh,
    suppressor: writeSuppressor,
  });

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
    setDrawerProgress(open ? 1 : 0, true);
    void updateNativeDrawerState(open);
  }

  function setDrawerProgress(progress: number, snap: boolean = false): void {
    drawerProgress = Math.min(1, Math.max(0, progress));
    if (drawerProgress > 0 && !editorIsComposing()) {
      editor?.blur();
    }
    if (snap) {
      isDragging = false;
    }
  }

  async function updateNativeDrawerState(open: boolean): Promise<void> {
    void open;
  }

  function getNextUntitledTitle(): string {
    const base = 'Untitled';
    const existingIds = new Set(notes.map(n => n.id));
    if (!existingIds.has(sanitizeFilename(base))) return base;
    let i = 1;
    while (existingIds.has(sanitizeFilename(`${base} (${i})`))) i++;
    return `${base} (${i})`;
  }

  function refreshNotesList(): void {
    notes = hasFileSystem ? getAllNotes() : [];
    import('$lib/supersearch/graphData').then(m => m.clearGraphCache());
    if (!graphSidebarOpen) {
      graphData = null;
    }
  }

  function hasOpenDraftChanges(): boolean {
    if (!originalId && noteId !== 'new') return false;
    if (saveTimeout !== null || saveInFlight !== null || saveQueued) return true;
    const currentContent = editor?.getContent() ?? content;
    return currentContent !== content || title !== savedTitle;
  }

  async function runExternalRescan(): Promise<void> {
    if (!hasFileSystem) return;
    if (externalRescanInFlight) {
      externalRescanQueued = true;
      return;
    }
    externalRescanInFlight = true;
    try {
      await refreshNotesFromStorage();
      refreshNotesList();
    } catch (e) {
      console.warn('External rescan failed:', e);
    } finally {
      externalRescanInFlight = false;
      if (externalRescanQueued) {
        externalRescanQueued = false;
        scheduleExternalRescan(250);
      }
    }
  }

  function scheduleExternalRescan(delayMs = 800): void {
    if (externalRescanTimer !== null) {
      clearTimeout(externalRescanTimer);
    }
    externalRescanTimer = window.setTimeout(() => {
      externalRescanTimer = null;
      void runExternalRescan();
    }, delayMs);
  }

  function handleNoteSelect(id: string): void {
    if (isMobile) setDrawerOpen(false);
    navigate(`/note/${encodeURIComponent(id)}`);
  }

  const stoneFruits = ['🥑', '🍑', '🍒', '🥥', '🥭', '🫒'];
  let brandFruit = $state(localStorage.getItem('stonefruit-emoji') ?? stoneFruits[0]);

  function cycleFruit(): void {
    const idx = stoneFruits.indexOf(brandFruit);
    brandFruit = stoneFruits[(idx + 1) % stoneFruits.length];
    localStorage.setItem('stonefruit-emoji', brandFruit);
  }

  function handleBrandClick(): void {
    if (isMobile) setDrawerOpen(false);
    navigate('/');
  }

  async function createNewNote(): Promise<void> {
    if (isMobile) setDrawerOpen(false);
    await flushSave();
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
    refreshNotesList();
  }

  let suppressSaveOnChange = false;

  function debouncedSave(): void {
    if (suppressSaveOnChange || loading || !hasFileSystem || !editor || noteId === null) return;
    lastEditTime = Date.now();
    editVersion++;
    if (saveTimeout !== null) {
      clearTimeout(saveTimeout);
    }
    saveTimeout = window.setTimeout(() => {
      saveTimeout = null;
      void runQueuedSave();
    }, 500);
  }

  async function flushSave(): Promise<void> {
    const hadPendingTimer = saveTimeout !== null;
    if (hadPendingTimer) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    try {
      if (hadPendingTimer) {
        await runQueuedSave();
      } else if (saveInFlight !== null) {
        await saveInFlight;
      }
    } catch (e) {
      console.warn('Failed to flush note save:', e);
    }
  }

  async function runQueuedSave(): Promise<void> {
    if (saveInFlight !== null) {
      saveQueued = true;
      await saveInFlight;
      return;
    }

    const run = (async () => {
      do {
        saveQueued = false;
        const wrote = await saveNote();
        if (wrote) notifySaved();
      } while (saveQueued);
    })();

    saveInFlight = run;
    try {
      await run;
    } finally {
      if (saveInFlight === run) {
        saveInFlight = null;
      }
    }
  }

  async function saveNote(): Promise<boolean> {
    if (!hasFileSystem || !editor || noteId === null) return false;
    try {
      const newTitle = title.trim() || 'Untitled';
      const titleIssues = validateTitle(newTitle);
      const blockingTitleIssue = titleIssues.find((issue) => issue.kind !== 'empty');
      if (blockingTitleIssue) {
        showTitleWarning(blockingTitleIssue.message, null);
        return false;
      }
      const newId = sanitizeFilename(newTitle);
      const newContent = editor.getContent();

      // Don't save new notes until the body has content — title-only notes are ephemeral.
      // This prevents duplicate note creation from debounced saves firing with partial titles.
      if (!originalId && !newContent.trim()) return false;

      // Skip write if nothing changed — prevents mtime bumps from setContent during
      // note loading (CM6 fires docChanged → rAF onchange → debouncedSave even when
      // the content is identical to what was just loaded).
      if (originalId && newTitle === savedTitle && newContent === content) return false;

      // Block saving if another note already has this name
      if (hasDuplicateTitle(newTitle)) return false;

      const savedOriginalId = originalId;
      if (savedOriginalId) {
        // Mark rename source/target before disk writes to suppress our own watcher events.
        writeSuppressor.recordWrite(`${savedOriginalId}.md`);
        if (savedOriginalId !== newId) {
          writeSuppressor.recordWrite(`${newId}.md`);
        }
      }

      const result = await updateNote(newId, newTitle, newContent, savedOriginalId ?? undefined);

      // Track write for file-watcher self-suppression
      writeSuppressor.recordWrite(`${result.id}.md`);
      if (savedOriginalId && savedOriginalId !== result.id) {
        writeSuppressor.recordWrite(`${savedOriginalId}.md`); // unlink event from rename
      }

      originalId = result.id;
      // Only update content state if the editor hasn't drifted during the async save.
      // Otherwise, the stale snapshot triggers MarkdownEditor's $effect, which replaces
      // the entire document and resets the cursor to position 0.
      if (editor.getContent() === newContent) {
        content = newContent;
      }
      savedTitle = newTitle;

      // Patch graph data in-place so the graph view survives renames
      if (graphData && savedOriginalId && savedOriginalId !== result.id) {
        const idx = graphData.nodeIndex.get(savedOriginalId);
        if (idx !== undefined) {
          graphData.nodes[idx].noteId = result.id;
          graphData.nodes[idx].title = newTitle;
          graphData.nodeIndex.delete(savedOriginalId);
          graphData.nodeIndex.set(result.id, idx);
        }
      }

      refreshNotesList();

      // Only update URL if user is still viewing this note (not mid-switch)
      const currentPath = window.location.hash.slice(1) || '/';
      const stillOnThisNote = savedOriginalId
        ? currentPath === `/note/${encodeURIComponent(savedOriginalId)}`
        : currentPath === '/note/new';

      if (stillOnThisNote && currentPath !== `/note/${encodeURIComponent(result.id)}`) {
        prevNoteId = result.id;
        navigate(`/note/${encodeURIComponent(result.id)}`);
      }
      return true;
    } catch (e) {
      console.warn('Failed to save note:', e);
      return false;
    }
  }

  function hasDuplicateTitle(checkTitle: string): boolean {
    const checkId = sanitizeFilename(checkTitle.trim() || 'Untitled');
    return notes.some(n => n.id === checkId && n.id !== originalId);
  }

  function autoResizeTitleTextarea(): void {
    const el = titleTextarea;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  function handleTitleInput(event: Event): void {
    const input = event.target as HTMLTextAreaElement;
    // Strip newlines (pasted text may include them)
    let cleaned = input.value.replace(/[\r\n]/g, '');
    const hadForbidden = cleaned !== cleaned.replace(FORBIDDEN_CHARS_RE, '');
    cleaned = cleaned.replace(FORBIDDEN_CHARS_RE, '');
    if (hadForbidden) {
      const pos = input.selectionStart ?? cleaned.length;
      title = cleaned;
      requestAnimationFrame(() => {
        input.setSelectionRange(pos - 1, pos - 1);
      });
      showTitleWarning("That character can't be used in a note title", 2000);
    } else if (input.value !== cleaned) {
      // Newlines were stripped
      const pos = input.selectionStart ?? cleaned.length;
      title = cleaned;
      requestAnimationFrame(() => {
        input.setSelectionRange(pos, pos);
      });
    } else {
      // Check for dot / length issues via shared validation
      const issues = validateTitle(cleaned);
      const dotOrLength = issues.find(
        (i) => i.kind === 'leading_dots' || i.kind === 'trailing_dots' || i.kind === 'too_long',
      );
      if (dotOrLength) {
        showTitleWarning(dotOrLength.message, null);
      } else if (hasDuplicateTitle(cleaned)) {
        showTitleWarning('A note with this name already exists', null);
      } else {
        clearTitleWarning();
      }
    }
    autoResizeTitleTextarea();
    debouncedSave();
  }

  function showTitleWarning(message: string, autoHideMs: number | null): void {
    if (titleWarningTimer !== null) clearTimeout(titleWarningTimer);
    titleWarning = message;
    titleWarningTimer = autoHideMs !== null
      ? window.setTimeout(() => { titleWarning = ''; titleWarningTimer = null; }, autoHideMs)
      : null;
  }

  function clearTitleWarning(): void {
    if (titleWarningTimer !== null) clearTimeout(titleWarningTimer);
    titleWarning = '';
    titleWarningTimer = null;
  }

  function handleTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      editor?.focus();
    }
  }

  function shouldAutoSelectUntitledTitle(value: string): boolean {
    return value.startsWith('Untitled');
  }

  function selectAllTitleText(input: HTMLTextAreaElement): void {
    input.setSelectionRange(0, input.value.length);
    requestAnimationFrame(() => {
      input.setSelectionRange(0, input.value.length);
    });
  }

  function handleTitleFocus(event: FocusEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (shouldAutoSelectUntitledTitle(input.value)) {
      selectAllTitleText(input);
    }
  }

  function handleTitlePointerDown(event: PointerEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (shouldAutoSelectUntitledTitle(input.value)) {
      event.preventDefault();
      input.focus();
      selectAllTitleText(input);
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
  }

  function handleFabTouchStart(): void {
    fabPressTimer = window.setTimeout(() => {
      createTestNote();
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
      createNewNote();
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
    createNewNote();
  }


  async function handleDeleteNote(): Promise<void> {
    deleteConfirmOpen = false;
    noteMenuOpen = false;
    const idToDelete = originalId;
    if (!idToDelete) return;
    // Cancel any pending auto-save for this note
    if (saveTimeout !== null) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    writeSuppressor.recordWrite(`${idToDelete}.md`);
    originalId = null;
    await deleteNote(idToDelete);
    refreshNotesList();
    navigate('/');
    notifySaved();
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

  async function openGraphSidebar(): Promise<void> {
    graphSidebarOpen = true;
    if (graphData || graphLoading) return;
    graphLoading = true;
    try {
      const [{ computeGraphData }, canvasMod] = await Promise.all([
        import('$lib/supersearch/graphData'),
        import('./GraphCanvas.svelte'),
      ]);
      GraphCanvas = canvasMod.default;
      const result = await computeGraphData(notes);
      if (result.nodes.length === 0) {
        showToast('No notes to graph');
        graphSidebarOpen = false;
        return;
      }
      graphData = result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        const prefs = getCachedPreferences();
        if (prefs.sync.serverUrl && prefs.sync.token) {
          const status = await authFetch<{ scheduler?: { phase?: string } }>('/search/status');
          const phase = status?.scheduler?.phase;
          if (phase === 'indexing' || phase === 'downloading_model' || phase === 'loading_model' || phase === 'building_artifacts') {
            showToast('Indexing in progress...');
            graphSidebarOpen = false;
            return;
          }
        }
      } catch {
        // Fall through to show original error
      }
      showToast(msg);
      graphSidebarOpen = false;
    } finally {
      graphLoading = false;
    }
  }

  function closeGraphSidebar(): void {
    graphFullscreenOpen = false;
    graphSidebarOpen = false;
  }

  function openGraphFullscreen(): void {
    if (!graphData) return;
    graphFullscreenOpen = true;
  }

  function closeGraphFullscreen(): void {
    graphFullscreenOpen = false;
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
    if (!(deleteConfirmOpen || graphFullscreenOpen || (isMobile && (graphSidebarOpen || graphLoading)))) return;

    const handleWindowKeydown = (event: KeyboardEvent) => {
      if (deleteConfirmOpen) {
        handleDismissWindowKeydown(event, () => {
          deleteConfirmOpen = false;
        });
        return;
      }

      if (graphFullscreenOpen) {
        handleDismissWindowKeydown(event, closeGraphFullscreen);
        return;
      }

      handleDismissWindowKeydown(event, closeGraphSidebar);
    };

    window.addEventListener('keydown', handleWindowKeydown);
    return () => window.removeEventListener('keydown', handleWindowKeydown);
  });

  let edgeSwipe = false;

  function handleTouchStart(event: TouchEvent): void {
    if (!isMobile) return;
    if (event.touches.length !== 1) return;
    if (isSwipeExcludedTarget(event.target)) {
      tracking = false;
      ignoreSwipe = true;
      return;
    }
    const touch = event.touches[0];
    tracking = true;
    isDragging = false;
    startX = touch.clientX;
    startY = touch.clientY;
    lastX = startX;
    lastTime = Date.now();
    velocity = 0;
    ignoreSwipe = false;
    edgeSwipe = touch.clientX < 30;
    rightSwipe = touch.clientX > window.innerWidth - 30;
    updateDrawerMetrics();
    if (rightSwipe) {
      startProgress = graphSidebarOpen ? 1 : 0;
      rightDragProgress = startProgress;
    } else {
      startProgress = drawerOpen ? 1 : 0;
      dragProgress = startProgress;
      setDrawerProgress(startProgress);
    }
  }

  function handleTouchMove(event: TouchEvent): void {
    if (ignoreSwipe || !tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const isEdge = edgeSwipe || rightSwipe;
    // For edge swipes, bias toward horizontal: only treat as vertical if deltaY > 2x deltaX
    const isVertical = isEdge
      ? Math.abs(deltaY) > 2 * Math.abs(deltaX)
      : Math.abs(deltaX) < Math.abs(deltaY);
    if (!isDragging && isVertical) return;

    if (rightSwipe) {
      // Right sidebar: swipe left to open, right to close
      if (!isDragging && Math.abs(deltaX) < 3) return;
      if (!isDragging) {
        isDragging = true;
        editor?.blur();
      }

      const now = Date.now();
      const dt = now - lastTime;
      if (dt > 0) velocity = (touch.clientX - lastX) / dt;
      lastX = touch.clientX;
      lastTime = now;

      // Progress: 0 = closed, 1 = open. Swiping left (negative deltaX) opens.
      const graphWidth = graphSidebarEl?.getBoundingClientRect().width || 320;
      rightDragProgress = Math.min(1, Math.max(0, startProgress - deltaX / graphWidth));
      applyRightDragFrame();
      event.preventDefault();
      return;
    }

    // Left drawer logic (existing)
    // When closing (drawer open), prevent list scroll as soon as horizontal intent is clear
    if (startProgress > 0 && Math.abs(deltaX) > Math.abs(deltaY)) {
      event.preventDefault();
    }

    // Lower threshold for edge swipes (3px vs 5px)
    const minDragThreshold = edgeSwipe ? 3 : 5;
    if (!isDragging && Math.abs(deltaX) < minDragThreshold) return;

    if (!isDragging) {
      isDragging = true;
      editor?.blur();
    }

    const now = Date.now();
    const dt = now - lastTime;
    if (dt > 0) {
      velocity = (touch.clientX - lastX) / dt;
    }
    lastX = touch.clientX;
    lastTime = now;

    // Direct DOM manipulation — bypass Svelte reactivity during drag
    dragProgress = Math.min(1, Math.max(0, startProgress + deltaX / drawerWidth));
    scheduleFrame();
    event.preventDefault();
  }

  function applyRightDragFrame(): void {
    const graphWidth = graphSidebarEl?.getBoundingClientRect().width || 320;
    const offset = (1 - rightDragProgress) * graphWidth;
    if (graphSidebarEl) graphSidebarEl.style.transform = `translateX(${offset}px)`;
    if (graphOverlayEl) graphOverlayEl.style.opacity = `${rightDragProgress * 0.3}`;
  }

  function handleTouchEnd(): void {
    if (isDragging && rightSwipe) {
      // Right sidebar snap
      if (graphSidebarEl) graphSidebarEl.style.transform = '';
      if (graphOverlayEl) graphOverlayEl.style.opacity = '';
      isDragging = false;

      const shouldOpen = Math.abs(velocity) > 0.3 ? velocity < 0 : rightDragProgress >= 0.3;
      requestAnimationFrame(() => {
        if (shouldOpen && !graphSidebarOpen) {
          void openGraphSidebar();
        } else if (!shouldOpen && graphSidebarOpen) {
          closeGraphSidebar();
        }
      });

      tracking = false;
      ignoreSwipe = false;
      edgeSwipe = false;
      rightSwipe = false;
      velocity = 0;
      return;
    }

    if (isDragging) {
      // Cancel any pending rAF
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }

      // Sync plain var back to Svelte state so CSS variables match visual position
      drawerProgress = dragProgress;

      // Clear inline styles — no visual jump since CSS vars hold the same values
      if (noteMainEl) noteMainEl.style.transform = '';
      if (drawer) drawer.style.transform = '';
      if (menuButtonEl) menuButtonEl.style.transform = '';
      if (noteMenuAnchorEl) noteMenuAnchorEl.style.transform = '';
      if (overlayEl) overlayEl.style.opacity = isMobile ? String(dragProgress * 0.5) : '0';

      // Re-enable CSS transitions
      isDragging = false;

      // Snap to open or closed on next frame — lower velocity threshold for edge swipes
      const velocityThreshold = edgeSwipe ? 0.3 : 0.5; // px/ms
      const shouldOpen = Math.abs(velocity) > velocityThreshold ? velocity > 0 : drawerProgress >= 0.3;
      requestAnimationFrame(() => {
        setDrawerOpen(shouldOpen);
      });
    }
    tracking = false;
    isDragging = false;
    ignoreSwipe = false;
    edgeSwipe = false;
    rightSwipe = false;
    velocity = 0;
  }

  function registerBackSwipeHandler(): void {
    const win = window as typeof window & { __toggleNotesDrawer?: () => void };
    win.__toggleNotesDrawer = () => setDrawerOpen(!drawerOpen);
  }

  async function loadNote(id: string | null): Promise<void> {
    const loadVersion = ++noteLoadVersion;
    await flushSave();
    if (loadVersion !== noteLoadVersion) return;
    noteMenuOpen = false;
    deleteConfirmOpen = false;

    loading = true;

    // Reset scroll position so the new note starts at the top
    if (noteBody) noteBody.scrollTop = 0;

    if (!id) {
      title = '';
      content = '';
      savedTitle = '';
      originalId = null;
      editorFocused = false;
      loading = false;
      return;
    }

    originalId = id !== 'new' ? id : null;

    if (id === 'new') {
      title = getNextUntitledTitle();
      content = '';
      savedTitle = title;
      editor?.setContent('');
      loading = false;
      requestAnimationFrame(() => {
        if (loadVersion !== noteLoadVersion) return;
        autoResizeTitleTextarea();
        editor?.focus();
      });
    } else if (hasFileSystem) {
      try {
        const loadedContent = await readNote(id);
        if (loadVersion !== noteLoadVersion) return;
        content = loadedContent;
        const meta = getNoteById(id);
        title = meta?.title || id;
        savedTitle = title;
        editor?.setContent(loadedContent);
        trackOpen(id);
        requestAnimationFrame(() => {
          if (loadVersion !== noteLoadVersion) return;
          autoResizeTitleTextarea();
        });
      } catch {
        if (loadVersion !== noteLoadVersion) return;
        // Note doesn't exist — create it (e.g. wikilink to new note)
        try {
          const result = await createNote(id, '');
          if (loadVersion !== noteLoadVersion) return;
          title = id;
          content = '';
          savedTitle = id;
          originalId = result.id;
          editor?.setContent('');
          refreshNotesList();
          loading = false;
          requestAnimationFrame(() => {
            if (loadVersion !== noteLoadVersion) return;
            autoResizeTitleTextarea();
            editor?.focus();
          });
          return;
        } catch {
          // Creation also failed — navigate home
          loading = false;
          navigate('/');
          return;
        }
      }
      loading = false;
    }
  }

  // Toolbar height constant (matches .markdown-toolbar height in components.css)
  const TOOLBAR_HEIGHT = 44;

  // Total bottom inset: keyboard + toolbar when keyboard visible, just toolbar when editor focused on mobile
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
    if (hasFileSystem && !notesLoaded) {
      refreshNotesList();
      notesLoaded = true;
    }
    registerBackSwipeHandler();
    updateDrawerMetrics();

    // Auto-sync — loaded lazily to keep initial bundle small
    syncCoord = createSyncCoordinator(
      {
        watcherBatch: watcherBatch!,
        getEditVersion: () => editVersion,
        isSavePending: () => saveTimeout !== null || saveInFlight !== null || saveQueued,
        isComposing: () => Boolean(editor?.isComposing?.()),
        getLastEditTime: () => lastEditTime,
      },
      {
        onStatusMessage: (msg) => { syncStatusMessage = msg; },
        onIndicatorChange: (visible) => { syncIndicatorVisible = visible; },
        onOfflineChange: (offline) => { syncOffline = offline; },
      },
    );
    const coord = syncCoord;
    getAutoSync().then(({ startAutoSync }) => {
      startAutoSync({
        onSyncComplete: handleSyncComplete,
        onSyncError: (err) => console.warn('Auto-sync error:', err),
        flushPendingSave: flushSave,
        onSupersearchReady: () => { void checkSupersearchArtifacts(true); },
        shouldDeferSync: coord.shouldDeferSync,
        onOfflineChange: coord.onOfflineChange,
        onSyncStateChange: coord.onSyncStateChange,
      });
    });

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
          watcherBatch?.enqueue(event);
        }));
      });

      // H10: Await save durability before window closes
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        getCurrentWindow().onCloseRequested(async (e) => {
          e.preventDefault();
          // Flush with a 3s timeout so a stuck save never blocks close
          await Promise.race([flushSave(), new Promise((r) => setTimeout(r, 3000))]);
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
      _autoSync?.stopAutoSync();
      flushSave();
      if (externalRescanTimer !== null) {
        clearTimeout(externalRescanTimer);
        externalRescanTimer = null;
      }
      watcherBatch?.destroy();
      syncCoord?.destroy();
      cleanupNativeListeners.forEach((cleanup) => cleanup());
      window.removeEventListener('keydown', handleGlobalShortcut);
    };
  });

  let prevNoteId: string | null | undefined = undefined;

  $effect(() => {
    const currentNoteId = noteId;
    if (prevNoteId !== currentNoteId) {
      prevNoteId = currentNoteId;
      void loadNote(currentNoteId);
    }
  });

  const drawerOffset = $derived(drawerProgress * drawerWidth);

  $effect(() => {
    if (!import.meta.env.DEV) return;
    const win = window as typeof window & {
      __notesShellTest?: {
        handleSyncComplete: (summary: SyncSummary) => Promise<void>;
        handleFileChange: (event: { type: 'add' | 'change' | 'unlink'; filename: string }) => Promise<void>;
        seedOpenNote: (id: string, body: string) => void;
        getState: () => { originalId: string | null; title: string; toastMessage: string; hash: string };
      };
    };
    win.__notesShellTest = {
      handleSyncComplete,
      handleFileChange: handleSingleWatcherEvent,
      seedOpenNote: (id: string, body: string) => {
        originalId = id;
        title = id;
        savedTitle = id;
        content = body;
        editor?.setContent(body);
        prevNoteId = id;
        navigate(`/note/${encodeURIComponent(id)}`);
      },
      refreshNotes: refreshNotesList,
      getState: () => ({
        originalId,
        title,
        toastMessage,
        hash: window.location.hash,
      }),
    };
    return () => {
      delete win.__notesShellTest;
    };
  });
  const overlayOpacity = $derived(isMobile ? drawerProgress * 0.5 : 0);

  // Direct DOM refs for bypassing reactivity during drag
  let noteMainEl: HTMLElement | undefined = $state(undefined);
  let menuButtonEl: HTMLElement | undefined = $state(undefined);
  let noteMenuAnchorEl: HTMLElement | undefined = $state(undefined);
  let overlayEl: HTMLElement | undefined = $state(undefined);
  let dragProgress = 0;
  let rafId = 0;

  function applyDragFrame(): void {
    rafId = 0;
    const offset = dragProgress * drawerWidth;
    if (noteMainEl) noteMainEl.style.transform = `translateX(${offset}px)`;
    if (drawer) drawer.style.transform = `translateX(${offset - drawerWidth}px)`;
    if (menuButtonEl) menuButtonEl.style.transform = `translateX(${offset}px)`;
    if (noteMenuAnchorEl) noteMenuAnchorEl.style.transform = `translateX(${offset}px)`;
    if (overlayEl) overlayEl.style.opacity = isMobile ? `${dragProgress * 0.5}` : '0';
  }

  function scheduleFrame(): void {
    if (rafId) return;
    rafId = requestAnimationFrame(applyDragFrame);
  }

  // Desktop sidebar resize
  function handleResizeStart(e: PointerEvent): void {
    e.preventDefault();
    resizing = true;
    resizeStartX = e.clientX;
    resizeStartWidth = sidebarWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleResizeMove(e: PointerEvent): void {
    if (!resizing) return;
    sidebarWidth = Math.max(180, Math.min(600, resizeStartWidth + (e.clientX - resizeStartX)));
  }

  function handleResizeEnd(): void {
    if (!resizing) return;
    resizing = false;
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

  // Desktop graph sidebar resize
  function handleGraphResizeStart(e: PointerEvent): void {
    e.preventDefault();
    graphResizing = true;
    graphResizeStartX = e.clientX;
    graphResizeStartWidth = graphSidebarWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleGraphResizeMove(e: PointerEvent): void {
    if (!graphResizing) return;
    graphSidebarWidth = Math.max(200, Math.min(600, graphResizeStartWidth - (e.clientX - graphResizeStartX)));
  }

  function handleGraphResizeEnd(): void {
    if (!graphResizing) return;
    graphResizing = false;
    persistGraphSidebarWidth(graphSidebarWidth);
  }

  function persistGraphSidebarWidth(width: number): void {
    if (isDesktop) {
      import('$lib/platform/tauri').then(({ saveConfig }) => {
        saveConfig({ graphSidebarWidth: width });
      });
    } else {
      localStorage.setItem('futo-notes:graphSidebarWidth', String(width));
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={shell}
  class="notes-shell"
  class:desktop-layout={!isMobile}
  class:sidebar-collapsed={!isMobile && sidebarCollapsed}
  class:sidebar-resizing={resizing}
  class:graph-resizing={graphResizing}
  class:drawer-open={drawerOpen}
  class:drawer-dragging={isDragging}
  class:graph-sidebar-open={!isMobile && graphSidebarOpen}
  class:graph-fullscreen-open={graphFullscreenOpen}
  style="--drawer-offset: {drawerOffset}px; --sidebar-width: {sidebarWidth}px; --graph-sidebar-width: {graphSidebarWidth}px"
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
  ontouchcancel={handleTouchEnd}
>
  <!-- Drawer -->
  <aside bind:this={drawer} class="notes-drawer" aria-hidden={!drawerOpen}>
    <div class="sidebar-header">
      <div class="sidebar-brand">
        <button class="brand-emoji" onclick={cycleFruit}>{brandFruit}</button>
        <button class="brand-text" onclick={handleBrandClick}>Stonefruit{#if import.meta.env.DEV}<span class="dev-badge">DEV</span>{/if}</button>
      </div>
      <div class="sidebar-header-actions">
        <button
          class="sidebar-settings-btn"
          aria-label="Settings"
          onclick={async () => {
            if (!SettingsScreen) {
              SettingsScreen = (await import('./SettingsScreen.svelte')).default;
            }
            settingsOpen = true;
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        {#if !isMobile}
          <button class="sidebar-collapse-btn" aria-label="Collapse sidebar"
            onclick={() => { toggleSidebar(true); }}>
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
      <button class="search-button" onclick={() => { void openSearch(); }}>
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
        {notes}
        selectedId={noteId !== 'new' ? noteId : null}
        onselect={handleNoteSelect}
      />
    {:else if sidebarView === 'images'}
      <SidebarImageView />
    {:else}
      <VirtualList
        items={notes}
        selectedId={noteId !== 'new' ? noteId : null}
        onselect={handleNoteSelect}
        {isDragging}
      />
    {/if}
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
            bind:value={title}
            oninput={handleTitleInput}
            onkeydown={handleTitleKeydown}
            onfocus={handleTitleFocus}
            onpointerdown={handleTitlePointerDown}
            maxlength={200}
            enterkeyhint="done"
            bind:this={titleTextarea}
          ></textarea>
          {#if titleWarning}
            <div class="text-xs pt-0.5" style="color: var(--color-danger)">{titleWarning}</div>
          {/if}
        </div>
        <NoteTagBar
          {content}
          getEditorView={() => editor?.getView() ?? null}
          {notes}
        />
        <div class="editor-container">
          <MarkdownEditor
            bind:this={editor}
            {content}
            onchange={debouncedSave}
            oncursorcontext={(ctx) => { cursorOnListLine = ctx.onListLine; }}
            scrollParent={noteBody ?? null}
          />
        </div>
      {:else}
        <ForYouPage {notes} onbrowse={() => setDrawerOpen(true)} onquickcapture={createNewNote} />
      {/if}
    </div>
    {#if syncOffline}
      <div class="sync-indicator sync-offline">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="2" x2="22" y1="2" y2="22"/>
          <path d="M8.5 16.5a5 5 0 0 1 7 0"/>
          <path d="M2 8.82a15 15 0 0 1 4.17-2.65"/>
          <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/>
          <path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/>
          <path d="M5 12.86a10 10 0 0 1 5.17-2.86"/>
          <line x1="12" x2="12.01" y1="20" y2="20"/>
        </svg>
      </div>
    {:else if syncIndicatorVisible}
      <div class="sync-indicator">
        <svg class="sync-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
      </div>
    {/if}
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
  {#if graphSidebarOpen || graphLoading}
    {#if isMobile}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={graphOverlayEl}
        class="graph-overlay"
        class:active={graphSidebarOpen}
        onclick={closeGraphSidebar}
        onkeydown={(event) => handleDismissWindowKeydown(event, closeGraphSidebar)}
      ></div>
    {/if}
    <aside bind:this={graphSidebarEl} class="graph-sidebar" class:open={graphSidebarOpen}>
      {#if !isMobile}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="graph-resize-handle"
          onpointerdown={handleGraphResizeStart}
          onpointermove={handleGraphResizeMove}
          onpointerup={handleGraphResizeEnd}
          onpointercancel={handleGraphResizeEnd}
        ></div>
      {/if}
      <div class="graph-sidebar-header">
        <span class="graph-sidebar-title">Graph</span>
        <div class="graph-sidebar-actions">
          {#if graphData}
            <button class="graph-sidebar-expand" aria-label="Expand graph" onclick={openGraphFullscreen}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9"/>
                <polyline points="9 21 3 21 3 15"/>
                <line x1="21" y1="3" x2="14" y2="10"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            </button>
          {/if}
          <button class="graph-sidebar-close" aria-label="Close graph" onclick={closeGraphSidebar}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="graph-sidebar-body">
        {#if graphLoading}
          <div class="graph-loading">Computing graph layout...</div>
        {:else if graphData}
          <GraphCanvas data={graphData} currentNoteId={noteId} onNavigate={handleGraphNavigate} />
        {/if}
      </div>
    </aside>
  {/if}

  {#if graphFullscreenOpen && graphData}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="graph-fullscreen-backdrop"
      onclick={closeGraphFullscreen}
      onkeydown={(event) => handleDismissWindowKeydown(event, closeGraphFullscreen)}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <section class="graph-fullscreen" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
        <div class="graph-fullscreen-header">
          <div>
            <div class="graph-fullscreen-eyebrow">Semantic Map</div>
            <h2 class="graph-fullscreen-title">All Notes</h2>
          </div>
          <button class="graph-fullscreen-close" aria-label="Collapse graph" onclick={closeGraphFullscreen}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 3 3 3 3 9"/>
              <polyline points="15 21 21 21 21 15"/>
              <line x1="3" y1="3" x2="10" y2="10"/>
              <line x1="21" y1="21" x2="14" y2="14"/>
            </svg>
          </button>
        </div>
        <div class="graph-fullscreen-body">
          <GraphCanvas data={graphData} currentNoteId={noteId} onNavigate={handleGraphNavigate} />
        </div>
      </section>
    </div>
  {/if}
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

<script lang="ts">
  import { hasFileSystem, isMobile, isDesktop, isTauri } from '$lib/platform';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import MarkdownToolbar from './MarkdownToolbar.svelte';
  import SettingsScreen from './SettingsScreen.svelte';
  import SearchPopup from './SearchPopup.svelte';
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
  import { startAutoSync, stopAutoSync, notifySaved } from '$lib/autoSync';
  import { keyboard } from '$lib/keyboard.svelte';
  import { navigate } from '../router';
  import { SCROLL_TEST_NOTES } from '$lib/scrollTestNotes';
  import { getCachedPreferences } from '$lib/preferences';
  import { onToast } from '$lib/toast';

  import { clearGraphCache, type GraphData } from '$lib/supersearch/graphData';
  // Lazy-loaded: GraphCanvas component + graphData pipeline
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GraphCanvas: any = $state(null);

  const GFM_TEST_CONTENT = `# GFM Syntax Test Note

This note tests GitHub Flavored Markdown features commonly used by LLMs.

## ATX Headings (1-6 levels)

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

## Paragraphs and Line Breaks

This is a paragraph with
a soft line break (just a newline).

This paragraph ends with two spaces
to create a hard line break.

This paragraph ends with a backslash\\
to create a hard line break.

## Thematic Breaks

---

## Emphasis and Strong Emphasis

*italic text*

**bold text**

***bold and italic***

**bold with *nested italic* inside**

## Strikethrough (GFM Extension)

~~This text is struck through~~

~~strikethrough with **bold** inside~~

## Code Spans

Use \`inline code\` for short snippets.

Use \`\`backticks \` inside code\`\` with double backticks.

## Fenced Code Blocks

\`\`\`
Plain fenced code block
no language specified
\`\`\`

\`\`\`javascript
// With language identifier
function hello() {
  console.log("Hello, world!");
}
\`\`\`

\`\`\`python
# Python example
def hello():
    print("Hello, world!")
\`\`\`

## Block Quotes

> This is a block quote.
> It can span multiple lines.

> Block quotes can contain
>
> multiple paragraphs.

> Nested block quotes:
>
> > This is nested one level.
> >
> > > This is nested two levels.

> Block quotes can contain other elements:
>
> - Lists
> - **Bold text**
> - \`code\`

## Lists

### Unordered Lists

- Item one
- Item two
  - Nested item
  - Another nested item
    - Deeply nested

### Ordered Lists

1. First item
2. Second item
3. Third item
   1. Nested ordered
   2. Another nested

### Mixed Lists

1. Ordered item
   - Unordered nested
   - Another unordered
2. Back to ordered
   1. Nested ordered
   2. Another nested

### Loose vs Tight Lists

- Tight list item 1
- Tight list item 2
- Tight list item 3

- Loose list item 1

- Loose list item 2

- Loose list item 3

## Task Lists (GFM Extension)

- [x] Completed task
- [x] Another completed task
- [ ] Incomplete task
- [ ] Another incomplete task

1. [x] Ordered task list
2. [ ] Also works with numbers

## Links

[Basic link](https://example.com)

[Link with *emphasis*](https://example.com)

## Images

![Alt text](https://futo.org/images/authors/futologo.png "Image Title")

## Tables (GFM Extension)

| Left | Center | Right |
|:-----|:------:|------:|
| L1   |   C1   |    R1 |
| L2   |   C2   |    R2 |
| L3   |   C3   |    R3 |

Minimal table:

| Foo | Bar |
| --- | --- |
| Baz | Qux |

Table with inline formatting:

| Feature | Supported |
|---------|-----------|
| **Bold** | Yes |
| *Italic* | Yes |
| \`Code\` | Yes |
| ~~Strike~~ | Yes |
| [Links](https://example.com) | Yes |

Escaped pipes:

| Expression | Result |
|------------|--------|
| \`a \\| b\` | a \\| b |

## Backslash Escapes

\\*not italic\\*

\\\`not code\\\`

\\# not a heading

\\[not a link\\](https://example.com)

\\- not a list item

\\| not \\| a \\| table \\|

## Edge Cases

### Nested Formatting

**bold *bold-italic* bold**

*italic **italic-bold** italic*

### Code in Lists

- Item with \`inline code\`
- Item with block:
  \`\`\`
  code block in list
  \`\`\`

### Links in Tables

| Name | Link |
|------|------|
| Example | [Click](https://example.com) |

### Wide Tables

| Short | This is a very long cell that contains a lot of text to test how tables handle overflow |
|-------|-----------------------------------------------------------------------------------------|
| A     | B                                                                                       |

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 | 6 | 7 |
`;

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

  let sidebarView: 'notes' | 'tags' = $state((typeof localStorage !== 'undefined' && localStorage.getItem('futo-notes:sidebarView') as 'notes' | 'tags') || 'notes');
  let drawerWidth = $state(0);
  let saveTimeout: number | null = null;
  let saveInFlight: Promise<void> | null = null;
  let saveQueued = false;
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
  const recentWrites = new Map<string, number>();
  const recentSyncWrites = new Map<string, number>();
  const recentRemoteRenames = new Map<string, { toId: string; ts: number }>();
  let externalRescanTimer: number | null = null;
  let externalRescanInFlight = false;
  let externalRescanQueued = false;

  let syncWriteActive = false;
  let pendingWatcherEvents: Array<{ type: 'add' | 'change' | 'unlink'; filename: string }> = [];
  let postSyncBatchTimer: number | null = null;
  let watcherBatchTimer: number | null = null;
  let watcherHandlerInFlight = false;
  let watcherHandlerQueue: Array<{ type: 'add' | 'change' | 'unlink'; filename: string }> = [];

  let syncStatusMessage = $state('');
  let syncStatusClearTimer: number | null = null;

  function recordWrite(filename: string): void {
    recentWrites.set(filename, Date.now());
    // Clean old entries
    for (const [key, ts] of recentWrites) {
      if (Date.now() - ts > 2000) recentWrites.delete(key);
    }
  }

  function isRecentWrite(filename: string): boolean {
    const ts = recentWrites.get(filename);
    return ts !== undefined && Date.now() - ts < 1000;
  }

  function recordSyncWrite(filename: string): void {
    recentSyncWrites.set(filename, Date.now());
    for (const [key, ts] of recentSyncWrites) {
      if (Date.now() - ts > 5000) recentSyncWrites.delete(key);
    }
  }

  function isRecentSyncWrite(filename: string): boolean {
    const ts = recentSyncWrites.get(filename);
    return ts !== undefined && Date.now() - ts < 5000;
  }

  function recordRemoteRename(fromId: string, toId: string): void {
    recentRemoteRenames.set(fromId, { toId, ts: Date.now() });
    for (const [key, value] of recentRemoteRenames) {
      if (Date.now() - value.ts > 5000) recentRemoteRenames.delete(key);
    }
  }

  function getRecentRemoteRename(id: string): { toId: string; ts: number } | null {
    const entry = recentRemoteRenames.get(id);
    if (!entry) return null;
    if (Date.now() - entry.ts > 5000) {
      recentRemoteRenames.delete(id);
      return null;
    }
    return entry;
  }


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
      const { hasUpdate, capabilities } = await checkForUpdate(prefs.sync.serverUrl, prefs.sync.token);
      if (hasUpdate && capabilities) {
        const downloaded = await downloadArtifact(prefs.sync.serverUrl, prefs.sync.token, capabilities);
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
    for (const id of summary.updatedIds) recordSyncWrite(`${id}.md`);
    for (const id of summary.deletedIds) recordSyncWrite(`${id}.md`);
    for (const rename of summary.renamed) {
      recordSyncWrite(`${rename.fromId}.md`);
      recordSyncWrite(`${rename.toId}.md`);
      recordRemoteRename(rename.fromId, rename.toId);
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
          // If the user typed while sync was in flight, keep local editing state.
          if (editor?.hasFocus() && (saveTimeout !== null || saveInFlight !== null || saveQueued)) return;
          content = freshContent;
          suppressSaveOnChange = true;
          editor?.setContent(freshContent, { preserveSelection: true });
          suppressSaveOnChange = false;
        }
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
      syncStatusMessage = `Synced ${totalChanges} notes`;
      syncStatusClearTimer = window.setTimeout(() => { syncStatusMessage = ''; syncStatusClearTimer = null; }, 3000);
    } else {
      syncStatusMessage = '';
    }

  }

  function enqueueWatcherEvent(event: { type: 'add' | 'change' | 'unlink'; filename: string }): void {
    if (syncWriteActive) {
      pendingWatcherEvents.push(event);
      return;
    }
    watcherHandlerQueue.push(event);
    if (watcherBatchTimer === null) {
      watcherBatchTimer = window.setTimeout(() => {
        watcherBatchTimer = null;
        void processWatcherBatch();
      }, 50);
    }
  }

  async function processWatcherBatch(): Promise<void> {
    if (watcherHandlerInFlight) return;
    watcherHandlerInFlight = true;
    try {
      while (watcherHandlerQueue.length > 0) {
        const batch = watcherHandlerQueue.splice(0);
        // Deduplicate: keep last event per filename
        const deduped = new Map<string, { type: 'add' | 'change' | 'unlink'; filename: string }>();
        for (const ev of batch) {
          deduped.set(ev.filename, ev);
        }
        const events = [...deduped.values()];

        if (events.length > 10) {
          // Bulk: single refresh instead of per-file processing
          await refreshNotesFromStorage();
          refreshNotesList();
          // Handle active note if affected
          const activeFilename = originalId ? `${originalId}.md` : null;
          if (activeFilename) {
            const activeEvent = deduped.get(activeFilename);
            if (activeEvent) {
              await handleSingleWatcherEvent(activeEvent);
            }
          }
        } else {
          for (const ev of events) {
            await handleSingleWatcherEvent(ev);
          }
        }
      }
    } finally {
      watcherHandlerInFlight = false;
    }
  }

  function drainPostSyncWatcherBatch(): void {
    postSyncBatchTimer = window.setTimeout(() => {
      postSyncBatchTimer = null;
      // Filter out events that were caused by our own sync writes
      const unhandled = pendingWatcherEvents.filter(ev => !isRecentSyncWrite(ev.filename));
      pendingWatcherEvents = [];
      if (unhandled.length > 0) {
        // Queue a single refresh rather than per-file handling
        refreshNotesFromStorage().then(() => refreshNotesList());
        // Handle active note if affected
        const activeFilename = originalId ? `${originalId}.md` : null;
        if (activeFilename) {
          const activeEvent = unhandled.find(ev => ev.filename === activeFilename);
          if (activeEvent) {
            void handleSingleWatcherEvent(activeEvent);
          }
        }
      }
    }, 500);
  }

  async function handleSingleWatcherEvent(event: { type: 'add' | 'change' | 'unlink'; filename: string }): Promise<void> {
    const { type, filename } = event;
    if (!filename.endsWith('.md')) return;
    if (isRecentSyncWrite(filename)) return;
    if (isRecentWrite(filename)) return;

    const id = filename.replace(/\.md$/, '');
    if (type === 'unlink' && getRecentRemoteRename(id)) return;
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
    clearGraphCache();
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
    const noteTitle = 'Markdown test note';
    await createNote(sanitizeFilename(noteTitle), GFM_TEST_CONTENT);
    // Also create scroll test notes for performance testing
    for (const note of SCROLL_TEST_NOTES) {
      await createNote(sanitizeFilename(note.title), note.content);
    }
    refreshNotesList();
  }

  let suppressSaveOnChange = false;

  function debouncedSave(): void {
    if (suppressSaveOnChange || loading || !hasFileSystem || !editor || noteId === null) return;
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

      // Block saving if another note already has this name
      if (hasDuplicateTitle(newTitle)) return false;

      const savedOriginalId = originalId;
      if (savedOriginalId) {
        // Mark rename source/target before disk writes to suppress our own watcher events.
        recordWrite(`${savedOriginalId}.md`);
        if (savedOriginalId !== newId) {
          recordWrite(`${newId}.md`);
        }
      }

      const result = await updateNote(newId, newTitle, newContent, savedOriginalId ?? undefined);

      // Track write for file-watcher self-suppression
      recordWrite(`${result.id}.md`);
      if (savedOriginalId && savedOriginalId !== result.id) {
        recordWrite(`${savedOriginalId}.md`); // unlink event from rename
      }

      originalId = result.id;
      content = newContent;
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
    recordWrite(`${idToDelete}.md`);
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
      graphData = await computeGraphData(notes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no chunks') || msg.includes('Need at least')) {
        showToast('Not enough notes indexed for graph');
      } else {
        showToast('Sync required for graph view');
      }
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
    if (hasFileSystem && !notesLoaded) {
      refreshNotesList();
      notesLoaded = true;
    }
    registerBackSwipeHandler();
    updateDrawerMetrics();

    // Auto-sync
    startAutoSync({
      onSyncComplete: handleSyncComplete,
      onSyncError: (err) => console.warn('Auto-sync error:', err),
      flushPendingSave: flushSave,
      onSupersearchReady: () => { void checkSupersearchArtifacts(true); },
      shouldDeferSync: () => saveTimeout !== null || saveInFlight !== null || saveQueued || Boolean(editor?.isComposing?.()) || Boolean(editor?.hasFocus()),
      onSyncStateChange: (active) => {
        syncWriteActive = active;
        if (active) {
          if (syncStatusClearTimer !== null) { clearTimeout(syncStatusClearTimer); syncStatusClearTimer = null; }
          syncStatusMessage = 'Syncing...';
        }
        if (!active) drainPostSyncWatcherBatch();
      },
    });

    // Desktop sidebar: load persisted width
    if (isDesktop) {
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
          if (action === 'toggle-sidebar') sidebarCollapsed = !sidebarCollapsed;
          else if (action === 'new-note') void createNewNote();
        }));

        cleanupNativeListeners.push(onFileChange((event) => {
          enqueueWatcherEvent(event);
        }));
      });
    }

    // Global keyboard shortcuts
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    function handleGlobalShortcut(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      if (e.key === 'p') {
        e.preventDefault();
        searchOpen = true;
      } else if (e.key === 'n') {
        e.preventDefault();
        createNewNote();
      }
    }
    window.addEventListener('keydown', handleGlobalShortcut);

    return () => {
      stopAutoSync();
      flushSave();
      if (externalRescanTimer !== null) {
        clearTimeout(externalRescanTimer);
        externalRescanTimer = null;
      }
      if (watcherBatchTimer !== null) {
        clearTimeout(watcherBatchTimer);
        watcherBatchTimer = null;
      }
      if (postSyncBatchTimer !== null) {
        clearTimeout(postSyncBatchTimer);
        postSyncBatchTimer = null;
      }
      if (syncStatusClearTimer !== null) {
        clearTimeout(syncStatusClearTimer);
        syncStatusClearTimer = null;
      }
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
      <button
        class="sidebar-settings-btn"
        aria-label="Settings"
        onclick={() => { settingsOpen = true; }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    </div>
    <div class="drawer-search-area">
      <button class="search-button" onclick={() => { searchOpen = true; }}>
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
    </div>
    {#if syncStatusMessage}
      <div class="sync-status-banner">
        {#if syncStatusMessage === 'Syncing...'}
          <svg class="sync-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
        {/if}
        {syncStatusMessage}
      </div>
    {/if}
    {#if sidebarView === 'tags'}
      <SidebarTagView
        {notes}
        selectedId={noteId !== 'new' ? noteId : null}
        onselect={handleNoteSelect}
      />
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
    <!-- Overlay replaces filter: brightness/contrast for GPU-composited dimming -->
    <div
      bind:this={overlayEl}
      class="drawer-overlay"
      class:active={isMobile && drawerOpen}
      style="opacity: {overlayOpacity}"
      onclick={() => setDrawerOpen(false)}
    ></div>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="note-body" bind:this={noteBody} onclick={handleNoteBodyClick} onfocusin={() => editorFocused = true} onfocusout={handleEditorFocusOut}>
      {#if noteId}
        <div class="note-title-row">
          <textarea
            rows="1"
            class="title-input w-full border-none bg-transparent p-0 focus:outline-none"
            style="font-family: var(--font-serif); font-size: 30px; font-weight: 400; line-height: 1.2; letter-spacing: -0.01em; color: var(--color-text); resize: none; overflow: hidden; min-height: 36px;"
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
  </div>

  {#if isMobile}
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

{#if settingsOpen}
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

{#if searchOpen}
  <SearchPopup onclose={() => { searchOpen = false; }} onselect={handleSearchSelect} />
{/if}

{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}

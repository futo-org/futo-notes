<script lang="ts">
  import { hasFileSystem, isMobile, isElectron, isCapacitor } from '$lib/platform';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import MarkdownToolbar from './MarkdownToolbar.svelte';
  import SettingsScreen from './SettingsScreen.svelte';
  import SearchPopup from './SearchPopup.svelte';
  import VirtualList from './VirtualList.svelte';
  import type { NotePreview } from '../types';
  import { getAllNotes, updateNote, readNote, createNote, getNoteById, deleteNote, handleExternalFileChange } from '$lib/notes';
  import { sanitizeFilename } from '$lib/utils';
  import { FORBIDDEN_CHARS_RE, validateTitle } from '@futo-notes/shared';
  import type { SyncSummary } from '$lib/sync';
  import { trackOpen } from '$lib/engagement';
  import ForYouPage from './ForYouPage.svelte';
  import { startAutoSync, stopAutoSync, notifySaved } from '$lib/autoSync';
  import { keyboard } from '$lib/keyboard.svelte';
  import { navigate } from '../router';
  import { SCROLL_TEST_NOTES } from '$lib/scrollTestNotes';
  import { getCachedPreferences } from '$lib/preferences';

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

  interface DrawerBackPlugin {
    setDrawerOpen(options: { open: boolean }): Promise<void>;
  }

  let DrawerBack: DrawerBackPlugin | null = null;
  if (isMobile) {
    import('@capacitor/core').then(({ registerPlugin }) => {
      DrawerBack = registerPlugin<DrawerBackPlugin>('DrawerBack');
    });
  }

  interface Props {
    noteId: string | null;
  }

  let { noteId }: Props = $props();

  let drawerOpen = $state(!isMobile);
  let drawerProgress = $state(!isMobile ? 1 : 0);
  let title = $state('');
  let content = $state('');
  let originalId: string | null = $state(null);
  let notes: NotePreview[] = $state([]);

  let editor: ReturnType<typeof MarkdownEditor> | null = $state(null);
  let editorFocused = $state(false);
  let toolbarTouching = $state(false);
  let shell: HTMLElement | undefined = $state(undefined);
  let drawer: HTMLElement | undefined = $state(undefined);
  let noteBody: HTMLElement | undefined = $state(undefined);

  let drawerWidth = $state(0);
  let saveTimeout: number | null = null;
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

  // File watcher self-write suppression (Electron only)
  const recentWrites = new Map<string, number>();
  const recentSyncWrites = new Map<string, number>();

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


  // Toast
  let toastMessage = $state('');
  let toastTimer: number | null = null;

  function showToast(message: string): void {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastMessage = message;
    toastTimer = window.setTimeout(() => { toastMessage = ''; toastTimer = null; }, 3000);
  }

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

    const hasRemoteNoteChanges = summary.updatedIds.length > 0 || summary.deletedIds.length > 0;
    for (const id of summary.updatedIds) recordSyncWrite(`${id}.md`);
    for (const id of summary.deletedIds) recordSyncWrite(`${id}.md`);
    if (hasRemoteNoteChanges) {
      refreshNotesList();
    }

    // Check once after first sync, then on remote note changes (throttled).
    if (lastArtifactCheckAt === 0 || hasRemoteNoteChanges) {
      void checkSupersearchArtifacts();
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
          if (editor?.hasFocus() && saveTimeout !== null) return;
          content = freshContent;
          suppressSaveOnChange = true;
          editor?.setContent(freshContent);
          suppressSaveOnChange = false;
        }
        const meta = getNoteById(originalId);
        if (meta) title = meta.title;
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
    if (!isMobile || !DrawerBack) return;
    try {
      await DrawerBack.setDrawerOpen({ open });
    } catch {
      // Plugin not available in web/dev builds
    }
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
  }

  function handleNoteSelect(id: string): void {
    if (isMobile) setDrawerOpen(false);
    navigate(`/note/${encodeURIComponent(id)}`);
  }

  async function createNewNote(): Promise<void> {
    if (isCapacitor) {
      import('@capacitor/haptics').then(({ Haptics, ImpactStyle }) =>
        Haptics.impact({ style: ImpactStyle.Light })
      ).catch(() => {});
    }
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
      void saveNote().then(() => notifySaved());
    }, 500);
  }

  async function flushSave(): Promise<void> {
    if (saveTimeout === null) return;
    clearTimeout(saveTimeout);
    saveTimeout = null;
    try {
      await saveNote();
    } catch (e) {
      console.warn('Failed to flush note save:', e);
    }
  }

  async function saveNote(): Promise<void> {
    if (!hasFileSystem || !editor || noteId === null) return;
    try {
      const newTitle = title.trim() || 'Untitled';
      const newId = sanitizeFilename(newTitle);
      const newContent = editor.getContent();

      // Don't save empty new notes — nothing worth persisting yet,
      // and the save→navigate cycle can crash certain Android IME/WebView combos.
      if (!originalId && !newContent.trim() && newTitle === 'Untitled') return;

      // Block saving if another note already has this name
      if (hasDuplicateTitle(newTitle)) return;

      const savedOriginalId = originalId;

      const result = await updateNote(newId, newTitle, newContent, originalId ?? undefined);

      // Track write for file-watcher self-suppression
      recordWrite(`${result.id}.md`);
      if (savedOriginalId && savedOriginalId !== result.id) {
        recordWrite(`${savedOriginalId}.md`); // unlink event from rename
      }

      originalId = result.id;

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
    } catch (e) {
      console.warn('Failed to save note:', e);
    }
  }

  function hasDuplicateTitle(checkTitle: string): boolean {
    const checkId = sanitizeFilename(checkTitle.trim() || 'Untitled');
    return notes.some(n => n.id === checkId && n.id !== originalId);
  }

  function handleTitleInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const cleaned = input.value.replace(FORBIDDEN_CHARS_RE, '');
    if (cleaned !== input.value) {
      const pos = input.selectionStart ?? cleaned.length;
      title = cleaned;
      requestAnimationFrame(() => {
        input.setSelectionRange(pos - 1, pos - 1);
      });
      showTitleWarning("That character can't be used in a note title", 2000);
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

  function selectAllTitleText(input: HTMLInputElement): void {
    input.setSelectionRange(0, input.value.length);
    requestAnimationFrame(() => {
      input.setSelectionRange(0, input.value.length);
    });
  }

  function handleTitleFocus(event: FocusEvent): void {
    const input = event.currentTarget as HTMLInputElement;
    if (shouldAutoSelectUntitledTitle(input.value)) {
      selectAllTitleText(input);
    }
  }

  function handleTitlePointerDown(event: PointerEvent): void {
    const input = event.currentTarget as HTMLInputElement;
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
    originalId = null;
    await deleteNote(idToDelete);
    refreshNotesList();
    navigate('/');
    showToast('Note deleted');
  }

  function isSwipeExcludedTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest('.cm-md-table-wrapper, .cm-md-table-rendered, .cm-md-table, .markdown-toolbar, .title-input')
    );
  }

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
    updateDrawerMetrics();
    startProgress = drawerOpen ? 1 : 0;
    dragProgress = startProgress;
    setDrawerProgress(startProgress);
  }

  function handleTouchMove(event: TouchEvent): void {
    if (ignoreSwipe || !tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (!isDragging && Math.abs(deltaX) < Math.abs(deltaY)) return;

    // When closing (drawer open), prevent list scroll as soon as horizontal intent is clear
    if (startProgress > 0 && Math.abs(deltaX) > Math.abs(deltaY)) {
      event.preventDefault();
    }

    if (!isDragging && Math.abs(deltaX) < 5) return;

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

  function handleTouchEnd(): void {
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

      // Snap to open or closed on next frame
      const velocityThreshold = 0.5; // px/ms
      const shouldOpen = Math.abs(velocity) > velocityThreshold ? velocity > 0 : drawerProgress >= 0.3;
      requestAnimationFrame(() => {
        setDrawerOpen(shouldOpen);
      });
    }
    tracking = false;
    isDragging = false;
    ignoreSwipe = false;
    velocity = 0;
  }

  function registerBackSwipeHandler(): void {
    const win = window as typeof window & { __toggleNotesDrawer?: () => void };
    win.__toggleNotesDrawer = () => setDrawerOpen(!drawerOpen);
  }

  async function loadNote(id: string | null): Promise<void> {
    await flushSave();
    noteMenuOpen = false;
    deleteConfirmOpen = false;

    loading = true;

    if (!id) {
      title = '';
      content = '';
      originalId = null;
      loading = false;
      return;
    }

    originalId = id !== 'new' ? id : null;

    if (id === 'new') {
      title = getNextUntitledTitle();
      content = '';
      editor?.setContent('');
      loading = false;
      requestAnimationFrame(() => {
        editor?.focus();
      });
    } else if (hasFileSystem) {
      try {
        content = await readNote(id);
        const meta = getNoteById(id);
        title = meta?.title || id;
        editor?.setContent(content);
        trackOpen(id);
      } catch {
        // File doesn't exist — remove stale cache entry so it disappears from sidebar
        handleExternalFileChange('unlink', `${id}.md`);
        refreshNotesList();
        loading = false;
        navigate('/');
        return;
      }
      loading = false;
    }
  }

  // Toolbar height constant (matches .markdown-toolbar height in components.css)
  const TOOLBAR_HEIGHT = 44;

  // Total bottom inset when keyboard is visible: keyboard + toolbar
  const keyboardInset = $derived(keyboard.visible ? keyboard.height + TOOLBAR_HEIGHT : 0);

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
      shouldDeferSync: () => saveTimeout !== null || Boolean(editor?.isComposing?.()),
    });

    // Desktop sidebar: load persisted width
    if (!isMobile) {
      if (isElectron) {
        import('$lib/platform/electron').then(({ getConfig }) => {
          getConfig().then(cfg => {
            if (cfg.sidebarWidth) sidebarWidth = cfg.sidebarWidth;
          });
        });
      } else {
        const stored = localStorage.getItem('futo-notes:sidebarWidth');
        if (stored) sidebarWidth = parseInt(stored, 10) || 280;
      }
    }

    // Electron menu actions + file watcher
    let cleanupFileWatcher: (() => void) | null = null;
    if (isElectron) {
      import('$lib/platform/electron').then(({ onMenuAction, onFileChange }) => {
        onMenuAction((action) => {
          if (action === 'toggle-sidebar') sidebarCollapsed = !sidebarCollapsed;
          else if (action === 'new-note') createNewNote();
        });

        cleanupFileWatcher = onFileChange(async (event) => {
          const { type, filename } = event;
          if (!filename.endsWith('.md')) return;
          if (isRecentSyncWrite(filename)) return;
          if (isRecentWrite(filename)) return;

          const id = filename.replace(/\.md$/, '');

          if (type === 'unlink' && id === originalId) {
            // Current note was deleted externally
            if (saveTimeout !== null) { clearTimeout(saveTimeout); saveTimeout = null; }
            originalId = null;
            navigate('/');
            showToast('Note was deleted externally');
          } else if (type === 'change' && id === originalId) {
            // Current note was changed externally — reload from disk
            if (saveTimeout !== null) { clearTimeout(saveTimeout); saveTimeout = null; }
            try {
              const freshContent = await readNote(id);
              content = freshContent;
              suppressSaveOnChange = true;
              editor?.setContent(freshContent);
              suppressSaveOnChange = false;
              const meta = getNoteById(id);
              if (meta) title = meta.title;
            } catch { /* ignore read errors */ }
          }

          await handleExternalFileChange(type as 'add' | 'change' | 'unlink', filename);
          refreshNotesList();

          // Trigger sync so externally-added files are uploaded to server
          if (type === 'add' || type === 'change') {
            notifySaved();
          }
        });
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
      cleanupFileWatcher?.();
      window.removeEventListener('keydown', handleGlobalShortcut);
    };
  });

  let prevNoteId: string | null | undefined = undefined;

  $effect(() => {
    const currentNoteId = noteId;
    if (prevNoteId !== currentNoteId) {
      prevNoteId = currentNoteId;
      loadNote(currentNoteId);
    }
  });

  const drawerOffset = $derived(drawerProgress * drawerWidth);
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
    if (isElectron) {
      import('$lib/platform/electron').then(({ saveElectronConfig }) => {
        saveElectronConfig({ sidebarWidth: width });
      });
    } else {
      localStorage.setItem('futo-notes:sidebarWidth', String(width));
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
  class:drawer-open={drawerOpen}
  class:drawer-dragging={isDragging}
  style="--drawer-offset: {drawerOffset}px; --sidebar-width: {sidebarWidth}px"
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
  ontouchcancel={handleTouchEnd}
>
  <!-- Drawer -->
  <aside bind:this={drawer} class="notes-drawer" aria-hidden={!drawerOpen}>
    <div class="sidebar-header">
      <button class="sidebar-brand" onclick={() => navigate('/')}>FUTO Notes</button>
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
    <VirtualList
      items={notes}
      selectedId={noteId !== 'new' ? noteId : null}
      onselect={handleNoteSelect}
      {isDragging}
    />
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
          <button onclick={() => { noteMenuOpen = false; deleteConfirmOpen = true; }}>Delete note</button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <!-- Main content -->
  <div bind:this={noteMainEl} class="note-main" style:bottom={keyboardInset > 0 ? `${keyboardInset}px` : undefined} onclick={() => { if (isMobile && drawerOpen) setDrawerOpen(false); }}>
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
          <input
            type="text"
            class="title-input w-full border-none bg-transparent p-0 focus:outline-none"
            style="font-family: var(--font-serif); font-size: 30px; font-weight: 400; line-height: 1.2; letter-spacing: -0.01em; color: var(--color-text);"
            placeholder="Untitled"
            bind:value={title}
            oninput={handleTitleInput}
            onkeydown={handleTitleKeydown}
            onfocus={handleTitleFocus}
            onpointerdown={handleTitlePointerDown}
            maxlength={200}
          />
          {#if titleWarning}
            <div class="text-xs pt-0.5" style="color: var(--color-danger)">{titleWarning}</div>
          {/if}
        </div>
        <div class="editor-container">
          <MarkdownEditor
            bind:this={editor}
            {content}
            onchange={debouncedSave}
            scrollParent={noteBody ?? null}
          />
        </div>
      {:else}
        <ForYouPage onbrowse={() => setDrawerOpen(true)} />
      {/if}
    </div>
  </div>

  {#if isMobile}
    <MarkdownToolbar
      getView={() => editor?.getView() ?? null}
      {editorFocused}
      ontoolbartouch={(touching) => toolbarTouching = touching}
    />
  {/if}
</div>

{#if settingsOpen}
  <SettingsScreen
    onclose={() => { settingsOpen = false; }}
    onimported={handleImported}
    onsynccomplete={handleSyncComplete}
  />
{/if}

{#if deleteConfirmOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="delete-confirm-overlay" onclick={() => { deleteConfirmOpen = false; }}>
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="delete-confirm-dialog" onclick={(e) => e.stopPropagation()}>
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

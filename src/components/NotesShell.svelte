<script lang="ts">
  import { Capacitor, registerPlugin } from '@capacitor/core';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import VirtualList from './VirtualList.svelte';
  import type { NotePreview } from '../types';
  import { getAllNotes, updateNote, readNote, createNote, getNoteById } from '$lib/notes';
  import { sanitizeFilename } from '$lib/utils';
  import { router } from '../router';

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

  const DrawerBack = registerPlugin<DrawerBackPlugin>('DrawerBack');
  const isNative = Capacitor.isNativePlatform();

  // Props
  interface Props {
    noteId: string | null;
  }

  let { noteId }: Props = $props();

  // State
  let drawerOpen = $state(false);
  let drawerProgress = $state(0);
  let title = $state('');
  let content = $state('');
  let originalId: string | null = $state(null);
  let notes: NotePreview[] = $state([]);

  // Refs
  let editor: ReturnType<typeof MarkdownEditor> | null = $state(null);
  let shell: HTMLElement | undefined = $state(undefined);
  let drawer: HTMLElement | undefined = $state(undefined);

  // Internal state
  let drawerWidth = $state(0);
  let saveTimeout: number | null = null;
  let notesLoaded = false;

  // Touch tracking for edge swipe
  let tracking = false;
  let isDragging = $state(false);
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let ignoreSwipe = false;
  let startProgress = 0;

  // FAB long-press tracking
  let fabPressTimer: number | null = null;
  let ignoreFabClick = false;

  // Update drawer metrics
  function updateDrawerMetrics(): void {
    if (drawer) {
      drawerWidth = drawer.getBoundingClientRect().width || 1;
    }
  }

  // Set drawer open state with animation
  function setDrawerOpen(open: boolean): void {
    drawerOpen = open;
    if (open && shell) {
      title; // access to blur
      editor?.blur();
    }
    setDrawerProgress(open ? 1 : 0, true);
    void updateNativeDrawerState(open);
  }

  // Set drawer progress (0-1)
  function setDrawerProgress(progress: number, snap: boolean = false): void {
    drawerProgress = Math.min(1, Math.max(0, progress));
    if (drawerProgress > 0) {
      editor?.blur();
    }
    if (snap) {
      isDragging = false;
    }
  }

  // Update native drawer state
  async function updateNativeDrawerState(open: boolean): Promise<void> {
    if (!isNative) return;
    try {
      await DrawerBack.setDrawerOpen({ open });
    } catch {
      // Plugin not available in web/dev builds
    }
  }

  // Refresh notes list from storage
  function refreshNotesList(): void {
    notes = isNative ? getAllNotes() : [];
  }

  // Handle note selection from list
  function handleNoteSelect(id: string): void {
    setDrawerOpen(false);
    router.navigate(`/note/${encodeURIComponent(id)}`);
  }

  // Create new note
  function createNewNote(): void {
    setDrawerOpen(false);
    router.navigate('/note/new');
  }

  // Create GFM test note (long-press)
  async function createTestNote(): Promise<void> {
    if (!isNative) return;
    const noteTitle = 'Markdown test note';
    await createNote(sanitizeFilename(noteTitle), GFM_TEST_CONTENT);
    refreshNotesList();
  }

  // Debounced save
  function debouncedSave(): void {
    if (!isNative || !editor || noteId === null) return;
    if (saveTimeout !== null) {
      clearTimeout(saveTimeout);
    }
    saveTimeout = window.setTimeout(saveNote, 500);
  }

  // Flush pending save
  async function flushSave(): Promise<void> {
    if (saveTimeout === null) return;
    clearTimeout(saveTimeout);
    saveTimeout = null;
    await saveNote();
  }

  // Save current note
  async function saveNote(): Promise<void> {
    if (!isNative || !editor || noteId === null) return;
    const newTitle = title.trim() || 'Untitled';
    const newId = sanitizeFilename(newTitle);
    const newContent = editor.getContent();

    const result = await updateNote(newId, newTitle, newContent, originalId ?? undefined);

    originalId = result.id;

    refreshNotesList();

    const expectedHash = `#/note/${encodeURIComponent(result.id)}`;
    if (window.location.hash !== expectedHash) {
      router.navigate(`/note/${encodeURIComponent(result.id)}`);
    }
  }

  // Handle editor container click
  function handleEditorContainerClick(event: MouseEvent): void {
    if (!editor || drawerOpen) return;
    const target = event.target as HTMLElement;
    if (target.classList.contains('editor-container') || target.classList.contains('cm-scroller')) {
      editor.focus();
    }
  }

  // FAB touch handlers
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

  // Edge swipe gesture handlers
  function isTableSwipeTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(
      target.closest('.cm-md-table-wrapper, .cm-md-table-rendered, .cm-md-table')
    );
  }

  function handleTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    if (isTableSwipeTarget(event.target)) {
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
    setDrawerProgress(startProgress);
  }

  function handleTouchMove(event: TouchEvent): void {
    if (ignoreSwipe || !tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (!isDragging && Math.abs(deltaX) < Math.abs(deltaY)) return;
    if (!isDragging && Math.abs(deltaX) < 5) return;

    if (!isDragging) {
      isDragging = true;
      editor?.blur();
    }

    // Track velocity
    const now = Date.now();
    const dt = now - lastTime;
    if (dt > 0) {
      velocity = (touch.clientX - lastX) / dt;
    }
    lastX = touch.clientX;
    lastTime = now;

    const nextProgress = startProgress + deltaX / drawerWidth;
    setDrawerProgress(nextProgress);
    event.preventDefault();
  }

  function handleTouchEnd(): void {
    if (isDragging) {
      isDragging = false;
      // Use velocity for quick flicks, or position for slow drags
      const velocityThreshold = 0.5; // px/ms
      if (Math.abs(velocity) > velocityThreshold) {
        // Quick flick - use direction
        setDrawerOpen(velocity > 0);
      } else {
        // Slow drag - use position (30% threshold)
        setDrawerOpen(drawerProgress >= 0.3);
      }
    }
    tracking = false;
    isDragging = false;
    ignoreSwipe = false;
    velocity = 0;
  }

  // Register back swipe handler
  function registerBackSwipeHandler(): void {
    const win = window as typeof window & { __toggleNotesDrawer?: () => void };
    win.__toggleNotesDrawer = () => setDrawerOpen(!drawerOpen);
  }

  // Load note content when noteId changes
  async function loadNote(id: string | null): Promise<void> {
    await flushSave();

    if (!id) {
      title = '';
      content = '';
      originalId = null;
      return;
    }

    originalId = id !== 'new' ? id : null;

    if (id === 'new') {
      title = '';
      content = '';
      // Focus editor after it mounts
      requestAnimationFrame(() => {
        editor?.focus();
      });
    } else if (isNative) {
      try {
        content = await readNote(id);
        const meta = getNoteById(id);
        title = meta?.title || id;
      } catch {
        router.navigate('/');
        return;
      }
    }
  }

  // Initialize on mount
  $effect(() => {
    if (isNative && !notesLoaded) {
      refreshNotesList();
      notesLoaded = true;
    }
    registerBackSwipeHandler();
    updateDrawerMetrics();

    return () => {
      flushSave();
    };
  });

  // Track previous noteId to detect changes
  let prevNoteId: string | null | undefined = undefined;

  // React to noteId changes
  $effect(() => {
    const currentNoteId = noteId;
    if (prevNoteId !== currentNoteId) {
      prevNoteId = currentNoteId;
      loadNote(currentNoteId);
    }
  });

  // Computed style values
  const drawerOffset = $derived(drawerProgress * drawerWidth);
  const drawerBgShade = $derived(Math.round(255 - drawerProgress * 24));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={shell}
  class="notes-shell"
  class:drawer-open={drawerOpen}
  class:drawer-dragging={isDragging}
  style="--drawer-offset: {drawerOffset}px; --drawer-bg: rgb({drawerBgShade}, {drawerBgShade}, {drawerBgShade})"
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
  ontouchcancel={handleTouchEnd}
>
  <!-- Overlay -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="drawer-overlay"
    style="pointer-events: {drawerProgress > 0 ? 'auto' : 'none'}"
    onclick={() => setDrawerOpen(false)}
    aria-hidden="true"
  ></div>

  <!-- Drawer -->
  <aside bind:this={drawer} class="notes-drawer" aria-hidden={!drawerOpen}>
    <VirtualList
      items={notes}
      selectedId={noteId !== 'new' ? noteId : null}
      onselect={handleNoteSelect}
    />
    <button
      class="fab"
      aria-label="New note"
      ontouchstart={handleFabTouchStart}
      ontouchend={handleFabTouchEnd}
      ontouchcancel={handleFabTouchCancel}
      onclick={handleFabClick}
    >+</button>
  </aside>

  <!-- Menu button -->
  <button
    class="drawer-toggle floating"
    aria-label="Open notes list"
    aria-expanded={drawerOpen}
    onclick={() => setDrawerOpen(!drawerOpen)}
  >&#9776;</button>

  <!-- Main content -->
  <div class="note-main">
    <div class="note-body">
      <div class="note-title-row">
        <input
          type="text"
          class="title-input"
          placeholder={noteId ? 'Untitled' : 'Select a note'}
          disabled={!noteId}
          bind:value={title}
          oninput={debouncedSave}
        />
      </div>

      {#if noteId}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="editor-container" onclick={handleEditorContainerClick}>
          <MarkdownEditor
            bind:this={editor}
            {content}
            onchange={debouncedSave}
          />
        </div>
      {:else}
        <div class="note-empty">
          <div class="note-empty-title">No note selected</div>
          <div class="note-empty-subtitle">Swipe from the left edge or tap the menu to browse notes.</div>
          <button class="note-empty-action" onclick={() => setDrawerOpen(true)}>Browse notes</button>
        </div>
      {/if}
    </div>
  </div>
</div>

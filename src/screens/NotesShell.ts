import { Capacitor, registerPlugin } from '@capacitor/core';
import { store } from '../store';
import { router } from '../router';
import {
  getAllNotes,
  updateNote,
  readNote,
  createNote
} from '../lib/notes';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { VirtualList } from '../components/VirtualList';
import { NotePreview } from '../types';
import { sanitizeFilename } from '../lib/utils';

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

let mounted = false;
let notesLoaded = false;
let editor: MarkdownEditor | null = null;
let virtualList: VirtualList | null = null;
let currentNoteId: string | null = null;
let originalId: string | null = null;
let saveTimeout: number | null = null;
let drawerOpen = false;
let drawerProgress = 0;
let drawerWidth = 0;

let shell: HTMLElement;
let drawer: HTMLElement;
let overlay: HTMLElement;
let listScrollContainer: HTMLElement;
let listContentContainer: HTMLElement;
let fab: HTMLButtonElement;
let menuBtn: HTMLButtonElement;
let titleInput: HTMLInputElement;
let editorContainer: HTMLElement;
let emptyState: HTMLElement;
let emptyOpenBtn: HTMLButtonElement;

const isNative = Capacitor.isNativePlatform();

interface DrawerBackPlugin {
  setDrawerOpen(options: { open: boolean }): Promise<void>;
}

const DrawerBack = registerPlugin<DrawerBackPlugin>('DrawerBack');

export async function renderNotesShell(params: { id?: string }): Promise<void> {
  if (!mounted) {
    mount();
  }

  if (!notesLoaded) {
    await refreshNotesList();
    notesLoaded = true;
  }

  const requestedId = params.id ?? null;
  await setCurrentNote(requestedId);
}

function mount(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div class="notes-shell">
      <div class="drawer-overlay" aria-hidden="true"></div>
      <aside class="notes-drawer" aria-hidden="true">
        <div class="notes-list-scroll">
          <div class="notes-list-content"></div>
        </div>
        <button class="fab" aria-label="New note">+</button>
      </aside>
      <button class="drawer-toggle floating" aria-label="Open notes list" aria-expanded="false">&#9776;</button>
      <div class="note-main">
        <div class="note-body">
          <div class="note-title-row">
            <input type="text" class="title-input" placeholder="Untitled" />
          </div>
          <div class="editor-container"></div>
          <div class="note-empty">
            <div class="note-empty-title">No note selected</div>
            <div class="note-empty-subtitle">Swipe from the left edge or tap the menu to browse notes.</div>
            <button class="note-empty-action">Browse notes</button>
          </div>
        </div>
      </div>
    </div>
  `;

  shell = app.querySelector('.notes-shell') as HTMLElement;
  drawer = app.querySelector('.notes-drawer') as HTMLElement;
  overlay = app.querySelector('.drawer-overlay') as HTMLElement;
  listScrollContainer = app.querySelector('.notes-list-scroll') as HTMLElement;
  listContentContainer = app.querySelector('.notes-list-content') as HTMLElement;
  fab = app.querySelector('.fab') as HTMLButtonElement;
  menuBtn = app.querySelector('.drawer-toggle') as HTMLButtonElement;
  titleInput = app.querySelector('.title-input') as HTMLInputElement;
  editorContainer = app.querySelector('.editor-container') as HTMLElement;
  emptyState = app.querySelector('.note-empty') as HTMLElement;
  emptyOpenBtn = app.querySelector('.note-empty-action') as HTMLButtonElement;

  // Initialize VirtualList for drawer
  virtualList = new VirtualList({
    scrollElement: listScrollContainer,
    contentElement: listContentContainer,
    rowHeight: 48,
    showPreview: false,
    onItemClick: handleListItemClick
  });

  fab.addEventListener('touchstart', handleFabTouchStart);
  fab.addEventListener('touchend', handleFabTouchEnd);
  fab.addEventListener('touchcancel', handleFabTouchCancel);
  fab.addEventListener('click', handleFabClick);
  menuBtn.addEventListener('click', () => setDrawerOpen(!drawerOpen));
  overlay.addEventListener('click', () => setDrawerOpen(false));
  emptyOpenBtn.addEventListener('click', () => setDrawerOpen(true));
  titleInput.addEventListener('input', debouncedSave);
  editorContainer.addEventListener('click', handleEditorContainerClick);

  setupEdgeSwipe();
  setEmptyState(true);
  registerBackSwipeHandler();
  updateDrawerMetrics();

  mounted = true;
}

function registerBackSwipeHandler(): void {
  const win = window as typeof window & { __toggleNotesDrawer?: () => void };
  win.__toggleNotesDrawer = () => setDrawerOpen(!drawerOpen);
}

function setDrawerOpen(open: boolean): void {
  drawerOpen = open;
  shell.classList.toggle('drawer-open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    titleInput.blur();
    editor?.blur();
  }
  setDrawerProgress(open ? 1 : 0, true);
  void updateNativeDrawerState(open);
}

function setDrawerProgress(progress: number, snap: boolean = false): void {
  drawerProgress = Math.min(1, Math.max(0, progress));
  const offset = drawerProgress * drawerWidth;
  shell.style.setProperty('--drawer-offset', `${offset}px`);
  const shade = Math.round(255 - drawerProgress * 24);
  shell.style.setProperty('--drawer-bg', `rgb(${shade}, ${shade}, ${shade})`);
  overlay.style.pointerEvents = drawerProgress > 0 ? 'auto' : 'none';
  if (drawerProgress > 0 && (document.activeElement === titleInput || editor?.hasFocus())) {
    titleInput.blur();
    editor?.blur();
  }
  if (snap) {
    shell.classList.remove('drawer-dragging');
  }
}

function updateDrawerMetrics(): void {
  drawerWidth = drawer.getBoundingClientRect().width || 1;
  shell.style.setProperty('--drawer-width', `${drawerWidth}px`);
  setDrawerProgress(drawerOpen ? 1 : 0, true);
}

async function updateNativeDrawerState(open: boolean): Promise<void> {
  if (!isNative) return;
  try {
    await DrawerBack.setDrawerOpen({ open });
  } catch {
    // Plugin not available in web/dev builds.
  }
}

function setEmptyState(isEmpty: boolean): void {
  shell.classList.toggle('note-empty-state', isEmpty);
  emptyState.style.display = isEmpty ? 'flex' : 'none';
  editorContainer.style.display = isEmpty ? 'none' : 'block';
  titleInput.disabled = isEmpty;
  titleInput.placeholder = isEmpty ? 'Select a note' : 'Untitled';
  if (isEmpty) {
    titleInput.value = '';
  }
}

function updateList(notesToRender: NotePreview[]): void {
  if (!virtualList) return;
  const selectedId = currentNoteId && currentNoteId !== 'new' ? currentNoteId : null;
  virtualList.setSelected(selectedId);
  virtualList.update(notesToRender);
}

function refreshNotesList(): void {
  const notes = isNative ? getAllNotes() : [];
  store.setState({ notes });
  updateList(notes);
}

function handleListItemClick(id: string): void {
  setDrawerOpen(false);
  router.navigate(`/note/${encodeURIComponent(id)}`);
}

function handleEditorContainerClick(event: Event): void {
  // Focus editor when clicking empty space in editor container
  if (!editor || drawerOpen) return;
  const target = event.target as HTMLElement;
  // Only focus if clicking directly on container, not on editor content
  if (target === editorContainer || target.classList.contains('cm-scroller')) {
    editor.focus();
  }
}

async function createTestNote(): Promise<void> {
  if (!isNative) return;
  const title = 'Markdown test note';
  await createNote(sanitizeFilename(title), GFM_TEST_CONTENT);
  refreshNotesList();
}

let fabPressTimer: number | null = null;
let ignoreFabClick = false;
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
    setDrawerOpen(false);
    router.navigate('/note/new');
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
  if (ignoreFabClick) {
    return;
  }
  if (fabPressTimer !== null) return;
  setDrawerOpen(false);
  router.navigate('/note/new');
}

async function setCurrentNote(noteId: string | null): Promise<void> {
  if (noteId === currentNoteId) return;
  await flushSave();

  if (editor) {
    editor.destroy();
    editor = null;
    editorContainer.innerHTML = '';
  }

  currentNoteId = noteId;
  originalId = noteId && noteId !== 'new' ? noteId : null;

  if (!noteId) {
    setEmptyState(true);
    virtualList?.setSelected(null);
    return;
  }

  setEmptyState(false);

  let content = '';
  let title = 'Untitled';
  if (noteId !== 'new' && isNative) {
    try {
      content = await readNote(noteId);
      const meta = store.getState().notes.find(note => note.id === noteId);
      title = meta?.title || noteId;
    } catch {
      router.navigate('/');
      return;
    }
  }

  titleInput.value = noteId === 'new' ? '' : title;

  editor = new MarkdownEditor(editorContainer, {
    initialContent: content,
    onChange: () => debouncedSave()
  });

  if (noteId === 'new') {
    editor.focus();
  } else {
    editor.blur();
    titleInput.blur();
  }

  virtualList?.setSelected(noteId !== 'new' ? noteId : null);
}

function debouncedSave(): void {
  if (!isNative || !editor || currentNoteId === null) return;
  if (saveTimeout !== null) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = window.setTimeout(saveNote, 500);
}

async function flushSave(): Promise<void> {
  if (saveTimeout === null) return;
  clearTimeout(saveTimeout);
  saveTimeout = null;
  await saveNote();
}

async function saveNote(): Promise<void> {
  if (!isNative || !editor || currentNoteId === null) return;
  const newTitle = titleInput.value.trim() || 'Untitled';
  const newId = sanitizeFilename(newTitle);
  const newContent = editor.getContent();

  const result = await updateNote(newId, newTitle, newContent, originalId ?? undefined);

  originalId = result.id;
  currentNoteId = result.id;

  refreshNotesList();

  const expectedHash = `#/note/${encodeURIComponent(result.id)}`;
  if (window.location.hash !== expectedHash) {
    router.navigate(`/note/${encodeURIComponent(result.id)}`);
  }
}

function setupEdgeSwipe(): void {
  let tracking = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let ignoreSwipe = false;
  let startProgress = 0;

  const isTableSwipeTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(
      target.closest('.cm-md-table-wrapper, .cm-md-table-rendered, .cm-md-table')
    );
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    if (isTableSwipeTarget(event.target)) {
      tracking = false;
      ignoreSwipe = true;
      return;
    }
    const touch = event.touches[0];
    tracking = true;
    dragging = false;
    startX = touch.clientX;
    startY = touch.clientY;
    lastX = startX;
    lastTime = Date.now();
    velocity = 0;
    ignoreSwipe = false;
    updateDrawerMetrics();
    startProgress = drawerOpen ? 1 : 0;
    setDrawerProgress(startProgress);
  };

  const onTouchMove = (event: TouchEvent) => {
    if (ignoreSwipe || !tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (!dragging && Math.abs(deltaX) < Math.abs(deltaY)) return;
    if (!dragging && Math.abs(deltaX) < 5) return;

    if (!dragging) {
      dragging = true;
      shell.classList.add('drawer-dragging');
      titleInput.blur();
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
  };

  const onTouchEnd = () => {
    if (dragging) {
      shell.classList.remove('drawer-dragging');
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
    dragging = false;
    ignoreSwipe = false;
    velocity = 0;
  };

  shell.addEventListener('touchstart', onTouchStart);
  shell.addEventListener('touchmove', onTouchMove, { passive: false });
  shell.addEventListener('touchend', onTouchEnd);
  shell.addEventListener('touchcancel', onTouchEnd);
}

import { Capacitor, registerPlugin } from '@capacitor/core';
import { store } from '../store';
import { router } from '../router';
import {
  getAllNotes,
  loadSearchIndex,
  upsertNoteMeta,
  createSearchIndex,
  saveSearchIndex
} from '../lib/db';
import { writeNote, readNote, renameNote } from '../lib/fileSystem';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { NotePreview } from '../types';
import { escapeHtml, sanitizeFilename } from '../lib/utils';

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
let currentNoteId: string | null = null;
let originalId: string | null = null;
let saveTimeout: number | null = null;
let drawerOpen = false;
let drawerProgress = 0;
let drawerWidth = 0;

let shell: HTMLElement;
let drawer: HTMLElement;
let overlay: HTMLElement;
let listContainer: HTMLElement;
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
        <div class="notes-list"></div>
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
  listContainer = app.querySelector('.notes-list') as HTMLElement;
  fab = app.querySelector('.fab') as HTMLButtonElement;
  menuBtn = app.querySelector('.drawer-toggle') as HTMLButtonElement;
  titleInput = app.querySelector('.title-input') as HTMLInputElement;
  editorContainer = app.querySelector('.editor-container') as HTMLElement;
  emptyState = app.querySelector('.note-empty') as HTMLElement;
  emptyOpenBtn = app.querySelector('.note-empty-action') as HTMLButtonElement;

  listContainer.addEventListener('click', handleListClick);
  fab.addEventListener('touchstart', handleFabTouchStart);
  fab.addEventListener('touchend', handleFabTouchEnd);
  fab.addEventListener('touchcancel', handleFabTouchCancel);
  fab.addEventListener('click', handleFabClick);
  menuBtn.addEventListener('click', () => setDrawerOpen(!drawerOpen));
  overlay.addEventListener('click', () => setDrawerOpen(false));
  emptyOpenBtn.addEventListener('click', () => setDrawerOpen(true));
  titleInput.addEventListener('input', debouncedSave);

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

function renderList(notesToRender: NotePreview[]): void {
  const selectedId = currentNoteId && currentNoteId !== 'new' ? currentNoteId : null;

  if (notesToRender.length === 0) {
    const message = 'No notes yet. Tap + to create one.';
    listContainer.innerHTML = `<div class="empty">${message}</div>`;
    return;
  }

  listContainer.innerHTML = notesToRender.map(note => `
    <div class="note-item${note.id === selectedId ? ' selected' : ''}" data-id="${note.id}">
      <div class="note-title">${escapeHtml(note.title)}</div>
    </div>
  `).join('');
}

async function refreshNotesList(): Promise<void> {
  const notes = isNative ? await getAllNotes() : [];
  store.setState({ notes });
  renderList(notes);
}

function handleListClick(event: Event): void {
  const target = event.target as HTMLElement;
  const noteItem = target.closest('.note-item') as HTMLElement | null;
  if (noteItem) {
    const id = noteItem.dataset.id!;
    setDrawerOpen(false);
    router.navigate(`/note/${encodeURIComponent(id)}`);
  }
}

async function createTestNote(): Promise<void> {
  if (!isNative) return;
  const title = 'Markdown test note';
  const id = sanitizeFilename(title);
  const mtime = await writeNote(id, GFM_TEST_CONTENT);
  const preview = GFM_TEST_CONTENT.slice(0, 100).replace(/\n/g, ' ');

  await upsertNoteMeta({ id, title, preview, modificationTime: mtime });

  let index = await loadSearchIndex();
  if (!index) index = createSearchIndex();
  index.add({ id, noteId: id, content: GFM_TEST_CONTENT });
  await saveSearchIndex(index);

  await refreshNotesList();
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

  renderList(store.getState().notes);
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
  const preview = newContent.slice(0, 100).replace(/\n/g, ' ');

  let mtime: number;
  if (originalId && originalId !== newId) {
    mtime = await renameNote(originalId, newId, newContent);
  } else {
    mtime = await writeNote(newId, newContent);
  }

  await upsertNoteMeta({ id: newId, title: newTitle, preview, modificationTime: mtime });

  let index = await loadSearchIndex();
  if (!index) index = createSearchIndex();
  if (originalId) index.discard(originalId);
  index.add({ id: newId, noteId: newId, content: newContent });
  await saveSearchIndex(index);

  originalId = newId;
  currentNoteId = newId;

  await refreshNotesList();

  const expectedHash = `#/note/${encodeURIComponent(newId)}`;
  if (window.location.hash !== expectedHash) {
    router.navigate(`/note/${encodeURIComponent(newId)}`);
  }
}

function setupEdgeSwipe(): void {
  const threshold = 60;
  let tracking = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
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
    if (!dragging && Math.abs(deltaX) < 8) return;

    if (!dragging) {
      dragging = true;
      shell.classList.add('drawer-dragging');
    }

    const nextProgress = startProgress + deltaX / drawerWidth;
    setDrawerProgress(nextProgress);
    event.preventDefault();

    if (!drawerOpen && deltaX > threshold) {
      // keep dragging for live progress
    }
    if (drawerOpen && deltaX < -threshold) {
      // keep dragging for live progress
    }
  };

  const onTouchEnd = () => {
    if (dragging) {
      shell.classList.remove('drawer-dragging');
      setDrawerOpen(drawerProgress >= 0.5);
    }
    tracking = false;
    dragging = false;
    ignoreSwipe = false;
  };

  shell.addEventListener('touchstart', onTouchStart);
  shell.addEventListener('touchmove', onTouchMove, { passive: false });
  shell.addEventListener('touchend', onTouchEnd);
  shell.addEventListener('touchcancel', onTouchEnd);
}

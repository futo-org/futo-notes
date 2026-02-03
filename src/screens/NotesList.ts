import { store } from '../store';
import { router } from '../router';
import { getAllNotes, deleteNoteMeta, loadSearchIndex, upsertNoteMeta, createSearchIndex, saveSearchIndex } from '../lib/db';
import { deleteNoteFile, writeNote } from '../lib/fileSystem';
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

let cleanup: (() => void) | null = null;

export async function renderNotesList(): Promise<void> {
  if (cleanup) cleanup();

  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div class="notes-screen">
      <header><h1>Notes</h1></header>
      <div class="search-bar">
        <input type="text" placeholder="Search notes..." />
      </div>
      <div class="notes-list"></div>
      <button class="fab">+</button>
    </div>
  `;

  const searchInput = app.querySelector('.search-bar input') as HTMLInputElement;
  const listContainer = app.querySelector('.notes-list')!;
  const fab = app.querySelector('.fab')!;

  // Load notes
  const notes = await getAllNotes();
  store.setState({ notes });

  // Render list
  const renderList = (notesToRender: NotePreview[]) => {
    if (notesToRender.length === 0) {
      listContainer.innerHTML = '<div class="empty">No notes yet. Tap + to create one.</div>';
      return;
    }
    listContainer.innerHTML = notesToRender.map(note => `
      <div class="note-item" data-id="${note.id}">
        <div class="note-content">
          <div class="note-title">${escapeHtml(note.title)}</div>
          <div class="note-preview">${escapeHtml(note.preview)}</div>
        </div>
        <button class="delete-btn" data-id="${note.id}">×</button>
      </div>
    `).join('');
  };

  renderList(notes);

  // Event handlers
  const handleClick = (e: Event) => {
    const target = e.target as HTMLElement;
    const deleteBtn = target.closest('.delete-btn') as HTMLElement;
    if (deleteBtn) {
      e.stopPropagation();
      const id = deleteBtn.dataset.id!;
      if (confirm('Delete this note?')) {
        deleteNote(id);
      }
      return;
    }
    const noteItem = target.closest('.note-item') as HTMLElement;
    if (noteItem) {
      router.navigate(`/note/${encodeURIComponent(noteItem.dataset.id!)}`);
    }
  };

  const deleteNote = async (id: string) => {
    await deleteNoteFile(id);
    await deleteNoteMeta(id);
    const updated = store.getState().notes.filter(n => n.id !== id);
    store.setState({ notes: updated });
    renderList(updated);
  };

  const createTestNote = async () => {
    const title = 'Markdown test note';
    const id = sanitizeFilename(title);
    const mtime = await writeNote(id, GFM_TEST_CONTENT);
    const preview = GFM_TEST_CONTENT.slice(0, 100).replace(/\n/g, ' ');

    await upsertNoteMeta({ id, title, preview, modificationTime: mtime });

    // Update search index
    let index = await loadSearchIndex();
    if (!index) index = createSearchIndex();
    index.add({ id, noteId: id, content: GFM_TEST_CONTENT });
    await saveSearchIndex(index);

    // Refresh list
    const updated = await getAllNotes();
    store.setState({ notes: updated });
    renderList(updated);
  };

  let searchTimeout: number;
  const handleSearch = () => {
    clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(async () => {
      const query = searchInput.value.trim();
      store.setState({ searchQuery: query });
      if (!query) {
        renderList(store.getState().notes);
        return;
      }
      const index = await loadSearchIndex();
      if (index) {
        const results = index.search(query);
        const ids = new Set(results.map(r => r.noteId));
        const filtered = store.getState().notes.filter(n => ids.has(n.id));
        renderList(filtered);
      }
    }, 300);
  };

  // FAB: tap = new note, long-press = test note
  let fabPressTimer: number | null = null;
  const handleFabTouchStart = () => {
    fabPressTimer = window.setTimeout(() => {
      createTestNote();
      fabPressTimer = null;
    }, 500); // 500ms long-press
  };
  const handleFabTouchEnd = () => {
    if (fabPressTimer !== null) {
      clearTimeout(fabPressTimer);
      fabPressTimer = null;
      router.navigate('/note/new');
    }
  };

  listContainer.addEventListener('click', handleClick);
  searchInput.addEventListener('input', handleSearch);
  fab.addEventListener('touchstart', handleFabTouchStart);
  fab.addEventListener('touchend', handleFabTouchEnd);
  fab.addEventListener('touchcancel', () => {
    if (fabPressTimer !== null) {
      clearTimeout(fabPressTimer);
      fabPressTimer = null;
    }
  });

  cleanup = () => {
    listContainer.removeEventListener('click', handleClick);
    searchInput.removeEventListener('input', handleSearch);
    fab.removeEventListener('touchstart', handleFabTouchStart);
    fab.removeEventListener('touchend', handleFabTouchEnd);
  };
}

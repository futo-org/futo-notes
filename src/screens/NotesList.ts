import { Capacitor } from '@capacitor/core';
import { store } from '../store';
import { router } from '../router';
import { getAllNotes, deleteNote, search, createNote } from '../lib/notes';
import { sanitizeFilename } from '../lib/utils';
import { VirtualList } from '../components/VirtualList';

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
let virtualList: VirtualList | null = null;

export async function renderNotesList(): Promise<void> {
  if (cleanup) cleanup();

  const isNative = Capacitor.isNativePlatform();

  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div class="notes-screen">
      <header><h1>Notes</h1></header>
      <div class="search-bar">
        <input type="text" placeholder="Search notes..." />
      </div>
      <div class="notes-list-scroll">
        <div class="notes-list-content"></div>
      </div>
      <button class="fab">+</button>
    </div>
  `;

  const searchInput = app.querySelector('.search-bar input') as HTMLInputElement;
  const listScrollContainer = app.querySelector('.notes-list-scroll') as HTMLElement;
  const listContentContainer = app.querySelector('.notes-list-content') as HTMLElement;
  const fab = app.querySelector('.fab')!;

  // Load notes (empty array in browser mode)
  const notes = isNative ? getAllNotes() : [];
  store.setState({ notes });

  // Initialize VirtualList
  virtualList = new VirtualList({
    scrollElement: listScrollContainer,
    contentElement: listContentContainer,
    rowHeight: 72,
    showPreview: true,
    onItemClick: (id) => router.navigate(`/note/${encodeURIComponent(id)}`)
  });

  virtualList.update(notes);

  const handleDeleteNote = async (id: string) => {
    if (isNative) {
      await deleteNote(id);
    }
    const updated = store.getState().notes.filter(n => n.id !== id);
    store.setState({ notes: updated });
    virtualList?.update(updated);
  };

  const createTestNote = async () => {
    if (!isNative) return;
    const title = 'Markdown test note';
    await createNote(sanitizeFilename(title), GFM_TEST_CONTENT);

    // Refresh list
    const updated = getAllNotes();
    store.setState({ notes: updated });
    virtualList?.update(updated);
  };

  let searchTimeout: number;
  const handleSearch = () => {
    clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => {
      const query = searchInput.value.trim();
      store.setState({ searchQuery: query });
      if (!query) {
        virtualList?.update(store.getState().notes);
        return;
      }
      if (isNative) {
        const filtered = search(query);
        virtualList?.update(filtered);
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
    virtualList?.destroy();
    virtualList = null;
    searchInput.removeEventListener('input', handleSearch);
    fab.removeEventListener('touchstart', handleFabTouchStart);
    fab.removeEventListener('touchend', handleFabTouchEnd);
  };

  // Note: handleDeleteNote is available but not currently wired up to UI
  // The standalone list view could add delete buttons if needed
  void handleDeleteNote;
}

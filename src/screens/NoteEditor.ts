import { router } from '../router';
import { readNote, writeNote, renameNote } from '../lib/fileSystem';
import { upsertNoteMeta, loadSearchIndex, saveSearchIndex, createSearchIndex } from '../lib/db';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { sanitizeFilename } from '../lib/utils';

let cleanup: (() => void) | null = null;

export async function renderNoteEditor(params: { id: string }): Promise<void> {
  if (cleanup) cleanup();

  const isNew = params.id === 'new';
  let noteId = isNew ? '' : params.id;
  let originalId = noteId;

  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div class="editor-screen">
      <header>
        <button class="back-btn">←</button>
        <input type="text" class="title-input" placeholder="Untitled" />
      </header>
      <div class="editor-container"></div>
    </div>
  `;

  const backBtn = app.querySelector('.back-btn')!;
  const titleInput = app.querySelector('.title-input') as HTMLInputElement;
  const editorContainer = app.querySelector('.editor-container') as HTMLElement;

  // Load content
  let content = '';
  let title = 'Untitled';
  if (!isNew) {
    try {
      content = await readNote(noteId);
      title = noteId;
    } catch {
      router.navigate('/');
      return;
    }
  }
  titleInput.value = title;

  // Initialize editor
  const editor = new MarkdownEditor(editorContainer, {
    initialContent: content,
    onChange: () => debouncedSave()
  });

  if (isNew) editor.focus();

  // Save logic
  let saveTimeout: number;
  const debouncedSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = window.setTimeout(saveNote, 500);
  };

  const saveNote = async () => {
    const newTitle = titleInput.value.trim() || 'Untitled';
    const newId = sanitizeFilename(newTitle);
    const newContent = editor.getContent();
    const preview = newContent.slice(0, 100).replace(/\n/g, ' ');

    let mtime: number;
    if (originalId && originalId !== newId) {
      // Rename
      mtime = await renameNote(originalId, newId, newContent);
    } else {
      mtime = await writeNote(newId, newContent);
    }

    await upsertNoteMeta({ id: newId, title: newTitle, preview, modificationTime: mtime });

    // Update search index
    let index = await loadSearchIndex();
    if (!index) index = createSearchIndex();
    if (originalId) index.discard(originalId);
    index.add({ id: newId, noteId: newId, content: newContent });
    await saveSearchIndex(index);

    originalId = newId;
    noteId = newId;
  };

  // Event handlers
  backBtn.addEventListener('click', () => router.navigate('/'));
  titleInput.addEventListener('input', debouncedSave);

  cleanup = () => {
    clearTimeout(saveTimeout);
    editor.destroy();
  };
}

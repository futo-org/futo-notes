import { Capacitor } from '@capacitor/core';
import { router } from '../router';
import { readNote, updateNote } from '../lib/notes';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { sanitizeFilename } from '../lib/utils';

let cleanup: (() => void) | null = null;

export async function renderNoteEditor(params: { id: string }): Promise<void> {
  if (cleanup) cleanup();

  const isNative = Capacitor.isNativePlatform();
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
  if (!isNew && isNative) {
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

  // Save logic (only on native)
  let saveTimeout: number;
  const debouncedSave = () => {
    if (!isNative) return; // Skip save in browser mode
    clearTimeout(saveTimeout);
    saveTimeout = window.setTimeout(saveNote, 500);
  };

  const saveNote = async () => {
    if (!isNative) return;
    const newTitle = titleInput.value.trim() || 'Untitled';
    const newId = sanitizeFilename(newTitle);
    const newContent = editor.getContent();

    const result = await updateNote(newId, newTitle, newContent, originalId || undefined);

    originalId = result.id;
    noteId = result.id;
  };

  // Event handlers
  backBtn.addEventListener('click', () => router.navigate('/'));
  titleInput.addEventListener('input', debouncedSave);

  cleanup = () => {
    clearTimeout(saveTimeout);
    editor.destroy();
  };
}

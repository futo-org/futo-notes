import { NotePreview } from '../types';
import {
  initSearchIndex,
  addToSearchIndex,
  removeFromSearchIndex,
  searchNotes
} from './searchIndex';
import {
  listNoteFiles,
  readNote,
  writeNote,
  deleteNoteFile,
  renameNote as renameNoteFile,
  getUniqueNoteId
} from './fileSystem';
import { ensureNotesFolder, getPlatformFS } from './platform';
import { markLocalDeleteForSync, trackLocalRenameForSync } from './syncState';

// In-memory cache of notes metadata
let notesCache: NotePreview[] = [];
let initialized = false;

export async function initNotes(): Promise<void> {
  if (initialized) return;

  initSearchIndex();
  await getPlatformFS(); // Initialize platform FS before any file operations
  await ensureNotesFolder();
  await rebuildFromFiles();
  initialized = true;
}

async function rebuildFromFiles(): Promise<void> {
  const files = await listNoteFiles();
  notesCache = [];

  for (const file of files) {
    const id = file.name.replace(/\.md$/, '');
    try {
      const content = await readNote(id);
      // Title is derived from filename: convert dashes/underscores to spaces, capitalize words
      const title = id
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      const preview = content.slice(0, 100).replace(/\n/g, ' ');

      notesCache.push({
        id,
        title,
        preview,
        modificationTime: file.mtime
      });

      addToSearchIndex({ id, noteId: id, content });
    } catch (e) {
      console.warn(`Failed to load note ${id}:`, e);
    }
  }

  // Sort by modification time descending
  notesCache.sort((a, b) => b.modificationTime - a.modificationTime);
}

export function getAllNotes(): NotePreview[] {
  return [...notesCache];
}

export function getNoteById(id: string): NotePreview | undefined {
  return notesCache.find(n => n.id === id);
}

function updateCache(entry: NotePreview): void {
  const idx = notesCache.findIndex(n => n.id === entry.id);
  if (idx >= 0) {
    notesCache[idx] = entry;
  } else {
    notesCache.push(entry);
  }
  notesCache.sort((a, b) => b.modificationTime - a.modificationTime);
}

function removeFromCache(id: string): void {
  notesCache = notesCache.filter(n => n.id !== id);
}

export async function createNote(title: string, content: string, overrideMtime?: number): Promise<{ id: string; mtime: number }> {
  const id = await getUniqueNoteId(title);
  const mtime = await writeNote(id, content, overrideMtime);
  const preview = content.slice(0, 100).replace(/\n/g, ' ');

  updateCache({ id, title, preview, modificationTime: mtime });
  addToSearchIndex({ id, noteId: id, content });

  return { id, mtime };
}

export async function updateNote(
  id: string,
  title: string,
  content: string,
  originalId?: string,
  overrideMtime?: number,
): Promise<{ id: string; mtime: number }> {
  const preview = content.slice(0, 100).replace(/\n/g, ' ');
  const finalId = await getUniqueNoteId(id, originalId);
  let mtime: number;

  if (originalId && originalId !== finalId) {
    mtime = await renameNoteFile(originalId, finalId, content, overrideMtime);
    removeFromSearchIndex(originalId);
    removeFromCache(originalId);
    await trackLocalRenameForSync(originalId, finalId);
  } else {
    mtime = await writeNote(finalId, content, overrideMtime);
  }

  updateCache({ id: finalId, title, preview, modificationTime: mtime });
  addToSearchIndex({ id: finalId, noteId: finalId, content });

  return { id: finalId, mtime };
}

export async function deleteNote(id: string, options: { trackSyncDelete?: boolean } = {}): Promise<void> {
  await deleteNoteFile(id);
  removeFromCache(id);
  removeFromSearchIndex(id);

  if (options.trackSyncDelete !== false) {
    await markLocalDeleteForSync(id);
  }
}

export function search(query: string): NotePreview[] {
  if (!query.trim()) return getAllNotes();

  const matchingIds = new Set(searchNotes(query));
  return notesCache.filter(note => matchingIds.has(note.id));
}

export { readNote, noteExists, getUniqueNoteId } from './fileSystem';

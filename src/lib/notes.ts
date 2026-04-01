import { NotePreview, SearchResultItem } from '../types';
import {
  writeNote,
  deleteNoteFile,
  deleteAllContent,
  renameNote as renameNoteFile,
  getUniqueNoteId
} from './fileSystem';
import { ensureNotesFolder, getPlatformFS } from './platform';
import { loadEngagement, trackEdit, removeEngagement, renameEngagement } from './engagement';
import { getRustNotePreviews, hasRustCore, keywordSearchRust, rebuildRustIndex } from './rustCore';
import { clearV2SyncState } from './appState';
import { extractTags } from '@futo-notes/shared';

// In-memory cache of notes metadata
let notesCache: NotePreview[] = [];
let initialized = false;

/** Test-only: inject a note into the cache without filesystem access. */
export function _injectTestNote(id: string, title: string): void {
  notesCache.push({ id, title, preview: '', modificationTime: Date.now(), tags: [] });
}

export async function initNotes(): Promise<void> {
  if (initialized) return;

  await getPlatformFS(); // Initialize platform FS before any file operations
  await ensureNotesFolder();

  notesCache = hasRustCore() ? await rebuildRustIndex() : [];
  await loadEngagement();
  initialized = true;
}

export async function refreshNotesFromStorage(): Promise<void> {
  if (!hasRustCore()) return;
  notesCache = await getRustNotePreviews();
}

export async function refreshNotesAfterSync(_updatedIds: string[], _deletedIds: string[]): Promise<void> {
  await refreshNotesFromStorage();
}

export function getAllNotes(): NotePreview[] {
  return [...notesCache];
}

export function getNoteById(id: string): NotePreview | undefined {
  return notesCache.find(n => n.id === id);
}

export async function createNote(id: string, content: string, overrideMtime?: number): Promise<{ id: string; mtime: number }> {
  id = await getUniqueNoteId(id);
  const mtime = await writeNote(id, content, overrideMtime);
  if (hasRustCore()) {
    await refreshNotesFromStorage();
  } else {
    const lines = content.split('\n');
    notesCache.push({ id, title: id, preview: lines.slice(0, 3).join(' ').slice(0, 200), modificationTime: mtime, tags: extractTags(content) });
  }
  return { id, mtime };
}

export async function updateNote(
  id: string,
  _title: string,
  content: string,
  originalId?: string,
  overrideMtime?: number,
): Promise<{ id: string; mtime: number }> {
  const finalId = await getUniqueNoteId(id, originalId);
  let mtime: number;

  if (originalId && originalId !== finalId) {
    mtime = await renameNoteFile(originalId, finalId, content, overrideMtime);
    renameEngagement(originalId, finalId);
  } else {
    mtime = await writeNote(finalId, content, overrideMtime);
  }

  if (hasRustCore()) {
    await refreshNotesFromStorage();
  } else {
    const lines = content.split('\n');
    const idx = notesCache.findIndex(n => n.id === (originalId ?? finalId));
    const preview = { id: finalId, title: finalId, preview: lines.slice(0, 3).join(' ').slice(0, 200), modificationTime: mtime, tags: extractTags(content) };
    if (idx >= 0) notesCache[idx] = preview; else notesCache.push(preview);
  }
  trackEdit(finalId);

  return { id: finalId, mtime };
}

export async function deleteNote(id: string): Promise<void> {
  await deleteNoteFile(id);
  removeEngagement(id);
  if (hasRustCore()) {
    await refreshNotesFromStorage();
  } else {
    notesCache = notesCache.filter(n => n.id !== id);
  }

}

export async function deleteAllNotes(): Promise<void> {
  // Pause auto-sync for the duration of the reset. Without this, a sync can race
  // between steps and see files on disk with stale state.
  const { pauseSyncV2, resumeSyncV2, waitForSyncIdleV2 } = await import('./autoSyncV2');
  pauseSyncV2();
  try {
    await waitForSyncIdleV2();
    await deleteAllContent();
    await clearV2SyncState();
    notesCache = [];
  } finally {
    resumeSyncV2();
  }
}

export async function search(query: string): Promise<SearchResultItem[]> {
  if (hasRustCore()) {
    if (!query.trim()) {
      return getAllNotes().map((note) => ({ note, snippet: null }));
    }
    return keywordSearchRust(query);
  }
  if (!query.trim()) {
    return getAllNotes().map((note) => ({ note, snippet: null }));
  }
  const lower = query.trim().toLowerCase();
  return notesCache
    .filter((note) => note.id.toLowerCase().includes(lower) || note.preview.toLowerCase().includes(lower))
    .map((note) => ({ note, snippet: [{ text: note.preview, highlight: false }] }));
}

export async function searchKeyword(query: string): Promise<SearchResultItem[]> {
  if (!hasRustCore()) return await search(query);
  return keywordSearchRust(query);
}

export async function handleExternalFileChange(
  filename: string,
): Promise<NotePreview | null> {
  const id = filename.replace(/\.md$/, '');

  await refreshNotesFromStorage();
  return getNoteById(id) ?? null;
}

export { readNote, noteExists, getUniqueNoteId } from './fileSystem';

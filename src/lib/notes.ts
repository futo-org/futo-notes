import type { NotePreview, SearchResultItem } from '../types';
import {
  writeNote,
  deleteNoteFile,
  deleteAllContent,
  renameNote as renameNoteFile,
  getUniqueNoteId
} from './fileSystem';
import { ensureNotesFolder, getFS, getPlatformFS } from './platform';
import { loadEngagement, trackEdit, removeEngagement, renameEngagement } from './engagement';
import { clearV2SyncState } from './appState';
import { extractTags } from '@futo-notes/shared';
import { scanNotePreviews, makePreview } from './notesIndex';
import { searchNotes, extractSnippet, addToSearchIndex, isSearchIndexPopulated } from './searchIndex';

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

  notesCache = await scanNotePreviews(getFS());
  await loadEngagement();
  initialized = true;
}

export async function refreshNotesFromStorage(): Promise<void> {
  notesCache = await scanNotePreviews(getFS());
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

  notesCache.push({
    id,
    title: id,
    preview: makePreview(content),
    modificationTime: mtime,
    tags: extractTags(content),
  });
  addToSearchIndex({ id, title: id, body: content, mtime });

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

  const preview: NotePreview = {
    id: finalId,
    title: finalId,
    preview: makePreview(content),
    modificationTime: mtime,
    tags: extractTags(content),
  };
  const idx = notesCache.findIndex(n => n.id === (originalId ?? finalId));
  if (idx >= 0) notesCache[idx] = preview; else notesCache.push(preview);

  addToSearchIndex({ id: finalId, title: finalId, body: content, mtime });
  trackEdit(finalId);

  return { id: finalId, mtime };
}

export async function deleteNote(id: string): Promise<void> {
  await deleteNoteFile(id);
  removeEngagement(id);
  notesCache = notesCache.filter(n => n.id !== id);
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
  if (!query.trim()) {
    return getAllNotes().map((note) => ({ note, snippet: null }));
  }
  // If the search index is populated, trust its results (even if empty)
  if (isSearchIndexPopulated()) {
    const hits = searchNotes(query);
    const results: SearchResultItem[] = [];
    for (const hit of hits) {
      const note = notesCache.find(n => n.id === hit.noteId);
      if (note) {
        results.push({ note, snippet: extractSnippet(hit), source: 'keyword' as const });
      }
    }
    return results;
  }
  // Fallback: index not yet populated (e.g. right after startup before rebuild),
  // use simple substring match on cache
  const lower = query.trim().toLowerCase();
  return notesCache
    .filter((note) => note.id.toLowerCase().includes(lower) || note.preview.toLowerCase().includes(lower))
    .map((note) => ({ note, snippet: [{ text: note.preview, highlight: false }] }));
}

export async function searchKeyword(query: string): Promise<SearchResultItem[]> {
  return search(query);
}

export async function handleExternalFileChange(
  filename: string,
): Promise<NotePreview | null> {
  const id = filename.replace(/\.md$/, '');

  await refreshNotesFromStorage();
  return getNoteById(id) ?? null;
}

export { readNote, noteExists, getUniqueNoteId } from './fileSystem';

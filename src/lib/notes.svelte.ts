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
import { pauseSyncV2, resumeSyncV2, waitForSyncIdleV2 } from './autoSyncV2';
import { extractTags } from '@futo-notes/shared';
import { scanNotePreviewsWithBodies, makePreview } from './notesIndex';
import {
  searchNotes,
  extractSnippet,
  addToSearchIndex,
  removeFromSearchIndex,
  initSearchIndex,
  loadPersistedIndex,
  persistIndex,
  getMtimeMap,
  clearSearchIndex,
} from './searchIndex';
import { runPool } from './util/pool';

// Matches notesIndex.ts READ_POOL_CONCURRENCY.
const RECONCILE_CONCURRENCY = 8;

// Reactive in-memory cache of notes metadata. Mutations propagate through
// `$derived(sortedNotes)` and every `$effect` that reads `getAllNotes()`.
let notesCache = $state<NotePreview[]>([]);
let initialized = false;

const sortedNotes = $derived.by(() =>
  [...notesCache].sort(
    (a, b) => b.modificationTime - a.modificationTime || a.id.localeCompare(b.id),
  ),
);

/** Test-only: inject a note into the cache without filesystem access. */
export function _injectTestNote(id: string, title: string): void {
  notesCache.push({ id, title, preview: '', modificationTime: Date.now(), tags: [] });
}

export async function initNotes(): Promise<void> {
  if (initialized) return;

  await getPlatformFS(); // Initialize platform FS before any file operations
  await ensureNotesFolder();

  const { previews, freshBodies } = await scanNotePreviewsWithBodies(getFS());
  notesCache = previews;
  await loadEngagement();
  await bootstrapSearchIndex(freshBodies);
  initialized = true;
}

/**
 * Ensure the search index reflects the current notesCache. Called at startup
 * and after any bulk filesystem change (external refresh, sync apply).
 *
 * Strategy: try to load the persisted index, then reconcile against the current
 * file mtimes — re-read bodies only for notes that are new or changed. If no
 * persisted index exists, build from scratch, reusing any bodies we already
 * have in hand from `scanNotePreviewsWithBodies`.
 */
async function bootstrapSearchIndex(freshBodies?: Map<string, string>): Promise<void> {
  const loaded = await loadPersistedIndex();

  if (loaded) {
    await reconcileSearchIndex(freshBodies);
  } else {
    initSearchIndex();
    await buildSearchIndexFromScratch(freshBodies);
  }

  // Persist in the background — don't block startup on disk I/O.
  void persistIndex();
}

/**
 * Build the search index from every note in `notesCache`, reusing bodies
 * already read during `scanNotePreviewsWithBodies` (cold preview cache)
 * and only hitting disk for anything that's still missing. Reads run
 * through a bounded pool.
 */
async function buildSearchIndexFromScratch(
  freshBodies?: Map<string, string>,
): Promise<void> {
  const fs = getFS();
  const stillNeeded: NotePreview[] = [];

  for (const note of notesCache) {
    const body = freshBodies?.get(note.id);
    if (body !== undefined) {
      addToSearchIndex({ id: note.id, title: note.id, body, mtime: note.modificationTime });
    } else {
      stillNeeded.push(note);
    }
  }

  if (stillNeeded.length === 0) return;

  await runPool(stillNeeded, RECONCILE_CONCURRENCY, async (note) => {
    try {
      const body = await fs.readNote(note.id);
      addToSearchIndex({ id: note.id, title: note.id, body, mtime: note.modificationTime });
    } catch {
      // Skip unreadable files
    }
  });
}

/**
 * Reconcile the search index against the current notesCache: remove entries
 * for deleted notes, and re-read bodies for notes with new/changed mtimes.
 * Reuses `freshBodies` when available to skip redundant IPC.
 */
async function reconcileSearchIndex(freshBodies?: Map<string, string>): Promise<void> {
  const fs = getFS();
  const mtimes = getMtimeMap();
  const currentIds = new Set(notesCache.map((n) => n.id));

  for (const id of Object.keys(mtimes)) {
    if (!currentIds.has(id)) removeFromSearchIndex(id);
  }

  const toRead: NotePreview[] = [];
  for (const note of notesCache) {
    if (mtimes[note.id] === note.modificationTime) continue;
    const cachedBody = freshBodies?.get(note.id);
    if (cachedBody !== undefined) {
      addToSearchIndex({ id: note.id, title: note.id, body: cachedBody, mtime: note.modificationTime });
    } else {
      toRead.push(note);
    }
  }

  if (toRead.length === 0) return;
  await runPool(toRead, RECONCILE_CONCURRENCY, async (note) => {
    try {
      const body = await fs.readNote(note.id);
      addToSearchIndex({ id: note.id, title: note.id, body, mtime: note.modificationTime });
    } catch {
      // Skip unreadable files
    }
  });
}

export async function refreshNotesFromStorage(): Promise<void> {
  const { previews, freshBodies } = await scanNotePreviewsWithBodies(getFS());
  notesCache = previews;
  await reconcileSearchIndex(freshBodies);
  void persistIndex();
}

export async function refreshNotesAfterSync(_updatedIds: string[], _deletedIds: string[]): Promise<void> {
  await refreshNotesFromStorage();
}

export function getAllNotes(): NotePreview[] {
  return sortedNotes;
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
    removeFromSearchIndex(originalId);
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
  removeFromSearchIndex(id);
  notesCache = notesCache.filter(n => n.id !== id);
  void persistIndex();
}

export async function deleteAllNotes(): Promise<void> {
  // Pause auto-sync for the duration of the reset. Without this, a sync can race
  // between steps and see files on disk with stale state.
  pauseSyncV2();
  try {
    await waitForSyncIdleV2();
    await deleteAllContent();
    notesCache = [];
    clearSearchIndex();
    void persistIndex();
  } finally {
    resumeSyncV2();
  }
}

export async function search(query: string): Promise<SearchResultItem[]> {
  if (!query.trim()) {
    return getAllNotes().map((note) => ({ note, snippet: null }));
  }
  // initNotes() always bootstraps the search index, so trust its results.
  const hits = searchNotes(query);
  const results: SearchResultItem[] = [];
  for (const hit of hits) {
    const note = notesCache.find((n) => n.id === hit.noteId);
    if (note) {
      results.push({ note, snippet: extractSnippet(hit), source: 'keyword' as const });
    }
  }
  return results;
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

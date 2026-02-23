import { NotePreview, SearchResultItem } from '../types';
import {
  initSearchIndex,
  addToSearchIndex,
  removeFromSearchIndex,
  searchNotes,
  extractSnippet,
  getStoredBody,
  loadPersistedIndex,
  persistIndex,
  getMtimeMap,
} from './searchIndex';
import {
  listNoteFiles,
  readNote,
  writeNote,
  deleteNoteFile,
  deleteAllContent,
  renameNote as renameNoteFile,
  getUniqueNoteId
} from './fileSystem';
import { ensureNotesFolder, getPlatformFS } from './platform';
import { markLocalDeleteForSync, trackLocalRenameForSync, clearSyncState, loadSyncState, findIdForUuid } from './syncState';
import { isSupersearchReady } from './supersearch/state';
import { embed, isReady as isEmbedderReady } from './supersearch/queryEmbedder';
import { vectorSearch, type VectorSearchResult } from './supersearch/vectorSearch';
import { hybridSearch } from './supersearch/hybridSearch';

// In-memory cache of notes metadata
let notesCache: NotePreview[] = [];
let initialized = false;

// Debounced persist
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DELAY_MS = 5000;

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistIndex();
  }, PERSIST_DELAY_MS);
}

export async function initNotes(): Promise<void> {
  if (initialized) return;

  await getPlatformFS(); // Initialize platform FS before any file operations
  await ensureNotesFolder();

  const loaded = await loadPersistedIndex();
  if (loaded) {
    await incrementalRebuild();
  } else {
    initSearchIndex();
    await rebuildFromFiles();
    persistIndex();
  }

  initialized = true;
}

async function incrementalRebuild(): Promise<void> {
  const files = await listNoteFiles();
  const savedMtimes = getMtimeMap();
  const fileMap = new Map(files.map((f) => [f.name.replace(/\.md$/, ''), f.mtime]));
  const savedIds = new Set(Object.keys(savedMtimes));

  notesCache = [];

  for (const file of files) {
    const id = file.name.replace(/\.md$/, '');
    const savedMtime = savedMtimes[id];

    // Check if note has changed (1s tolerance for FAT32)
    const isUnchanged = savedMtime !== undefined && Math.abs(file.mtime - savedMtime) < 1000;

    if (isUnchanged) {
      // Use stored body from index to build preview (avoid disk read)
      const storedBody = getStoredBody(id);
      const preview = storedBody
        ? storedBody.slice(0, 100).replace(/\n/g, ' ')
        : '';
      notesCache.push({ id, title: id, preview, modificationTime: file.mtime });
    } else {
      // Changed or new — read from disk and reindex
      try {
        const content = await readNote(id);
        const preview = content.slice(0, 100).replace(/\n/g, ' ');
        notesCache.push({ id, title: id, preview, modificationTime: file.mtime });
        addToSearchIndex({ id, title: id, body: content, mtime: file.mtime });
      } catch (e) {
        console.warn(`Failed to load note ${id}:`, e);
      }
    }
  }

  // Remove deleted notes from index
  for (const oldId of savedIds) {
    if (!fileMap.has(oldId)) {
      removeFromSearchIndex(oldId);
    }
  }

  notesCache.sort((a, b) => b.modificationTime - a.modificationTime);
  schedulePersist();
}

async function rebuildFromFiles(): Promise<void> {
  const files = await listNoteFiles();
  notesCache = [];

  for (const file of files) {
    const id = file.name.replace(/\.md$/, '');
    try {
      const content = await readNote(id);
      const title = id;
      const preview = content.slice(0, 100).replace(/\n/g, ' ');

      notesCache.push({
        id,
        title,
        preview,
        modificationTime: file.mtime
      });

      addToSearchIndex({ id, title: id, body: content, mtime: file.mtime });
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
  addToSearchIndex({ id, title: id, body: content, mtime });
  schedulePersist();

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
  addToSearchIndex({ id: finalId, title: finalId, body: content, mtime });
  schedulePersist();

  return { id: finalId, mtime };
}

export async function deleteNote(id: string, options: { trackSyncDelete?: boolean } = {}): Promise<void> {
  await deleteNoteFile(id);
  removeFromCache(id);
  removeFromSearchIndex(id);
  schedulePersist();

  if (options.trackSyncDelete !== false) {
    await markLocalDeleteForSync(id);
  }
}

export async function deleteAllNotes(): Promise<void> {
  // Mark every note for sync deletion so tombstones propagate to server
  for (const note of notesCache) {
    await markLocalDeleteForSync(note.id);
  }
  await deleteAllContent();
  await clearSyncState();
  notesCache = [];
  initSearchIndex();
}

export function search(query: string): SearchResultItem[] {
  if (!query.trim()) {
    return getAllNotes().map((note) => ({ note, snippet: null }));
  }

  // Build a lookup map from cache
  const cacheMap = new Map(notesCache.map((n) => [n.id, n]));

  // Map search hits preserving MiniSearch relevance order
  const hits = searchNotes(query);
  const results: SearchResultItem[] = [];
  for (const hit of hits) {
    const note = cacheMap.get(hit.noteId);
    if (note) {
      results.push({ note, snippet: extractSnippet(hit) });
    }
  }
  return results;
}

export async function searchWithVectors(query: string): Promise<SearchResultItem[]> {
  if (!query.trim()) {
    return getAllNotes().map((note) => ({ note, snippet: null }));
  }

  // Get keyword results synchronously
  const keywordResults = search(query);

  // Check if supersearch is available
  const ready = await isSupersearchReady();
  if (!ready || !isEmbedderReady()) {
    return keywordResults;
  }

  try {
    // Run vector search
    const queryVector = await embed(query);
    const rawVectorResults = await vectorSearch(queryVector, 20);

    // Map UUIDs to note IDs
    const syncState = await loadSyncState();
    const cacheMap = new Map(notesCache.map((n) => [n.id, n]));
    const mappedResults: VectorSearchResult[] = [];

    for (const vr of rawVectorResults) {
      const noteId = findIdForUuid(syncState, vr.uuid);
      if (noteId && cacheMap.has(noteId)) {
        mappedResults.push({ ...vr, uuid: noteId });
      }
    }

    // Fuse with RRF
    return hybridSearch(keywordResults, mappedResults, cacheMap);
  } catch (e) {
    console.warn('[supersearch] vector search failed, falling back to keyword:', e);
    return keywordResults;
  }
}

export async function handleExternalFileChange(
  type: 'add' | 'change' | 'unlink',
  filename: string,
): Promise<NotePreview | null> {
  const id = filename.replace(/\.md$/, '');

  if (type === 'unlink') {
    removeFromCache(id);
    removeFromSearchIndex(id);
    schedulePersist();
    return null;
  }

  // add or change — read from disk
  try {
    const content = await readNote(id);
    const files = await listNoteFiles();
    const file = files.find(f => f.name === filename);
    const mtime = file?.mtime ?? Date.now();
    const preview = content.slice(0, 100).replace(/\n/g, ' ');

    const entry: NotePreview = { id, title: id, preview, modificationTime: mtime };
    updateCache(entry);
    addToSearchIndex({ id, title: id, body: content, mtime });
    schedulePersist();
    return entry;
  } catch (e) {
    console.warn(`handleExternalFileChange: failed to read ${filename}:`, e);
    return null;
  }
}

export { readNote, noteExists, getUniqueNoteId } from './fileSystem';

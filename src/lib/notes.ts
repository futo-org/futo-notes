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
import { loadEngagement, trackEdit, removeEngagement, renameEngagement } from './engagement';
import { isSupersearchReady } from './supersearch/state';
import { embed, isReady as isEmbedderReady } from './supersearch/queryEmbedder';
import { vectorSearch, type VectorSearchResult } from './supersearch/vectorSearch';
import { hybridSearch } from './supersearch/hybridSearch';
import { getSearchMode, type SearchMode } from './supersearch/searchMode';
import { getRustNotePreviews, hasRustCore, keywordSearchRust, rebuildRustIndex } from './rustCore';

// In-memory cache of notes metadata
let notesCache: NotePreview[] = [];
let initialized = false;
const useRustCore = hasRustCore();

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

  if (useRustCore) {
    notesCache = await rebuildRustIndex();
    await loadEngagement();
    initialized = true;
    return;
  }

  const loaded = await loadPersistedIndex();
  if (loaded) {
    await incrementalRebuild();
  } else {
    initSearchIndex();
    await rebuildFromFiles();
    persistIndex();
  }

  await loadEngagement();
  initialized = true;
}

export async function refreshNotesFromStorage(): Promise<void> {
  if (useRustCore) {
    notesCache = await getRustNotePreviews();
    return;
  }
  await incrementalRebuild();
}

export async function refreshNotesAfterSync(updatedIds: string[], deletedIds: string[]): Promise<void> {
  if (useRustCore) {
    await refreshNotesFromStorage();
    return;
  }

  const touched = new Set<string>([...updatedIds, ...deletedIds]);
  if (touched.size === 0) return;

  for (const id of deletedIds) {
    removeFromCache(id);
    removeFromSearchIndex(id);
  }

  const files = await listNoteFiles();
  const mtimeById = new Map(files.map((file) => [file.name.replace(/\.md$/, ''), file.mtime]));

  for (const id of updatedIds) {
    const mtime = mtimeById.get(id);
    if (mtime === undefined) {
      removeFromCache(id);
      removeFromSearchIndex(id);
      continue;
    }
    try {
      const body = await readNote(id);
      const preview = body.slice(0, 100).replace(/\n/g, ' ');
      updateCache({ id, title: id, preview, modificationTime: mtime });
      addToSearchIndex({ id, title: id, body, mtime });
    } catch {
      removeFromCache(id);
      removeFromSearchIndex(id);
    }
  }

  notesCache.sort((a, b) => b.modificationTime - a.modificationTime);
  schedulePersist();
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
  if (useRustCore) {
    await refreshNotesFromStorage();
  } else {
    const preview = content.slice(0, 100).replace(/\n/g, ' ');
    updateCache({ id, title, preview, modificationTime: mtime });
    addToSearchIndex({ id, title: id, body: content, mtime });
    schedulePersist();
  }

  return { id, mtime };
}

export async function updateNote(
  id: string,
  title: string,
  content: string,
  originalId?: string,
  overrideMtime?: number,
): Promise<{ id: string; mtime: number }> {
  const finalId = await getUniqueNoteId(id, originalId);
  let mtime: number;

  if (originalId && originalId !== finalId) {
    mtime = await renameNoteFile(originalId, finalId, content, overrideMtime);
    renameEngagement(originalId, finalId);
    await trackLocalRenameForSync(originalId, finalId);
    if (!useRustCore) {
      removeFromSearchIndex(originalId);
      removeFromCache(originalId);
    }
  } else {
    mtime = await writeNote(finalId, content, overrideMtime);
  }

  if (useRustCore) {
    await refreshNotesFromStorage();
  } else {
    const preview = content.slice(0, 100).replace(/\n/g, ' ');
    updateCache({ id: finalId, title, preview, modificationTime: mtime });
    addToSearchIndex({ id: finalId, title: finalId, body: content, mtime });
    schedulePersist();
  }
  trackEdit(finalId);

  return { id: finalId, mtime };
}

export async function deleteNote(id: string, options: { trackSyncDelete?: boolean } = {}): Promise<void> {
  await deleteNoteFile(id);
  removeEngagement(id);
  if (useRustCore) {
    await refreshNotesFromStorage();
  } else {
    removeFromCache(id);
    removeFromSearchIndex(id);
    schedulePersist();
  }

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
  if (!useRustCore) {
    initSearchIndex();
  }
}

export function search(query: string): SearchResultItem[] {
  if (useRustCore) {
    if (!query.trim()) {
      return getAllNotes().map((note) => ({ note, snippet: null }));
    }
    const lower = query.trim().toLowerCase();
    return notesCache
      .filter((note) => note.id.toLowerCase().includes(lower) || note.preview.toLowerCase().includes(lower))
      .map((note) => ({ note, snippet: [{ text: note.preview, highlight: false }] }));
  }

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

export async function searchKeyword(query: string): Promise<SearchResultItem[]> {
  if (useRustCore) {
    return keywordSearchRust(query);
  }
  return search(query);
}

export interface SearchTimingResult {
  results: SearchResultItem[];
  mode: SearchMode;
  timing: {
    keyword: number;
    embed: number;
    vector: number;
    total: number;
  };
}

export async function searchWithVectors(query: string, signal?: AbortSignal): Promise<SearchTimingResult> {
  const totalStart = performance.now();

  if (!query.trim()) {
    const all = getAllNotes().map((note) => ({ note, snippet: null }));
    return {
      results: all,
      mode: getSearchMode(),
      timing: { keyword: 0, embed: 0, vector: 0, total: 0 },
    };
  }

  const mode = getSearchMode();

  // Keyword search
  let keywordResults: SearchResultItem[] = [];
  let keywordTime = 0;
  if (mode === 'keyword' || mode === 'hybrid') {
    const kwStart = performance.now();
    keywordResults = await searchKeyword(query);
    keywordTime = performance.now() - kwStart;
  }

  // If keyword-only mode, return immediately
  if (mode === 'keyword') {
    keywordResults.forEach(r => r.source = 'keyword');
    return {
      results: keywordResults,
      mode,
      timing: { keyword: keywordTime, embed: 0, vector: 0, total: performance.now() - totalStart },
    };
  }

  // Check if supersearch is available for vector/hybrid modes
  const ready = await isSupersearchReady();
  if (!ready || !isEmbedderReady()) {
    // Fall back to keyword results
    if (mode === 'vector') {
      return {
        results: [],
        mode,
        timing: { keyword: 0, embed: 0, vector: 0, total: performance.now() - totalStart },
      };
    }
    keywordResults.forEach(r => r.source = 'keyword');
    return {
      results: keywordResults,
      mode: 'keyword',
      timing: { keyword: keywordTime, embed: 0, vector: 0, total: performance.now() - totalStart },
    };
  }

  try {
    // Embed query via server
    const embedStart = performance.now();
    const queryVector = await embed(query, signal);
    const embedTime = performance.now() - embedStart;

    // Vector search locally
    const vecStart = performance.now();
    const rawVectorResults = await vectorSearch(queryVector, 20);
    const vectorTime = performance.now() - vecStart;

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

    if (mode === 'vector') {
      // Vector-only: build results from vector hits
      const results: SearchResultItem[] = mappedResults.map(vr => {
        const note = cacheMap.get(vr.uuid)!;
        const text = vr.chunkText.slice(0, 120).replace(/\n/g, ' ');
        return {
          note,
          snippet: [{ text, highlight: false }],
          source: 'vector' as const,
        };
      });
      return {
        results,
        mode,
        timing: { keyword: 0, embed: embedTime, vector: vectorTime, total: performance.now() - totalStart },
      };
    }

    // Hybrid: fuse with RRF
    const keywordIds = new Set(keywordResults.map(r => r.note.id));
    const vectorIds = new Set(mappedResults.map(r => r.uuid));
    const fused = hybridSearch(keywordResults, mappedResults, cacheMap);

    // Tag sources
    for (const r of fused) {
      const inKw = keywordIds.has(r.note.id);
      const inVec = vectorIds.has(r.note.id);
      r.source = inKw && inVec ? 'both' : inKw ? 'keyword' : 'vector';
    }

    return {
      results: fused,
      mode,
      timing: { keyword: keywordTime, embed: embedTime, vector: vectorTime, total: performance.now() - totalStart },
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw e;
    }
    console.warn('[supersearch] vector search failed:', e);
    if (mode === 'vector') {
      return {
        results: [],
        mode,
        timing: { keyword: 0, embed: 0, vector: 0, total: performance.now() - totalStart },
      };
    }

    keywordResults.forEach(r => r.source = 'keyword');
    return {
      results: keywordResults,
      mode: 'keyword',
      timing: { keyword: keywordTime, embed: 0, vector: 0, total: performance.now() - totalStart },
    };
  }
}

export async function handleExternalFileChange(
  type: 'add' | 'change' | 'unlink',
  filename: string,
): Promise<NotePreview | null> {
  const id = filename.replace(/\.md$/, '');

  if (useRustCore) {
    if (type === 'unlink') {
      await markLocalDeleteForSync(id);
    }
    await refreshNotesFromStorage();
    return getNoteById(id) ?? null;
  }

  if (type === 'unlink') {
    removeFromCache(id);
    removeFromSearchIndex(id);
    await markLocalDeleteForSync(id);
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

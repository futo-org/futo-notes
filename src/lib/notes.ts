import { NotePreview, SearchResultItem } from '../types';
import {
  writeNote,
  deleteNoteFile,
  deleteAllContent,
  renameNote as renameNoteFile,
  getUniqueNoteId
} from './fileSystem';
import { ensureNotesFolder, getPlatformFS } from './platform';
import { markLocalDeleteForSync, trackLocalRenameForSync, clearSyncState, loadSyncState, findIdForUuid } from './syncState';
import { loadEngagement, trackEdit, removeEngagement, renameEngagement } from './engagement';
import { embed, isReady as isEmbedderReady } from './supersearch/queryEmbedder';
import { vectorSearch, type VectorSearchResult } from './supersearch/vectorSearch';
import { hybridSearch } from './supersearch/hybridSearch';
import { isSupersearchReady } from './supersearch/state';
import { getRustNotePreviews, hasRustCore, keywordSearchRust, rebuildRustIndex } from './rustCore';

// In-memory cache of notes metadata
let notesCache: NotePreview[] = [];
let initialized = false;

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
    notesCache.push({ id, title: id, preview: lines.slice(0, 3).join(' ').slice(0, 200), modificationTime: mtime });
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
    await trackLocalRenameForSync(originalId, finalId);
  } else {
    mtime = await writeNote(finalId, content, overrideMtime);
  }

  if (hasRustCore()) {
    await refreshNotesFromStorage();
  } else {
    const lines = content.split('\n');
    const idx = notesCache.findIndex(n => n.id === (originalId ?? finalId));
    const preview = { id: finalId, title: finalId, preview: lines.slice(0, 3).join(' ').slice(0, 200), modificationTime: mtime };
    if (idx >= 0) notesCache[idx] = preview; else notesCache.push(preview);
  }
  trackEdit(finalId);

  return { id: finalId, mtime };
}

export async function deleteNote(id: string, options: { trackSyncDelete?: boolean } = {}): Promise<void> {
  await deleteNoteFile(id);
  removeEngagement(id);
  if (hasRustCore()) {
    await refreshNotesFromStorage();
  } else {
    notesCache = notesCache.filter(n => n.id !== id);
  }

  if (options.trackSyncDelete !== false) {
    await markLocalDeleteForSync(id);
  }
}

export async function deleteAllNotes(): Promise<void> {
  // Pause auto-sync for the duration of the reset. Without this, an SSE-triggered
  // sync can race between steps and see files on disk with no UUID mappings,
  // generating new UUIDs that create duplicate notes on the server.
  const { pauseSync, resumeSync, waitForSyncIdle } = await import('./autoSync');
  pauseSync();
  try {
    await waitForSyncIdle();
    await deleteAllContent();
    await clearSyncState();
    notesCache = [];
  } finally {
    resumeSync();
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

export interface SearchTimingResult {
  results: SearchResultItem[];
  timing: {
    keyword: number;
    embed: number;
    vector: number;
    total: number;
  };
}

const VECTOR_DEADLINE_MS = 300;

export async function searchWithVectors(query: string, signal?: AbortSignal): Promise<SearchTimingResult> {
  const totalStart = performance.now();

  if (!query.trim()) {
    const all = getAllNotes().map((note) => ({ note, snippet: null }));
    return {
      results: all,
      timing: { keyword: 0, embed: 0, vector: 0, total: 0 },
    };
  }

  // 1. Always run keyword search
  const kwStart = performance.now();
  const keywordResults = await searchKeyword(query);
  const keywordTime = performance.now() - kwStart;

  // 2. Check if vector search is possible (server available + local artifacts)
  const ready = await isSupersearchReady();
  if (!ready || !isEmbedderReady()) {
    keywordResults.forEach(r => r.source = 'keyword');
    return {
      results: keywordResults,
      timing: { keyword: keywordTime, embed: 0, vector: 0, total: performance.now() - totalStart },
    };
  }

  // 3. Race server embed against 300ms deadline
  try {
    const embedStart = performance.now();
    const queryVector = await Promise.race([
      embed(query, signal),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), VECTOR_DEADLINE_MS)),
    ]);
    const embedTime = performance.now() - embedStart;

    if (!queryVector) {
      // Timeout — return keyword only
      keywordResults.forEach(r => r.source = 'keyword');
      return {
        results: keywordResults,
        timing: { keyword: keywordTime, embed: embedTime, vector: 0, total: performance.now() - totalStart },
      };
    }

    // 4. Local vector search (sub-ms)
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

    // 5. Hybrid: fuse with RRF
    const keywordIds = new Set(keywordResults.map(r => r.note.id));
    const vectorIds = new Set(mappedResults.map(r => r.uuid));
    const fused = hybridSearch(keywordResults, mappedResults, cacheMap);

    for (const r of fused) {
      const inKw = keywordIds.has(r.note.id);
      const inVec = vectorIds.has(r.note.id);
      r.source = inKw && inVec ? 'both' : inKw ? 'keyword' : 'vector';
    }

    return {
      results: fused,
      timing: { keyword: keywordTime, embed: embedTime, vector: vectorTime, total: performance.now() - totalStart },
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw e;
    }
    console.warn('[supersearch] vector search failed:', e);
    keywordResults.forEach(r => r.source = 'keyword');
    return {
      results: keywordResults,
      timing: { keyword: keywordTime, embed: 0, vector: 0, total: performance.now() - totalStart },
    };
  }
}

export async function handleExternalFileChange(
  type: 'add' | 'change' | 'unlink',
  filename: string,
): Promise<NotePreview | null> {
  const id = filename.replace(/\.md$/, '');

  if (type === 'unlink') {
    await markLocalDeleteForSync(id);
  }
  await refreshNotesFromStorage();
  return getNoteById(id) ?? null;
}

export { readNote, noteExists, getUniqueNoteId } from './fileSystem';

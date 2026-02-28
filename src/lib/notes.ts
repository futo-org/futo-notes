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
import { getSearchMode, type SearchMode } from './supersearch/searchMode';
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
  // Mark every note for sync deletion so tombstones propagate to server
  for (const note of notesCache) {
    await markLocalDeleteForSync(note.id);
  }
  await deleteAllContent();
  await clearSyncState();
  notesCache = [];
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

  if (type === 'unlink') {
    await markLocalDeleteForSync(id);
  }
  await refreshNotesFromStorage();
  return getNoteById(id) ?? null;
}

export { readNote, noteExists, getUniqueNoteId } from './fileSystem';

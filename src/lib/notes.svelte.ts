import type { NotePreview, SearchResultItem } from '../types';
import {
  writeNote,
  deleteNoteFile,
  deleteAllContent,
  renameNote as renameNoteFile,
  moveNoteFile,
  getUniqueNoteId,
  readNote as readNoteFile,
} from './fileSystem';
import { ensureNotesFolder, getFS, getPlatformFS } from './platform';
import { idLeaf } from './platform/pathSafety';
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
import { rewriteWikilinks } from './wikilinks';
import { refreshEmptyFolders } from './folders.svelte';
import { writeSuppressor } from './writeSuppression';

// Matches notesIndex.ts READ_POOL_CONCURRENCY.
const RECONCILE_CONCURRENCY = 8;

// Reactive in-memory cache of notes metadata. Mutations propagate through
// `$derived(sortedNotes)` and every `$effect` that reads `getAllNotes()`.
let notesCache = $state<NotePreview[]>([]);
let initialized = false;
// Resolves once `initNotes()` has populated `notesCache`. Consumers that
// need an accurate snapshot (e.g. tab-restore predicate) await this so
// they don't run against an empty-but-not-yet-loaded cache.
let notesReadyResolve: (() => void) | null = null;
const notesReadyPromise: Promise<void> = new Promise((resolve) => {
  notesReadyResolve = resolve;
});

/** Resolves once `initNotes()` finishes populating notesCache from disk.
 *  Always-defined so callers can `await` regardless of init state. */
export function whenNotesReady(): Promise<void> {
  return notesReadyPromise;
}

// Tracks the in-flight (or completed) search-index bootstrap so search()
// can wait for it without blocking initNotes() / UI rendering on it.
// initNotes() returns as soon as notesCache is populated; the index is
// built in the background. See AGENTS.md "Editor responsiveness is sacred".
let searchIndexReady: Promise<void> | null = null;

const sortedNotes = $derived.by(() =>
  [...notesCache].sort(
    (a, b) => b.modificationTime - a.modificationTime || a.id.localeCompare(b.id),
  ),
);

/** Test-only: inject a note into the cache without filesystem access. */
export function _injectTestNote(id: string, title: string): void {
  notesCache.push({ id, title, preview: '', modificationTime: Date.now(), tags: [] });
}

/** A note's display title is the leaf component of its path-ID — the
 *  filename without `.md` and without parent folders. */
export function noteTitleFromId(id: string): string {
  return idLeaf(id);
}

export async function initNotes(onStep?: (label: string) => void): Promise<void> {
  if (initialized) return;

  onStep?.('initNotes: getPlatformFS');
  await getPlatformFS(); // Initialize platform FS before any file operations
  onStep?.('initNotes: ensureNotesFolder');
  await ensureNotesFolder();

  onStep?.('initNotes: scanNotePreviewsWithBodies');
  const { previews, freshBodies } = await scanNotePreviewsWithBodies(getFS());
  notesCache = previews;

  // Hydrate the empty-folder set from disk so user-created folders that
  // contain no notes still show up after reload. Background — never
  // block the UI on this.
  void refreshEmptyFolders(previews).catch((err) => {
    console.warn('Empty-folder refresh failed:', err);
  });

  // Build the search index in the background. Search awaits
  // searchIndexReady, but the UI can render the note list immediately.
  // Past hangs ("stuck on bootstrapSearchIndex") were not a fast-path
  // bug to optimize away — they were UI gated on background I/O.
  searchIndexReady = bootstrapSearchIndex(freshBodies).catch((err) => {
    console.warn('Search index bootstrap failed:', err);
  });

  onStep?.('initNotes: done');
  initialized = true;
  // Wake any consumers that await whenNotesReady() — typically the tab
  // restore in NotesShell, which must NOT build its valid-noteIds set
  // against an empty pre-scan cache.
  notesReadyResolve?.();
  notesReadyResolve = null;
}

/** Test/diagnostic helper: resolve when the in-flight (or most recent)
 * bootstrap finishes. Always-defined so tests can `await` regardless
 * of whether bootstrap is still running. */
export function whenSearchIndexReady(): Promise<void> {
  return searchIndexReady ?? Promise.resolve();
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
      addToSearchIndex({ id: note.id, title: noteTitleFromId(note.id), body, mtime: note.modificationTime });
    } else {
      stillNeeded.push(note);
    }
  }

  if (stillNeeded.length === 0) return;

  await runPool(stillNeeded, RECONCILE_CONCURRENCY, async (note) => {
    try {
      const body = await fs.readNote(note.id);
      addToSearchIndex({ id: note.id, title: noteTitleFromId(note.id), body, mtime: note.modificationTime });
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
      addToSearchIndex({ id: note.id, title: noteTitleFromId(note.id), body: cachedBody, mtime: note.modificationTime });
    } else {
      toRead.push(note);
    }
  }

  if (toRead.length === 0) return;
  await runPool(toRead, RECONCILE_CONCURRENCY, async (note) => {
    try {
      const body = await fs.readNote(note.id);
      addToSearchIndex({ id: note.id, title: noteTitleFromId(note.id), body, mtime: note.modificationTime });
    } catch {
      // Skip unreadable files
    }
  });
}

export async function refreshNotesFromStorage(): Promise<void> {
  const { previews, freshBodies } = await scanNotePreviewsWithBodies(getFS());
  notesCache = previews;
  // Serialize after any in-flight bootstrap — otherwise the bootstrap
  // pool and reconcile pool race on the same MiniSearch / mtimeMap.
  const prior = searchIndexReady ?? Promise.resolve();
  searchIndexReady = prior.then(() => reconcileSearchIndex(freshBodies));
  await searchIndexReady;
  void persistIndex();
  // Reconcile the empty-folder set against disk after any bulk refresh
  // (sync apply, watcher rebuild, folder operation). Background — the
  // sidebar doesn't gate on this.
  void refreshEmptyFolders(previews).catch((err) => {
    console.warn('Empty-folder refresh failed:', err);
  });
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
    title: noteTitleFromId(id),
    preview: makePreview(content),
    modificationTime: mtime,
    tags: extractTags(content),
  });
  addToSearchIndex({ id, title: noteTitleFromId(id), body: content, mtime });

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
    removeFromSearchIndex(originalId);
    await rewriteWikilinksForRename(originalId, finalId);
  } else {
    mtime = await writeNote(finalId, content, overrideMtime);
  }

  const preview: NotePreview = {
    id: finalId,
    title: noteTitleFromId(finalId),
    preview: makePreview(content),
    modificationTime: mtime,
    tags: extractTags(content),
  };
  // Prefer the originalId match; if moveNote already optimistically
  // re-keyed the entry to finalId, find it there instead of pushing a
  // duplicate.
  let idx = notesCache.findIndex(n => n.id === (originalId ?? finalId));
  if (idx < 0 && originalId) idx = notesCache.findIndex(n => n.id === finalId);
  if (idx >= 0) notesCache[idx] = preview; else notesCache.push(preview);

  addToSearchIndex({ id: finalId, title: noteTitleFromId(finalId), body: content, mtime });

  return { id: finalId, mtime };
}

/**
 * Rewrite every wikilink in every other note that targets `oldId` to
 * point at `newId`. Touches only notes whose body actually contains a
 * wikilink — we read each note, run `rewriteWikilinks`, and only write
 * back if the body changed. The rewrites become regular note edits that
 * sync as content changes.
 */
export async function rewriteWikilinksForRename(
  oldId: string,
  newId: string,
): Promise<void> {
  if (oldId === newId) return;
  const fs = getFS();
  const allIds = notesCache.map((n) => n.id);
  // Read in a bounded pool so a large vault doesn't block on serial IPC.
  await runPool(notesCache.slice(), RECONCILE_CONCURRENCY, async (note) => {
    if (note.id === newId || note.id === oldId) return;
    let body: string;
    try {
      body = await readNoteFile(note.id);
    } catch {
      return;
    }
    if (!body.includes('[[')) return;
    const result = rewriteWikilinks(body, oldId, newId, allIds);
    if (result.rewrites === 0 || result.text === body) return;
    try {
      const newMtime = await fs.writeNote(note.id, result.text);
      const idx = notesCache.findIndex((n) => n.id === note.id);
      if (idx >= 0) {
        notesCache[idx] = {
          ...notesCache[idx],
          preview: makePreview(result.text),
          modificationTime: newMtime,
          tags: extractTags(result.text),
        };
      }
      addToSearchIndex({ id: note.id, title: noteTitleFromId(note.id), body: result.text, mtime: newMtime });
    } catch (err) {
      console.warn(`[wikilink-rewrite] Failed to update ${note.id}:`, err);
    }
  });
}

/**
 * Move a note from `fromId` to `toId`. Atomically renames the file on
 * disk so its mtime is preserved (no second sort jump after the
 * optimistic cache update) and rewrites every wikilink in every other
 * note that targets `fromId`. Returns the final ID, which may differ
 * from the requested `toId` if a file already exists there.
 *
 * The cache is updated optimistically — the sidebar reflects the new
 * position the moment this fn is called, without waiting for the
 * IPC chain. If the disk work fails the cache is reverted before the
 * rejection propagates.
 */
export async function moveNote(
  fromId: string,
  toId: string,
): Promise<{ id: string; mtime: number }> {
  if (fromId === toId) {
    const note = notesCache.find((n) => n.id === fromId);
    return { id: fromId, mtime: note?.modificationTime ?? Date.now() };
  }
  const idx = notesCache.findIndex((n) => n.id === fromId);
  const prev = idx >= 0 ? notesCache[idx] : null;
  if (prev) {
    notesCache[idx] = { ...prev, id: toId, title: noteTitleFromId(toId) };
  }
  try {
    const finalId = await getUniqueNoteId(toId);
    if (finalId !== toId && prev) {
      notesCache[idx] = { ...notesCache[idx], id: finalId, title: noteTitleFromId(finalId) };
    }
    // Atomic rename — preserves the file's mtime, so the cache entry's
    // existing modificationTime stays accurate. The sidebar doesn't
    // re-sort after the disk op completes.
    await moveNoteFile(fromId, finalId);
    const mtime = prev?.modificationTime ?? Date.now();
    // Re-key the search index from the moved file's body. Body unchanged,
    // so we just need fromId removed and finalId added.
    removeFromSearchIndex(fromId);
    try {
      const body = await readNoteFile(finalId);
      addToSearchIndex({ id: finalId, title: noteTitleFromId(finalId), body, mtime });
    } catch {
      // Best-effort — file should be readable after rename.
    }
    // Other notes' wikilinks targeting fromId now need to point at finalId.
    await rewriteWikilinksForRename(fromId, finalId);
    return { id: finalId, mtime };
  } catch (err) {
    if (prev && idx >= 0) notesCache[idx] = prev;
    throw err;
  }
}

/**
 * Re-base every cached note whose ID lives under `fromPrefix` to live
 * under `toPrefix`. Idempotent across two starting states:
 *
 *   - If the folder still exists on disk at the old prefix, this fn
 *     issues `fs.renameFolder` to move every file in the subtree
 *     atomically before reconciling.
 *   - If the caller already ran `fs.renameFolder` (the typical sidebar
 *     drag-drop / rename path, which needs to validate before touching
 *     the file tree), the rename below is skipped.
 *
 * In both cases we then refresh notesCache from disk and rewrite every
 * wikilink in every other note that targets one of the moved IDs.
 */
export async function moveNotesUnderPrefix(
  fromPrefix: string,
  toPrefix: string,
): Promise<void> {
  if (fromPrefix === toPrefix) return;
  const fs = getFS();
  // Snapshot (oldId, newId) pairs from the current cache before any
  // refresh — the refresh replaces cache contents with new-prefix IDs.
  const pairs: Array<[string, string]> = [];
  for (const note of notesCache) {
    if (note.id === fromPrefix || note.id.startsWith(`${fromPrefix}/`)) {
      const tail = note.id === fromPrefix ? '' : note.id.slice(fromPrefix.length + 1);
      const newId = tail ? `${toPrefix}/${tail}` : toPrefix;
      pairs.push([note.id, newId]);
    }
  }
  // Suppress watcher events for every affected path before the FS work.
  // Without this, an active note under `fromPrefix` sees a watcher unlink
  // and syncManager fires "Note deleted externally", clobbering session
  // state. The 1s TTL covers debounce + dispatch latency.
  for (const [oldId, newId] of pairs) {
    writeSuppressor.recordWrite(`${oldId}.md`);
    writeSuppressor.recordWrite(`${newId}.md`);
  }
  // Try the FS-level rename. If the caller already moved the folder
  // (DrawerSidebar's drag-drop path validates and renames before calling
  // us), fs.renameFolder errors with "source folder does not exist" —
  // ignore and proceed with cache + wikilink reconciliation.
  if (fs.renameFolder) {
    try {
      await fs.renameFolder(fromPrefix, toPrefix);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!/does not exist/i.test(msg)) {
        console.warn(`[moveNotesUnderPrefix] renameFolder failed: ${msg}`);
      }
    }
  }
  await refreshNotesFromStorage();
  for (const [oldId, newId] of pairs) {
    await rewriteWikilinksForRename(oldId, newId);
  }
}

export async function deleteNote(id: string): Promise<void> {
  await deleteNoteFile(id);
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
    // Wait for any in-flight bootstrap to finish before clearing — otherwise
    // a stale pool read can re-add a deleted doc after clearSearchIndex().
    if (searchIndexReady) await searchIndexReady;
    await deleteAllContent();
    notesCache = [];
    clearSearchIndex();
    searchIndexReady = Promise.resolve();
    void persistIndex();
  } finally {
    resumeSyncV2();
  }
}

export async function search(query: string): Promise<SearchResultItem[]> {
  if (!query.trim()) {
    return getAllNotes().map((note) => ({ note, snippet: null }));
  }
  // Bootstrap runs in the background; wait for it so results are complete
  // for the first search after launch.
  if (searchIndexReady) await searchIndexReady;
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
  // Filename is now the relative path under the notes root (e.g.
  // `Specs/foo.md`); strip `.md` to get the ID.
  const id = filename.replace(/\\/g, '/').replace(/\.md$/, '');

  await refreshNotesFromStorage();
  return getNoteById(id) ?? null;
}

export { readNote, noteExists, getUniqueNoteId } from './fileSystem';

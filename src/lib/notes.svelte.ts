import type { NotePreview, SearchResultItem } from '../types';
import {
  writeNote,
  deleteNoteFileToTrash,
  deleteAllContent,
  createNoteFile,
  moveNoteFile,
  readNote as readNoteFile,
} from './fileSystem';
import { getFS, getPlatformFS } from './platform';
import { idLeaf } from './platform/pathSafety';
import { pauseSyncV2, resumeSyncV2, waitForSyncIdleV2 } from './autoSyncV2';
import { disconnectE2ee, stopLiveSync } from './syncServiceE2ee';
import { makePreview, noteTags, convertTxtToMd } from './notesIndex';
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
} from '$features/search/searchIndex';
import {
  engineQuery,
  engineNotify,
  engineStatus,
  engineRebuild,
} from '$features/search/searchEngine';
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

/**
 * Native-embed feed: replace the note universe wholesale, no filesystem
 * scan or search-index side effects. The embedded editor (editor.html in
 * the iOS/Android WebView shells) has no Tauri backend, so the host pushes
 * its note list through `FutoEditor.setNotes` → here, giving the wikilink
 * suffix resolver / autocomplete / resolution something to resolve against.
 */
export function setNotesUniverse(previews: NotePreview[]): void {
  notesCache = previews;
}

/** A note's display title is the leaf component of its path-ID — the
 *  filename without `.md` and without parent folders. */
export function noteTitleFromId(id: string): string {
  return idLeaf(id);
}

export async function initNotes(onStep?: (label: string) => void): Promise<void> {
  if (initialized) return;

  // Load the platform FS module (a dynamic import, not filesystem I/O —
  // this never hangs; the documented cold-sandbox hangs were the plugin-fs
  // *reads* below, now gone). initNotes() is itself fired un-awaited from
  // App.svelte AFTER `initialized = true`, so nothing here gates render.
  onStep?.('initNotes: getPlatformFS');
  const fs = await getPlatformFS();

  // Legacy one-way .txt → .md migration. The Rust scan only sees `.md`, so
  // run it BEFORE the scan (matches the prior ordering, where it lived inside
  // scanNotePreviewsWithBodies) so the first notesCache assignment is the
  // single, authoritative one — no background re-scan that could clobber an
  // optimistic mutation. It is gated by its own sentinel (a single cheap
  // readAppData for already-migrated users) and only touches the filesystem
  // when real `.txt` files exist; initNotes() is itself fully backgrounded
  // relative to render, so this does not gate the shell.
  onStep?.('initNotes: convertTxtToMd');
  await convertTxtToMd(fs).catch((err) => console.warn('.txt migration failed:', err));

  // Single IPC: Rust scans the whole vault and returns list metadata sorted
  // mtime-desc (futo-notes-model::scan_notes), feeding notesCache with no
  // remapping. Replaces the old plugin-fs listNoteFiles + N body reads +
  // ensureNotesFolder() — the Rust command does notes_root() → create_dir_all
  // itself, eliminating the iOS cold-sandbox plugin-fs hang on the note path.
  // Seed the shared welcome note on a brand-new vault BEFORE the scan, so the
  // first scan sees it. Idempotent (Rust no-ops when the vault is non-empty);
  // a failure must never block startup. Runs inside the already-backgrounded
  // initNotes() (fired un-awaited from App.svelte after initialized = true), so
  // this awaits without gating render. Same first run as iOS/Android.
  onStep?.('initNotes: seedIfEmpty');
  await fs.seedIfEmpty().catch((err) => console.warn('Welcome-note seed failed:', err));

  onStep?.('initNotes: notes_scan');
  const previews = await fs.scanNotes();
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
  // `notes_scan` returns metadata only (no bodies), so the index reads
  // bodies itself via notes_read; Phase 2 replaces this body entirely.
  searchIndexReady = bootstrapSearchIndex().catch((err) => {
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
 * persisted index exists, build from scratch.
 */
async function bootstrapSearchIndex(): Promise<void> {
  const loaded = await loadPersistedIndex();

  if (loaded) {
    await reconcileSearchIndex();
  } else {
    initSearchIndex();
    await buildSearchIndexFromScratch();
  }

  // Persist in the background — don't block startup on disk I/O.
  void persistIndex();
}

/**
 * Build the search index from every note in `notesCache`, reading each
 * body from disk through a bounded pool.
 */
async function buildSearchIndexFromScratch(): Promise<void> {
  const fs = getFS();

  await runPool(notesCache.slice(), RECONCILE_CONCURRENCY, async (note) => {
    try {
      const body = await fs.readNote(note.id);
      addToSearchIndex({
        id: note.id,
        title: noteTitleFromId(note.id),
        body,
        mtime: note.modificationTime,
      });
    } catch {
      // Skip unreadable files
    }
  });
}

/**
 * Reconcile the search index against the current notesCache: remove entries
 * for deleted notes, and re-read bodies for notes with new/changed mtimes.
 */
async function reconcileSearchIndex(): Promise<void> {
  const fs = getFS();
  const mtimes = getMtimeMap();
  const currentIds = new Set(notesCache.map((n) => n.id));

  for (const id of Object.keys(mtimes)) {
    if (!currentIds.has(id)) removeFromSearchIndex(id);
  }

  const toRead: NotePreview[] = [];
  for (const note of notesCache) {
    if (mtimes[note.id] === note.modificationTime) continue;
    toRead.push(note);
  }

  if (toRead.length === 0) return;
  await runPool(toRead, RECONCILE_CONCURRENCY, async (note) => {
    try {
      const body = await fs.readNote(note.id);
      addToSearchIndex({
        id: note.id,
        title: noteTitleFromId(note.id),
        body,
        mtime: note.modificationTime,
      });
    } catch {
      // Skip unreadable files
    }
  });
}

export async function refreshNotesFromStorage(): Promise<void> {
  // Coarse re-scan via the Rust command (one IPC) — matches today's
  // behavior on the watcher-driven re-feed path. The watcher debounces at
  // the OS level and filesystem_watcher.rs collapses rename pairs, so a full re-scan per
  // change is acceptable.
  const previews = await getFS().scanNotes();
  notesCache = previews;
  // Serialize after any in-flight bootstrap — otherwise the bootstrap
  // pool and reconcile pool race on the same MiniSearch / mtimeMap.
  const prior = searchIndexReady ?? Promise.resolve();
  searchIndexReady = prior.then(() => reconcileSearchIndex());
  await searchIndexReady;
  void persistIndex();
  // Reconcile the empty-folder set against disk after any bulk refresh
  // (sync apply, watcher rebuild, folder operation). Background — the
  // sidebar doesn't gate on this.
  void refreshEmptyFolders(previews).catch((err) => {
    console.warn('Empty-folder refresh failed:', err);
  });
}

export async function refreshNotesAfterSync(
  _updatedIds: string[],
  _deletedIds: string[],
): Promise<void> {
  await refreshNotesFromStorage();
}

export function getAllNotes(): NotePreview[] {
  return sortedNotes;
}

export function getNoteById(id: string): NotePreview | undefined {
  return notesCache.find((n) => n.id === id);
}

export async function createNote(
  id: string,
  content: string,
  overrideMtime?: number,
): Promise<{ id: string; mtime: number }> {
  // The domain resolves the id collision and creates the note; the content
  // write follows (createNote's callers always have body content ready).
  const slash = id.lastIndexOf('/');
  const folder = slash === -1 ? '' : id.slice(0, slash);
  const title = slash === -1 ? id : id.slice(slash + 1);
  id = await createNoteFile(folder, title);
  const mtime = await writeNote(id, content, overrideMtime);

  notesCache.push({
    id,
    title: noteTitleFromId(id),
    preview: makePreview(content),
    modificationTime: mtime,
    tags: noteTags(content),
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
  let finalId: string;
  let mtime: number;

  if (!originalId) {
    // Brand-new note: the domain resolves the id collision and creates the
    // file, then the current body is written to the resolved id.
    const slash = id.lastIndexOf('/');
    const folder = slash === -1 ? '' : id.slice(0, slash);
    const title = slash === -1 ? id : id.slice(slash + 1);
    finalId = await createNoteFile(folder, title);
    mtime = await writeNote(finalId, content, overrideMtime);
  } else if (originalId !== id) {
    // Title changed → atomic rename (the domain resolves any collision and,
    // on a case/NFC-only change, routes through a temp hop). Persist the
    // current body to the renamed note, then relink references to it.
    finalId = await moveNoteFile(originalId, id);
    mtime = await writeNote(finalId, content, overrideMtime);
    removeFromSearchIndex(originalId);
    await rewriteWikilinksForRename(originalId, finalId);
  } else {
    // Same id → plain content save.
    finalId = id;
    mtime = await writeNote(finalId, content, overrideMtime);
  }

  const preview: NotePreview = {
    id: finalId,
    title: noteTitleFromId(finalId),
    preview: makePreview(content),
    modificationTime: mtime,
    tags: noteTags(content),
  };
  // Prefer the originalId match; if moveNote already optimistically
  // re-keyed the entry to finalId, find it there instead of pushing a
  // duplicate.
  let idx = notesCache.findIndex((n) => n.id === (originalId ?? finalId));
  if (idx < 0 && originalId) idx = notesCache.findIndex((n) => n.id === finalId);
  if (idx >= 0) notesCache[idx] = preview;
  else notesCache.push(preview);

  addToSearchIndex({ id: finalId, title: noteTitleFromId(finalId), body: content, mtime });

  return { id: finalId, mtime };
}

/**
 * Rewrite every wikilink in every note that targets `oldId` to point at
 * `newId` — including self-referencing links in the renamed note's own
 * body (spec: editor.md). Touches only notes whose body actually contains
 * a wikilink — we read each note, run `rewriteWikilinks`, and only write
 * back if the body changed. The rewrites become regular note edits that
 * sync as content changes.
 */
export async function rewriteWikilinksForRename(oldId: string, newId: string): Promise<void> {
  if (oldId === newId) return;
  const fs = getFS();
  const allIds = notesCache.map((n) => n.id);
  // Read in a bounded pool so a large vault doesn't block on serial IPC.
  await runPool(notesCache.slice(), RECONCILE_CONCURRENCY, async (note) => {
    // The renamed note itself is NOT skipped: its self-links follow the
    // rename too. Its cache entry may still be keyed oldId (updateNote
    // re-keys after this pass) while the file already lives at newId —
    // always read/write the file that exists.
    const fileId = note.id === oldId ? newId : note.id;
    let body: string;
    try {
      body = await readNoteFile(fileId);
    } catch {
      return;
    }
    if (!body.includes('[[')) return;
    const result = rewriteWikilinks(body, oldId, newId, allIds);
    if (result.rewrites === 0 || result.text === body) return;
    try {
      const newMtime = await fs.writeNote(fileId, result.text);
      const idx = notesCache.findIndex((n) => n.id === note.id);
      if (idx >= 0) {
        notesCache[idx] = {
          ...notesCache[idx],
          preview: makePreview(result.text),
          modificationTime: newMtime,
          tags: noteTags(result.text),
        };
      }
      addToSearchIndex({
        id: fileId,
        title: noteTitleFromId(fileId),
        body: result.text,
        mtime: newMtime,
      });
      // This write goes through getFS() directly (not the fileSystem.ts
      // chokepoint), so notify the Rust engine here to mirror MiniSearch.
      void engineNotify('change', `${fileId}.md`);
    } catch (err) {
      console.warn(`[wikilink-rewrite] Failed to update ${fileId}:`, err);
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
    // Atomic rename — the domain resolves any id collision and preserves the
    // file's mtime, so the cache entry's existing modificationTime stays
    // accurate. The sidebar doesn't re-sort after the disk op completes.
    const finalId = await moveNoteFile(fromId, toId);
    if (finalId !== toId && prev) {
      notesCache[idx] = { ...notesCache[idx], id: finalId, title: noteTitleFromId(finalId) };
    }
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
export async function moveNotesUnderPrefix(fromPrefix: string, toPrefix: string): Promise<void> {
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
  await deleteNoteFileToTrash(id);
  removeFromSearchIndex(id);
  notesCache = notesCache.filter((n) => n.id !== id);
  void persistIndex();
}

export async function deleteAllNotes(): Promise<void> {
  // Pause every sync entrypoint for the duration of the reset. The Rust live
  // loop can push independently of the TS scheduler, so stop it and drop the
  // E2EE session before the vault disappears on disk.
  pauseSyncV2();
  try {
    await stopLiveSync();
    await waitForSyncIdleV2();
    // Durably kill the sync session BEFORE touching the vault: drop the
    // connection + stored password (Rust e2ee_disconnect also stops the live
    // loop). Merely pausing is not enough — a resumed, still-authenticated
    // session would diff the emptied vault against the persisted object map
    // and push tombstones for every note, i.e. real deletions on every other
    // device (settings.md "Full reset"). The next launch then stays LOCAL.
    // Safe when not connected: disconnectE2ee tolerates a local-only client.
    await disconnectE2ee();
    // Wait for any in-flight bootstrap to finish before clearing — otherwise
    // a stale pool read can re-add a deleted doc after clearSearchIndex().
    if (searchIndexReady) await searchIndexReady;
    await deleteAllContent();
    notesCache = [];
    clearSearchIndex();
    // The bulk wipe bypasses the per-note fileSystem chokepoint, so the Rust
    // engine won't be notified file-by-file. Rescan the (now empty) vault to
    // clear its Tantivy index in lockstep with MiniSearch.
    void engineRebuild();
    searchIndexReady = Promise.resolve();
    void persistIndex();
  } finally {
    // Un-pause so a failed reset doesn't leave sync permanently dead. On the
    // success path this is inert: the session was disconnected above, so
    // isE2eeConfigured() is false and nothing can sync (the caller reloads
    // the app right after anyway).
    resumeSyncV2();
  }
}

export async function search(query: string): Promise<SearchResultItem[]> {
  if (!query.trim()) {
    return getAllNotes().map((note) => ({ note, snippet: null }));
  }
  // Prefer the Rust futo-notes-search engine (Tantivy BM25) when it's
  // reachable, has a ready keyword index, and returns hits. MiniSearch stays as
  // the coexisting fallback (parity window) for non-Tauri, not-yet-initialized,
  // or empty-result cases.
  //
  // The early return below trusts the engine's hits outright, so it is only
  // safe when the engine is fresh. The primary guarantee comes from notifying
  // it on every local mutation (see fileSystem.ts + rewriteWikilinksForRename)
  // plus the watcher path for external edits. This status gate is a
  // belt-and-suspenders: while the keyword index is still reconciling at boot,
  // skip the engine and let MiniSearch (already current) answer.
  const [engineHits, status] = await Promise.all([engineQuery(query), engineStatus()]);
  if (status?.keyword.ready && engineHits && engineHits.length > 0) {
    const results: SearchResultItem[] = [];
    for (const hit of engineHits) {
      const note = notesCache.find((n) => n.id === hit.noteId);
      if (note) {
        // The engine returns ranked note IDs, not term-level match data, so
        // fall back to the note preview for the snippet.
        results.push({
          note,
          snippet: note.preview ? [{ text: note.preview, highlight: false }] : null,
          source: 'keyword' as const,
        });
      }
    }
    if (results.length > 0) return results;
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

/**
 * Apply a single external (watcher/sync) file change incrementally instead of
 * re-scanning the whole vault. The `fs:change` event already names the file, so
 * we touch exactly one `notesCache` entry + its MiniSearch index entry:
 *
 *   - file gone  → remove the cache entry + `removeFromSearchIndex(id)`
 *   - file present → read its body once, re-derive title/preview/tags (the same
 *     canonical rules optimistic local edits use), refresh the single entry, and
 *     re-index it.
 *
 * Authoritative mtime comes from a `listNoteFiles()` dir-walk (metadata only —
 * NO body reads), so the sidebar sort stays correct without the old N-body
 * full rescan. Any unexpected failure falls back to `refreshNotesFromStorage()`
 * so a partial update can never strand the cache. Bulk/unknown events still go
 * through `refreshNotesFromStorage()` (see syncManager's bulk path).
 */
export async function handleExternalFileChange(filename: string): Promise<NotePreview | null> {
  // Filename is now the relative path under the notes root (e.g.
  // `Specs/foo.md`); strip `.md` to get the ID.
  const id = filename.replace(/\\/g, '/').replace(/\.md$/, '');
  if (!id) return null;

  try {
    const fs = getFS();
    const exists = await fs.noteExists(id);
    if (!exists) {
      // Removal: drop the single entry + its index row. No I/O beyond the
      // existence probe.
      const had = notesCache.some((n) => n.id === id);
      if (had) {
        notesCache = notesCache.filter((n) => n.id !== id);
        removeFromSearchIndex(id);
        void persistIndex();
      }
      return null;
    }

    // Add/change: one body read + one metadata walk (no other body reads).
    const body = await fs.readNote(id);
    const mtime = await mtimeForId(fs, id);
    const preview: NotePreview = {
      id,
      title: noteTitleFromId(id),
      preview: makePreview(body),
      modificationTime: mtime,
      tags: noteTags(body),
    };
    const idx = notesCache.findIndex((n) => n.id === id);
    if (idx >= 0) notesCache[idx] = preview;
    else notesCache.push(preview);
    addToSearchIndex({ id, title: noteTitleFromId(id), body, mtime });
    void persistIndex();
    return preview;
  } catch (err) {
    // A single-file update should never strand the cache: fall back to the
    // coarse rescan on any unexpected failure.
    console.warn(`[note-change] incremental update for "${id}" failed; full rescan:`, err);
    await refreshNotesFromStorage();
    return getNoteById(id) ?? null;
  }
}

/** Authoritative mtime for a single note from a metadata-only dir walk
 *  (no body reads). Falls back to the existing cache mtime, then `Date.now()`,
 *  so the sort never regresses if the file vanished between probe and walk. */
async function mtimeForId(fs: ReturnType<typeof getFS>, id: string): Promise<number> {
  try {
    const files = await fs.listNoteFiles();
    const target = `${id}.md`;
    for (const f of files) {
      if (f.name.replace(/\\/g, '/') === target) return f.mtime;
    }
  } catch {
    // fall through to cache/now
  }
  return getNoteById(id)?.modificationTime ?? Date.now();
}

export { readNote, noteExists } from './fileSystem';

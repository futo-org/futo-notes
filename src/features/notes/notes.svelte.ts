import type { NotePreview } from '$shared/types/note';
import type { SearchResultItem } from '$shared/types/search';
import {
  currentLocalNoteStore,
  getLocalNoteStore,
  getLocalNoteStoreSync,
  type LocalNoteListingSnapshot,
  type LocalNoteMetadata,
  type LocalNoteMutation,
  type LocalNoteSnapshot,
} from '$lib/localNoteStore';
import { pauseSyncV2, resumeSyncV2, waitForSyncIdleV2 } from '$features/sync/autoSyncV2';
import { disconnectE2ee, stopLiveSync } from '$features/sync/syncServiceE2ee';
import { setFolderSnapshot } from '$features/folders/emptyFolders.svelte';
import { buildWikilinkIndex, type WikilinkIndex } from '$shared/note/wikilinks';

/** How startup init settled: 'failed' means the cache is empty because
 * bootstrap failed, not because the vault is empty — awaiters must not treat
 * it as an authoritative empty note list. */
export type NotesReadiness = 'ready' | 'failed';

let notesCache = $state.raw<NotePreview[]>([]);
let initialized = false;
let notesReadyResolve: ((readiness: NotesReadiness) => void) | null = null;
const notesReadyPromise = new Promise<NotesReadiness>((resolve) => {
  notesReadyResolve = resolve;
});
let searchReady: Promise<void> | null = null;
let projectionRevision = 0;

/** Upper bound on how long a search waits for the index to become ready before
 * degrading to whatever the store returns (empty until ready). Prevents a
 * never-ready engine from hanging every search forever (A4). */
let searchReadyTimeoutMs = 4000;

/** Test seam: shorten the bounded search-readiness wait. */
export function _setSearchReadyTimeoutForTest(ms: number): void {
  searchReadyTimeoutMs = ms;
}

function preview(note: LocalNoteMetadata): NotePreview {
  return {
    id: note.id,
    title: note.title,
    preview: note.preview,
    modificationTime: note.modifiedMs,
    tags: note.tags,
  };
}

function replaceFromSnapshot(snapshot: LocalNoteSnapshot): void {
  notesCache = snapshot.notes.map(preview);
  setFolderSnapshot(snapshot.folders, notesCache);
  lastSaveIdentityChange = null;
  projectionRevision += 1;
}

function replaceFromListing(snapshot: LocalNoteListingSnapshot): void {
  notesCache = snapshot.notes.map(([id, title, _folder, modifiedMs]) => ({
    id,
    title,
    preview: '',
    modificationTime: modifiedMs,
    tags: [],
  }));
  lastSaveIdentityChange = null;
  projectionRevision += 1;
}

let lastSaveIdentityChange: { from: string | null; to: string } | null = null;

/** The id a save gave the note it wrote: the mint of a first save, or the move a
 * title edit performed. `noteActionTarget` follows a picked note across it. */
export function recordSaveIdentityChange(from: string | null, to: string): void {
  lastSaveIdentityChange = { from, to };
}

export function getSaveIdentityChange(): { from: string | null; to: string } | null {
  return lastSaveIdentityChange;
}

/** Project a committed Rust mutation by removing affected rows and splicing
 * ordered upserts at clamped positions. No sort rule lives in this cache. */
export function _applyLocalMutation(mutation: LocalNoteMutation): void {
  const affected = new Set([
    ...mutation.removed,
    ...mutation.upserted.map((entry) => entry.note.id),
  ]);
  const next = notesCache.filter((note) => !affected.has(note.id));
  for (const entry of mutation.upserted) {
    const position = Math.min(Math.max(entry.position, 0), next.length);
    next.splice(position, 0, preview(entry.note));
  }
  notesCache = next;
  projectionRevision += 1;
  setFolderSnapshot(mutation.folders, notesCache);
  // The old id names a note again, so the rename can no longer explain its absence.
  const recorded = lastSaveIdentityChange?.from;
  if (recorded && mutation.upserted.some((entry) => entry.note.id === recorded)) {
    lastSaveIdentityChange = null;
  }
  for (const warning of mutation.warnings) console.warn(`[local-notes] ${warning}`);
}

function mtimeFor(mutation: LocalNoteMutation, id: string): number {
  return mutation.upserted.find((entry) => entry.note.id === id)?.note.modifiedMs ?? Date.now();
}

export function whenNotesReady(): Promise<NotesReadiness> {
  return notesReadyPromise;
}

function settleNotesReadiness(readiness: NotesReadiness): void {
  notesReadyResolve?.(readiness);
  notesReadyResolve = null;
}

export async function initNotes(onStep?: (label: string) => void): Promise<void> {
  if (initialized) return;
  try {
    onStep?.('initNotes: local store');
    const store = getLocalNoteStoreSync();
    onStep?.('initNotes: bootstrap');
    const listing = await store.startupListing();
    onStep?.('initNotes: listing received');
    replaceFromListing(listing);
    onStep?.('initNotes: listing projected');
    setFolderSnapshot(listing.folders, notesCache);

    // Content-derived previews/tags and BM25 reconciliation hydrate after the
    // ordered title list is usable. If a mutation lands while the snapshot is
    // in flight, retry the read rather than replacing that newer projection.
    searchReady = (async () => {
      let observedRevision = projectionRevision;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const bootstrap = await store.bootstrap();
      for (const warning of bootstrap.warnings) console.warn(`[local-notes] ${warning}`);
      let snapshot = bootstrap.snapshot;
      while (observedRevision !== projectionRevision) {
        observedRevision = projectionRevision;
        snapshot = await store.snapshot();
      }
      replaceFromSnapshot(snapshot);
      settleNotesReadiness('ready');
      await store.waitUntilSearchReady(searchReadyTimeoutMs);
    })().catch((err) => {
      console.warn('[local-notes] background hydration failed:', err);
      settleNotesReadiness('failed');
    });
  } catch (error) {
    // #33: a failed bootstrap must still settle readiness, or every awaiter
    // (tab hydration → hash routing) hangs forever and the app goes dead.
    settleNotesReadiness('failed');
    throw error;
  }
  initialized = true;
  onStep?.('initNotes: done');
}

/** Test/embed seam: no disk or search side effects. Callers supply previews
 * already in engine order (native shells pass their engine-ordered list). */
export function setNotesUniverse(previews: NotePreview[]): void {
  notesCache = previews;
  projectionRevision += 1;
}

export function _injectTestNote(id: string, title: string): void {
  // Newest-first: the cache holds engine order and Date.now() is the newest.
  notesCache = [{ id, title, preview: '', modificationTime: Date.now(), tags: [] }, ...notesCache];
  projectionRevision += 1;
}

export function noteTitleFromId(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

/** The note list in engine order (modified desc, id asc). The order is
 * maintained purely by applying snapshots and mutation splices — the
 * projection holds no comparator (ADR-0001). */
export function getAllNotes(): NotePreview[] {
  return notesCache;
}

let cachedWikilinkIndex: { notes: NotePreview[]; size: number; index: WikilinkIndex } | null = null;

/**
 * The wikilink lookup index for the current note list. Callers on the typing path
 * (link decorations, `[[` completion) must use this rather than passing the id list
 * to `resolveWikilink` / `shortestUniqueSuffix` per link — those scan the whole
 * vault per call. Every write in this module replaces `notesCache` except
 * `_injectTestNote`, which changes its length, so identity plus length detects both;
 * an id edited in place through the array `getAllNotes` hands out would not be seen.
 */
export function getWikilinkIndex(): WikilinkIndex {
  const cached = cachedWikilinkIndex;
  if (cached && cached.notes === notesCache && cached.size === notesCache.length) {
    return cached.index;
  }
  const index = buildWikilinkIndex(notesCache.map((note) => note.id));
  cachedWikilinkIndex = { notes: notesCache, size: notesCache.length, index };
  return index;
}

export function getNoteById(id: string): NotePreview | undefined {
  return notesCache.find((note) => note.id === id);
}

export async function readNote(id: string): Promise<string> {
  return (await getLocalNoteStore()).read(id);
}

export async function noteExists(id: string): Promise<boolean> {
  return (await getLocalNoteStore()).exists(id);
}

export async function createNote(
  id: string,
  content: string,
): Promise<{ id: string; mtime: number }> {
  const store = await getLocalNoteStore();
  const mutation = await store.save(null, id, content);
  _applyLocalMutation(mutation);
  const createdId = mutation.finalId ?? id;
  return { id: createdId, mtime: mtimeFor(mutation, createdId) };
}

export interface UpdateNoteOptions {
  originalId?: string;
  base?: string;
  overrideMtime?: number;
}

export type UpdateNoteDisposition = 'wrote' | 'converged' | 'recreated' | 'parked';

export interface UpdateNoteResult {
  id: string;
  mtime: number;
  disposition: UpdateNoteDisposition;
  parkedId?: string;
  /**
   * Apply via `_applyLocalMutation` in the same synchronous block as the caller's
   * own identity update, or the render in between selects a since-removed id.
   */
  unappliedMutation: LocalNoteMutation | null;
}

export async function updateNote(
  id: string,
  _title: string,
  content: string,
  options: UpdateNoteOptions = {},
): Promise<UpdateNoteResult> {
  const store = await getLocalNoteStore();
  const { originalId, base, overrideMtime } = options;

  if (originalId === id && base !== undefined && overrideMtime === undefined) {
    const flush = await store.flushDraft(originalId, base, content);

    if (flush.disposition.kind === 'parkedConflict') {
      return {
        id: originalId,
        mtime: getNoteById(originalId)?.modificationTime ?? Date.now(),
        disposition: 'parked',
        parkedId: flush.disposition.parkedId,
        unappliedMutation: flush.mutation,
      };
    }

    return {
      id: originalId,
      mtime:
        flush.mutation === null
          ? (getNoteById(originalId)?.modificationTime ?? Date.now())
          : mtimeFor(flush.mutation, originalId),
      disposition: flush.disposition.kind,
      unappliedMutation: flush.mutation,
    };
  }

  const mutation = await store.save(originalId ?? null, id, content, overrideMtime);
  const savedId = mutation.finalId ?? id;
  return {
    id: savedId,
    mtime: mtimeFor(mutation, savedId),
    disposition: 'wrote',
    unappliedMutation: mutation,
  };
}

export async function moveNote(
  fromId: string,
  toId: string,
): Promise<{ id: string; mtime: number }> {
  if (fromId === toId) {
    return {
      id: fromId,
      mtime: getNoteById(fromId)?.modificationTime ?? Date.now(),
    };
  }
  const mutation = await (await getLocalNoteStore()).move(fromId, toId);
  _applyLocalMutation(mutation);
  const id = mutation.finalId ?? toId;
  return { id, mtime: mtimeFor(mutation, id) };
}

export async function deleteNote(id: string): Promise<void> {
  const mutation = await (await getLocalNoteStore()).delete(id);
  _applyLocalMutation(mutation);
}

export async function refreshNotesFromStorage(): Promise<void> {
  const snapshot = await (await getLocalNoteStore()).snapshot();
  replaceFromSnapshot(snapshot);
}

export async function refreshNotesAfterSync(
  _updatedIds: string[],
  _deletedIds: string[],
): Promise<void> {
  await refreshNotesFromStorage();
  await currentLocalNoteStore().rescan();
}

export async function handleExternalFileChange(filename: string): Promise<NotePreview | null> {
  await refreshNotesFromStorage();
  const id = filename.replace(/\\/g, '/').replace(/\.md$/, '');
  return getNoteById(id) ?? null;
}

export async function deleteAllNotes(): Promise<void> {
  pauseSyncV2();
  try {
    await stopLiveSync();
    await waitForSyncIdleV2();
    await disconnectE2ee();
    await (await getLocalNoteStore()).reset();
    notesCache = [];
    setFolderSnapshot([], []);
    searchReady = Promise.resolve();
  } finally {
    resumeSyncV2();
  }
}

export async function search(query: string): Promise<SearchResultItem[]> {
  if (!query.trim()) {
    return getAllNotes().map((note) => ({ note }));
  }
  // Never let a rejected readiness promise throw out of search — degrade to the
  // store query, which returns empty gracefully when the index isn't ready (A4).
  if (searchReady) await searchReady.catch(() => {});
  const hits = await currentLocalNoteStore().search(query);
  const byId = new Map(notesCache.map((note) => [note.id, note]));
  return hits.flatMap((hit) => {
    const note = byId.get(hit.noteId);
    if (!note) return [];
    return [{ note }];
  });
}

export const searchKeyword = search;

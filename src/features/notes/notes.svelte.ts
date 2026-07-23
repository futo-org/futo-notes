import type { NotePreview } from '$shared/types/note';
import type { SearchResultItem } from '$shared/types/search';
import {
  currentLocalNoteStore,
  getLocalNoteStore,
  type LocalNoteMetadata,
  type LocalNoteMutation,
  type LocalNoteSnapshot,
} from '$lib/localNoteStore';
import { pauseSyncV2, resumeSyncV2, waitForSyncIdleV2 } from '$features/sync/autoSyncV2';
import { disconnectE2ee, stopLiveSync } from '$features/sync/syncServiceE2ee';
import { setFolderSnapshot } from '$features/folders/emptyFolders.svelte';

let notesCache = $state<NotePreview[]>([]);
let initialized = false;
let notesReadyResolve: (() => void) | null = null;
const notesReadyPromise = new Promise<void>((resolve) => {
  notesReadyResolve = resolve;
});
let searchReady: Promise<void> | null = null;

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
  setFolderSnapshot(mutation.folders, notesCache);
  for (const warning of mutation.warnings) console.warn(`[local-notes] ${warning}`);
}

function mtimeFor(mutation: LocalNoteMutation, id: string): number {
  return mutation.upserted.find((entry) => entry.note.id === id)?.note.modifiedMs ?? Date.now();
}

export function whenNotesReady(): Promise<void> {
  return notesReadyPromise;
}

export async function initNotes(onStep?: (label: string) => void): Promise<void> {
  if (initialized) return;
  onStep?.('initNotes: local store');
  const store = await getLocalNoteStore();
  onStep?.('initNotes: bootstrap');
  const bootstrap = await store.bootstrap();
  replaceFromSnapshot(bootstrap.snapshot);
  for (const warning of bootstrap.warnings) console.warn(`[local-notes] ${warning}`);

  // Search may await background index readiness, but initial rendering never
  // does. Timeout or rejection degrades to empty results while the engine heals.
  searchReady = store.waitUntilSearchReady(searchReadyTimeoutMs).then(
    () => undefined,
    (err) => {
      console.warn('[local-notes] search readiness wait failed:', err);
    },
  );
  initialized = true;
  notesReadyResolve?.();
  notesReadyResolve = null;
  onStep?.('initNotes: done');
}

/** Test/embed seam: no disk or search side effects. Callers supply previews
 * already in engine order (native shells pass their engine-ordered list). */
export function setNotesUniverse(previews: NotePreview[]): void {
  notesCache = previews;
}

export function _injectTestNote(id: string, title: string): void {
  // Newest-first: the cache holds engine order and Date.now() is the newest.
  notesCache.unshift({ id, title, preview: '', modificationTime: Date.now(), tags: [] });
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

export async function updateNote(
  id: string,
  _title: string,
  content: string,
  originalId?: string,
  overrideMtime?: number,
): Promise<{ id: string; mtime: number }> {
  const store = await getLocalNoteStore();
  const mutation = await store.save(originalId ?? null, id, content, overrideMtime);
  _applyLocalMutation(mutation);
  const savedId = mutation.finalId ?? id;
  return { id: savedId, mtime: mtimeFor(mutation, savedId) };
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

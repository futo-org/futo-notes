import type { NotePreview, SearchResultItem } from '../types';
import {
  currentLocalNoteStore,
  getLocalNoteStore,
  type LocalNoteMetadata,
  type LocalNoteMutation,
  type LocalNoteSnapshot,
} from './localNoteStore';
import { pauseSyncV2, resumeSyncV2, waitForSyncIdleV2 } from './autoSyncV2';
import { disconnectE2ee, stopLiveSync } from './syncServiceE2ee';
import { setFolderSnapshot } from './folders.svelte';

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

const sortedNotes = $derived.by(() =>
  [...notesCache].sort(
    (left, right) =>
      right.modificationTime - left.modificationTime || left.id.localeCompare(right.id),
  ),
);

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

/** The only cache mutation seam. Rust has already committed the complete
 * vault operation and returns every affected note, including backlink edits. */
export function _applyLocalMutation(mutation: LocalNoteMutation): void {
  const removed = new Set(mutation.removed);
  const next = new Map(
    notesCache.filter((note) => !removed.has(note.id)).map((note) => [note.id, note]),
  );
  for (const metadata of mutation.upserted) next.set(metadata.id, preview(metadata));
  notesCache = [...next.values()];
  for (const warning of mutation.warnings) console.warn(`[local-notes] ${warning}`);
}

function finalId(mutation: LocalNoteMutation, fallback: string): string {
  return (
    mutation.renamed[mutation.renamed.length - 1]?.to ??
    mutation.upserted[mutation.upserted.length - 1]?.id ??
    fallback
  );
}

function mtimeFor(mutation: LocalNoteMutation, id: string): number {
  return mutation.upserted.find((note) => note.id === id)?.modifiedMs ?? Date.now();
}

export function whenNotesReady(): Promise<void> {
  return notesReadyPromise;
}

export function whenSearchIndexReady(): Promise<void> {
  return searchReady ?? Promise.resolve();
}

export async function initNotes(onStep?: (label: string) => void): Promise<void> {
  if (initialized) return;
  onStep?.('initNotes: local store');
  const store = await getLocalNoteStore();
  onStep?.('initNotes: bootstrap');
  const bootstrap = await store.bootstrap();
  replaceFromSnapshot(bootstrap.snapshot);
  for (const warning of bootstrap.warnings) console.warn(`[local-notes] ${warning}`);

  // Index reconciliation remains background work. A user search can await this
  // promise, but initial list rendering never does.
  searchReady = waitUntilSearchReady(store);
  initialized = true;
  notesReadyResolve?.();
  notesReadyResolve = null;
  onStep?.('initNotes: done');
}

async function waitUntilSearchReady(
  store: Awaited<ReturnType<typeof getLocalNoteStore>>,
): Promise<void> {
  const deadline = Date.now() + searchReadyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await store.searchStatus()).keyword.ready) return;
    } catch (err) {
      // A transient status-probe rejection must NOT poison this shared promise
      // (every search awaits it) — log and keep polling until the deadline.
      console.warn('[local-notes] search status probe failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Deadline hit without readiness: degrade. store.search returns empty until
  // the index opens (it self-heals via the retry cooldown), so a never-ready
  // engine can never hang search.
}

/** Test/embed seam: no disk or search side effects. */
export function setNotesUniverse(previews: NotePreview[]): void {
  notesCache = previews;
}

export function _injectTestNote(id: string, title: string): void {
  notesCache.push({ id, title, preview: '', modificationTime: Date.now(), tags: [] });
}

export function noteTitleFromId(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

export function getAllNotes(): NotePreview[] {
  return sortedNotes;
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
  const createdId = finalId(mutation, id);
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
  const savedId = finalId(mutation, id);
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
  const id = finalId(mutation, toId);
  return { id, mtime: mtimeFor(mutation, id) };
}

export async function moveNotesUnderPrefix(fromPrefix: string, toPrefix: string): Promise<void> {
  if (fromPrefix === toPrefix) return;
  const mutation = await (await getLocalNoteStore()).renameFolder(fromPrefix, toPrefix);
  _applyLocalMutation(mutation);
  const snapshot = await currentLocalNoteStore().snapshot();
  setFolderSnapshot(snapshot.folders, notesCache);
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
    return getAllNotes().map((note) => ({ note, snippet: null }));
  }
  // Never let a rejected readiness promise throw out of search — degrade to the
  // store query, which returns empty gracefully when the index isn't ready (A4).
  if (searchReady) await searchReady.catch(() => {});
  const hits = await currentLocalNoteStore().search(query);
  const byId = new Map(notesCache.map((note) => [note.id, note]));
  return hits.flatMap((hit) => {
    const note = byId.get(hit.noteId);
    if (!note) return [];
    return [{ note, snippet: note.preview || null }];
  });
}

export const searchKeyword = search;

import { isTauri } from './platform';
import { tauriLocalNoteStore } from './platform/localNoteStore';
import { webLocalNoteStore } from './platform/webLocalNoteStore';

export interface LocalNoteMetadata {
  id: string;
  title: string;
  folder: string;
  modifiedMs: number;
  preview: string;
  richPreview: string;
  tags: string[];
}

export interface LocalNoteSnapshot {
  notes: LocalNoteMetadata[];
  folders: string[];
}

export type LocalNoteListingMetadata = readonly [
  id: string,
  title: string,
  folder: string,
  modifiedMs: number,
];

export interface LocalNoteListingSnapshot {
  notes: LocalNoteListingMetadata[];
  folders: string[];
}

export interface LocalNoteRename {
  from: string;
  to: string;
}

/** Rename shape projected by a sync summary. */
export interface LocalNoteRenamePair {
  fromId: string;
  toId: string;
}

export interface LocalNoteUpsert {
  note: LocalNoteMetadata;
  position: number;
}

export interface LocalNoteMutation {
  upserted: LocalNoteUpsert[];
  removed: string[];
  renamed: LocalNoteRename[];
  folders: string[];
  finalId: string | null;
  finalFolder: string | null;
  warnings: string[];
}

/** The single outcome of one draft flush (CONTEXT.md: flush disposition).
 * Shells render dispositions; they never decide them (ADR-0001). Mirrors
 * `futo-notes-store::FlushDisposition`. */
export type LocalFlushDisposition =
  | { kind: 'wrote' }
  | { kind: 'converged' }
  | { kind: 'recreated' }
  | { kind: 'parkedConflict'; parkedId: string };

/** What a flush committed: one disposition plus the mutation to project
 * (null when nothing changed on disk — converged, or a park that found its
 * copy already minted). */
export interface LocalFlushDraftResult {
  disposition: LocalFlushDisposition;
  mutation: LocalNoteMutation | null;
}

export interface LocalNoteBootstrap {
  snapshot: LocalNoteSnapshot;
  seeded: number;
  migrated: number;
  warnings: string[];
}

export interface LocalNoteInventoryItem {
  name: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface LocalSearchHit {
  noteId: string;
  score: number;
  source: string;
}

export interface LocalNoteStore {
  startupListing(): Promise<LocalNoteListingSnapshot>;
  bootstrap(): Promise<LocalNoteBootstrap>;
  snapshot(): Promise<LocalNoteSnapshot>;
  inventory(): Promise<LocalNoteInventoryItem[]>;
  read(id: string): Promise<string>;
  exists(id: string): Promise<boolean>;
  save(
    originalId: string | null,
    wantedId: string,
    content: string,
    modifiedMs?: number,
  ): Promise<LocalNoteMutation>;
  /** THE draft-saving verb (persist-or-park, ADR-0001 / issue #37): persist
   * `content` for the note at `id` against `base` (the content the editor
   * last loaded or saved) and return one flush disposition — wrote /
   * converged / recreated / parked as a conflict copy — plus the mutation to
   * apply. The engine resolves every surprise itself on all three shells. */
  flushDraft(id: string, base: string, content: string): Promise<LocalFlushDraftResult>;
  move(id: string, wantedId: string): Promise<LocalNoteMutation>;
  delete(id: string): Promise<LocalNoteMutation>;
  createFolder(path: string): Promise<LocalNoteMutation>;
  renameFolder(from: string, to: string): Promise<LocalNoteMutation>;
  moveFolder(from: string, destinationParent: string): Promise<LocalNoteMutation>;
  deleteFolder(path: string): Promise<LocalNoteMutation>;
  reset(): Promise<void>;
  search(query: string, limit?: number): Promise<LocalSearchHit[]>;
  /** Bounded, engine-owned keyword readiness wait; shells do not poll. */
  waitUntilSearchReady(timeoutMs: number): Promise<boolean>;
  /** Project files written outside this store's mutation verbs. */
  refreshExternalChanges(
    updatedIds: string[],
    deletedIds: string[],
    renamed: LocalNoteRenamePair[],
  ): Promise<LocalNoteMutation>;
  rescan(): Promise<void>;
}

let localNotes: LocalNoteStore | null = null;

/** Start desktop's content-free listing invoke before Svelte mounts. Never
 * awaited: M1's first render remains synchronous, and init consumes this same
 * promise once the reactive notes owner exists. */
export function prefetchLocalNoteListing(): void {
  if (!isTauri) return;
  localNotes = tauriLocalNoteStore;
  tauriLocalNoteStore.prefetchStartupListing();
}

export function getLocalNoteStoreSync(): LocalNoteStore {
  localNotes ??= isTauri ? tauriLocalNoteStore : webLocalNoteStore;
  return localNotes;
}

export async function getLocalNoteStore(): Promise<LocalNoteStore> {
  return getLocalNoteStoreSync();
}

export function _setLocalNoteStoreForTest(store: LocalNoteStore | null): void {
  localNotes = store;
}

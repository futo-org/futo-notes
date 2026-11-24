import { isTauri } from './platform';
import { tauriLocalNoteStore } from './platform/localNoteStore';
import { webLocalNoteStore } from './platform/webLocalNoteStore';

export type NoteSortKey = 'lastModified' | 'name';
export type SortDirection = 'ascending' | 'descending';

export interface NoteSortOrder {
  key: NoteSortKey;
  direction: SortDirection;
}

export const DEFAULT_NOTE_SORT_ORDER: NoteSortOrder = {
  key: 'lastModified',
  direction: 'descending',
};

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
  /** Final ids whose body the workflow's backlink rewrite changed on disk. */
  relinked: string[];
  warnings: string[];
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
  startupListing(order: NoteSortOrder): Promise<LocalNoteListingSnapshot>;
  setSortOrder(order: NoteSortOrder): Promise<LocalNoteSnapshot>;
  /** Most recently modified first, independent of the active sort order. */
  recentNoteIds(limit: number): Promise<string[]>;
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
export function prefetchLocalNoteListing(order: NoteSortOrder): void {
  if (!isTauri) return;
  localNotes = tauriLocalNoteStore;
  tauriLocalNoteStore.prefetchStartupListing(order);
}

export function getLocalNoteStoreSync(): LocalNoteStore {
  localNotes ??= isTauri ? tauriLocalNoteStore : webLocalNoteStore;
  return localNotes;
}

export function _setLocalNoteStoreForTest(store: LocalNoteStore | null): void {
  localNotes = store;
}

import type { NotePreview, SearchResultItem } from '../../types';
import type { SyncState } from '../syncState';
import type { NoteSyncMeta } from '@futo-notes/shared';
import type { EngagementRecord } from '../engagement';
import type { SupersearchState } from '../supersearch/state';

// Access the same testFS instance used by the platform mock (stored on globalThis)
const g = globalThis as unknown as {
  __futoActiveFS?: {
    listNoteFiles(): Promise<Array<{ name: string; mtime: number }>>;
    readNote(id: string): Promise<string>;
    writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number>;
    deleteNoteFile(id: string): Promise<void>;
  };
};

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function scanNotes(): Promise<NotePreview[]> {
  const fs = g.__futoActiveFS;
  if (!fs) return [];
  const files = await fs.listNoteFiles();
  const previews: NotePreview[] = [];
  for (const file of files) {
    const id = file.name.replace(/\.md$/, '');
    try {
      const content = await fs.readNote(id);
      previews.push({
        id,
        title: id,
        preview: content.slice(0, 100).replace(/\n/g, ' '),
        modificationTime: file.mtime,
      });
    } catch { /* skip unreadable */ }
  }
  previews.sort((a, b) => b.modificationTime - a.modificationTime);
  return previews;
}

export function hasRustCore(): boolean {
  return true;
}

export async function rebuildRustIndex(): Promise<NotePreview[]> {
  return scanNotes();
}

export async function getRustNotePreviews(): Promise<NotePreview[]> {
  return scanNotes();
}

export async function keywordSearchRust(query: string, _limit = 200): Promise<SearchResultItem[]> {
  const previews = await scanNotes();
  if (!query.trim()) {
    return previews.map((note) => ({ note, snippet: null }));
  }
  const lower = query.trim().toLowerCase();
  return previews
    .filter((note) => note.id.toLowerCase().includes(lower) || note.preview.toLowerCase().includes(lower))
    .map((note) => ({ note, snippet: [{ text: note.preview, highlight: false }], source: 'keyword' as const }));
}

export async function prepareSyncPayloadRust(state: SyncState): Promise<{
  nextState: SyncState;
  notes: NoteSyncMeta[];
  allUuids: string[];
  elapsedMs: number;
}> {
  const fs = g.__futoActiveFS!;
  const files = await fs.listNoteFiles();
  interface HashEntry { modifiedAt: number; hash: string }
  const hashCache: Record<string, HashEntry> = state.hashCache ? { ...state.hashCache } : {};
  const notes: NoteSyncMeta[] = [];

  const nextUuidById = { ...state.uuidById };
  const nextHashByUuid = { ...state.hashByUuid };

  for (const file of files) {
    const id = file.name.replace(/\.md$/, '');
    const uuid = nextUuidById[id] ?? crypto.randomUUID();
    nextUuidById[id] = uuid;

    const modTime = file.mtime || Date.now();
    const cached = hashCache[id];
    let hash: string;
    let content: string | undefined;

    if (cached && cached.modifiedAt === file.mtime) {
      hash = cached.hash;
    } else {
      content = await fs.readNote(id);
      hash = await sha256Hex(content);
      hashCache[id] = { modifiedAt: modTime, hash };
    }

    const lastSyncHash = nextHashByUuid[uuid] ?? '';
    const needsContent = hash !== lastSyncHash;
    if (needsContent && content === undefined) {
      content = await fs.readNote(id);
    }

    notes.push({
      uuid,
      filename: `${id}.md`,
      modified_at: modTime,
      content_hash: hash,
      hash_at_last_sync: lastSyncHash,
      ...(needsContent ? { content } : {}),
    });
  }

  // Clean stale cache entries
  const activeIds = new Set(files.map(f => f.name.replace(/\.md$/, '')));
  for (const id of Object.keys(hashCache)) {
    if (!activeIds.has(id)) delete hashCache[id];
  }

  return {
    nextState: {
      hashByUuid: nextHashByUuid,
      uuidById: nextUuidById,
      deletedUuids: [...state.deletedUuids],
      hashCache,
    },
    notes,
    allUuids: notes.map(n => n.uuid),
    elapsedMs: 0,
  };
}

export async function applySyncDeltaRust(
  state: SyncState,
  updates: Array<{ uuid: string; id: string; content: string; modified_at: number; content_hash: string }>,
  deletes: string[],
): Promise<{
  nextState: SyncState;
  updatedIds: string[];
  deletedIds: string[];
  elapsedMs: number;
}> {
  const fs = g.__futoActiveFS!;
  const nextUuidById = { ...state.uuidById };
  const nextHashByUuid = { ...state.hashByUuid };
  let nextDeletedUuids = [...state.deletedUuids];
  const updatedIds: string[] = [];
  const deletedIds: string[] = [];

  for (const update of updates) {
    // If this UUID was previously mapped to a different ID, delete the old file (rename)
    const oldId = Object.entries(nextUuidById).find(([, v]) => v === update.uuid)?.[0];
    if (oldId && oldId !== update.id) {
      try { await fs.deleteNoteFile(oldId); } catch { /* may already be gone */ }
      delete nextUuidById[oldId];
    }
    await fs.writeNote(update.id, update.content, update.modified_at);
    nextUuidById[update.id] = update.uuid;
    nextHashByUuid[update.uuid] = update.content_hash;
    updatedIds.push(update.id);
  }

  for (const uuid of deletes) {
    const id = Object.entries(nextUuidById).find(([, v]) => v === uuid)?.[0];
    if (id) {
      try { await fs.deleteNoteFile(id); } catch { /* may already be gone */ }
      delete nextUuidById[id];
      deletedIds.push(id);
    }
    delete nextHashByUuid[uuid];
    nextDeletedUuids = nextDeletedUuids.filter(u => u !== uuid);
  }

  return {
    nextState: {
      hashByUuid: nextHashByUuid,
      uuidById: nextUuidById,
      deletedUuids: nextDeletedUuids,
      hashCache: state.hashCache,
    },
    updatedIds,
    deletedIds,
    elapsedMs: 0,
  };
}

// Engagement mock stubs
const engagementStore: Record<string, EngagementRecord> = {};

export async function engagementLoadRust(): Promise<void> {
  // no-op in mock
}

export async function engagementTrackOpenRust(_id: string): Promise<void> {
  // no-op in mock
}

export async function engagementTrackEditRust(_id: string): Promise<void> {
  // no-op in mock
}

export async function engagementRemoveRust(_id: string): Promise<void> {
  // no-op in mock
}

export async function engagementRenameRust(_oldId: string, _newId: string): Promise<void> {
  // no-op in mock
}

export async function engagementGetAllRust(): Promise<Record<string, EngagementRecord>> {
  return { ...engagementStore };
}

export async function engagementFlushRust(): Promise<void> {
  // no-op in mock
}

// Supersearch state mock stubs
export async function supersearchIsReadyRust(): Promise<boolean> {
  return false;
}

export async function supersearchGetStateRust(): Promise<SupersearchState | null> {
  return null;
}

export async function supersearchDownloadWithMetaRust(
  _serverUrl: string,
  _token: string,
  _meta: SupersearchState,
): Promise<void> {
  // no-op in mock
}

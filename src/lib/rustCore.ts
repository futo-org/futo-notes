import type { NotePreview, SearchResultItem } from '../types';
import type { SyncState } from './syncState';
import type { NoteSyncMeta } from '@futo-notes/shared';
import { platformName } from './platform';

interface RustHashCacheEntry {
  modifiedAt: number;
  hash: string;
}

interface RustSyncState {
  hashByUuid: Record<string, string>;
  uuidById: Record<string, string>;
  deletedUuids: string[];
  hashCache?: Record<string, RustHashCacheEntry>;
}

interface RustSyncPrepareOutput {
  state: RustSyncState;
  notes: NoteSyncMeta[];
  allUuids: string[];
  elapsedMs: number;
}

interface RustIncomingSyncUpdate {
  uuid: string;
  id: string;
  content: string;
  modified_at: number;
  content_hash: string;
}

interface RustSyncApplyOutput {
  state: RustSyncState;
  updatedIds: string[];
  deletedIds: string[];
  elapsedMs: number;
}

interface RustSearchSnippetSegment {
  text: string;
  highlight: boolean;
}

interface RustSearchResult {
  note: NotePreview;
  snippet: RustSearchSnippetSegment[] | null;
}

function toI64(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

async function tauriInvoke<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, payload);
}

export function hasRustCore(): boolean {
  return platformName === 'tauri';
}

function toRustState(state: SyncState): RustSyncState {
  const hashCache: Record<string, RustHashCacheEntry> | undefined = state.hashCache
    ? Object.fromEntries(
      Object.entries(state.hashCache).map(([id, entry]) => [
        id,
        { modifiedAt: toI64(entry.modifiedAt), hash: entry.hash },
      ]),
    )
    : undefined;

  return {
    hashByUuid: { ...state.hashByUuid },
    uuidById: { ...state.uuidById },
    deletedUuids: [...state.deletedUuids],
    ...(hashCache ? { hashCache } : {}),
  };
}

function fromRustState(state: RustSyncState): SyncState {
  const hashCache = state.hashCache
    ? Object.fromEntries(
      Object.entries(state.hashCache).map(([id, entry]) => [
        id,
        { modifiedAt: toI64(entry.modifiedAt), hash: entry.hash },
      ]),
    )
    : undefined;

  return {
    hashByUuid: { ...state.hashByUuid },
    uuidById: { ...state.uuidById },
    deletedUuids: [...state.deletedUuids],
    ...(hashCache ? { hashCache } : {}),
  };
}

export async function rebuildRustIndex(): Promise<NotePreview[]> {
  return tauriInvoke<NotePreview[]>('core_rebuild_index');
}

export async function getRustNotePreviews(): Promise<NotePreview[]> {
  return tauriInvoke<NotePreview[]>('core_get_note_previews');
}

export async function keywordSearchRust(query: string, limit = 200): Promise<SearchResultItem[]> {
  const results = await tauriInvoke<RustSearchResult[]>('core_keyword_search', {
    input: {
      query,
      limit,
    },
  });

  return results.map((result) => ({
    note: result.note,
    snippet: result.snippet,
    source: 'keyword' as const,
  }));
}

export async function prepareSyncPayloadRust(state: SyncState): Promise<{
  nextState: SyncState;
  notes: NoteSyncMeta[];
  allUuids: string[];
  elapsedMs: number;
}> {
  const payload = await tauriInvoke<RustSyncPrepareOutput>('core_prepare_sync_payload', {
    input: {
      state: toRustState(state),
    },
  });

  return {
    nextState: fromRustState(payload.state),
    notes: payload.notes,
    allUuids: payload.allUuids,
    elapsedMs: payload.elapsedMs,
  };
}

export async function applySyncDeltaRust(
  state: SyncState,
  updates: RustIncomingSyncUpdate[],
  deletes: string[],
): Promise<{
  nextState: SyncState;
  updatedIds: string[];
  deletedIds: string[];
  elapsedMs: number;
}> {
  const payload = await tauriInvoke<RustSyncApplyOutput>('core_apply_sync_delta', {
    input: {
      state: toRustState(state),
      update: updates.map((update) => ({
        ...update,
        modified_at: toI64(update.modified_at),
      })),
      delete: deletes,
    },
  });

  return {
    nextState: fromRustState(payload.state),
    updatedIds: payload.updatedIds,
    deletedIds: payload.deletedIds,
    elapsedMs: payload.elapsedMs,
  };
}

import type { NotePreview, SearchResultItem } from '../types';
import type { SyncState } from './syncState';
import type { NoteSyncMeta } from '@futo-notes/shared';
import type { EngagementRecord } from './engagement';
import type { SupersearchState } from './supersearch/state';
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

interface RustSyncRename {
  fromId: string;
  toId: string;
}

interface RustSyncApplyOutput {
  state: RustSyncState;
  updatedIds: string[];
  deletedIds: string[];
  renamed: RustSyncRename[];
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
  renamed: RustSyncRename[];
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
    renamed: payload.renamed,
    elapsedMs: payload.elapsedMs,
  };
}

// ── Image sync wrappers ──────────────────────────────────

export interface ImageSyncEntry {
  uuid: string;
  filename: string;
  content_hash: string;
  modified_at: number;
  hash_at_last_sync: string;
}

interface RustImageSyncPrepareOutput {
  state: RustSyncState;
  images: ImageSyncEntry[];
  elapsedMs: number;
}

interface RustApplyImageSyncDeltaOutput {
  state: RustSyncState;
  deletedFilenames: string[];
}

export async function prepareImageSyncRust(state: SyncState): Promise<{
  nextState: SyncState;
  images: ImageSyncEntry[];
  elapsedMs: number;
}> {
  const payload = await tauriInvoke<RustImageSyncPrepareOutput>('core_prepare_image_sync', {
    input: {
      state: toRustState(state),
    },
  });

  return {
    nextState: fromRustState(payload.state),
    images: payload.images,
    elapsedMs: payload.elapsedMs,
  };
}

export async function readImageBytesRust(filename: string): Promise<number[]> {
  return tauriInvoke<number[]>('core_read_image_bytes', { filename });
}

export async function writeSyncedImageRust(filename: string, data: number[], modifiedAt: number): Promise<void> {
  await tauriInvoke<void>('core_write_synced_image', {
    input: {
      filename,
      data,
      modifiedAt: toI64(modifiedAt),
    },
  });
}

export async function applyImageSyncDeltaRust(state: SyncState, deleteUuids: string[]): Promise<{
  nextState: SyncState;
  deletedFilenames: string[];
}> {
  const payload = await tauriInvoke<RustApplyImageSyncDeltaOutput>('core_apply_image_sync_delta', {
    input: {
      state: toRustState(state),
      deleteUuids,
    },
  });

  return {
    nextState: fromRustState(payload.state),
    deletedFilenames: payload.deletedFilenames,
  };
}

// Image gallery wrappers

export interface ImageFileEntry {
  filename: string;
  size: number;
  mtime: number;
}

export async function listImageFilesRust(): Promise<ImageFileEntry[]> {
  return tauriInvoke<ImageFileEntry[]>('core_list_image_files');
}

export async function deleteImageFileRust(filename: string): Promise<void> {
  await tauriInvoke<void>('core_delete_image_file', { filename });
}

// Engagement wrappers
export async function engagementLoadRust(): Promise<void> {
  await tauriInvoke<void>('engagement_load');
}

export async function engagementTrackOpenRust(id: string): Promise<void> {
  await tauriInvoke<void>('engagement_track_open', { id });
}

export async function engagementTrackEditRust(id: string): Promise<void> {
  await tauriInvoke<void>('engagement_track_edit', { id });
}

export async function engagementRemoveRust(id: string): Promise<void> {
  await tauriInvoke<void>('engagement_remove', { id });
}

export async function engagementRenameRust(oldId: string, newId: string): Promise<void> {
  await tauriInvoke<void>('engagement_rename', { oldId, newId });
}

export async function engagementGetAllRust(): Promise<Record<string, EngagementRecord>> {
  return tauriInvoke<Record<string, EngagementRecord>>('engagement_get_all');
}

export async function engagementFlushRust(): Promise<void> {
  await tauriInvoke<void>('engagement_flush');
}

// Supersearch state wrappers
export async function supersearchIsReadyRust(): Promise<boolean> {
  return tauriInvoke<boolean>('supersearch_is_ready');
}

export async function supersearchGetStateRust(): Promise<SupersearchState | null> {
  return tauriInvoke<SupersearchState | null>('supersearch_get_state');
}

export async function supersearchDownloadWithMetaRust(
  serverUrl: string,
  token: string,
  meta: SupersearchState,
): Promise<void> {
  await tauriInvoke<void>('supersearch_download', { serverUrl, token, meta });
}

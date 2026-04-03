import type { NotePreview, SearchResultItem } from '../types';
import type { EngagementRecord } from './engagement';
import { platformName } from './platform';

interface RustSearchSnippetSegment {
  text: string;
  highlight: boolean;
}

interface RustSearchResult {
  note: NotePreview;
  snippet: RustSearchSnippetSegment[] | null;
}

async function tauriInvoke<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, payload);
}

export function hasRustCore(): boolean {
  return platformName === 'tauri';
}

export async function rebuildRustIndex(): Promise<NotePreview[]> {
  return tauriInvoke<NotePreview[]>('core_rebuild_index');
}

/** Fast preview-only scan — skips reading file bodies for cached notes. */
export async function getNoteListFast(): Promise<NotePreview[]> {
  return tauriInvoke<NotePreview[]>('core_get_note_list');
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

// ── V2 Sync (filename-based, no UUIDs) ─────────────────────

interface RustV2HashCacheEntry {
  modifiedAt: number;
  hash: string;
}

interface RustV2SyncState {
  deviceId: string;
  lastServerVersion: number;
  fileHashes: Record<string, string>;
  hashCache?: Record<string, RustV2HashCacheEntry>;
}

interface RustV2SyncPrepareOutput {
  state: RustV2SyncState;
  inventory: { filename: string; hash: string }[];
  changed: { filename: string; content: string; hash: string }[];
  new: { filename: string; content: string; hash: string }[];
  deleted: string[];
  elapsedMs: number;
}

interface RustV2SyncApplyOutput {
  updatedFilenames: string[];
  deletedFilenames: string[];
  conflictFilenames: string[];
  elapsedMs: number;
}

export type { RustV2SyncState };

export async function prepareSyncPayloadV2(state: import('./appState').V2SyncState): Promise<{
  nextState: import('./appState').V2SyncState;
  inventory: { filename: string; hash: string }[];
  changed: { filename: string; content: string; hash: string }[];
  new: { filename: string; content: string; hash: string }[];
  deleted: string[];
  elapsedMs: number;
}> {
  const rustState: RustV2SyncState = {
    deviceId: state.deviceId,
    lastServerVersion: state.lastServerVersion,
    fileHashes: { ...state.fileHashes },
    ...(state.hashCache ? { hashCache: state.hashCache } : {}),
  };

  const payload = await tauriInvoke<RustV2SyncPrepareOutput>('core_prepare_sync_payload_v2', {
    input: { state: rustState },
  });

  return {
    nextState: {
      deviceId: payload.state.deviceId,
      lastServerVersion: payload.state.lastServerVersion,
      fileHashes: payload.state.fileHashes,
      ...(payload.state.hashCache ? { hashCache: payload.state.hashCache } : {}),
    },
    inventory: payload.inventory,
    changed: payload.changed,
    new: payload.new,
    deleted: payload.deleted,
    elapsedMs: payload.elapsedMs,
  };
}

export async function applySyncDeltaV2(
  updates: { filename: string; content: string; hash: string; modified_at: number }[],
  deletes: string[],
  conflicts: { filename: string; content: string }[],
  timestamps: Record<string, number> = {},
): Promise<{
  updatedFilenames: string[];
  deletedFilenames: string[];
  conflictFilenames: string[];
  elapsedMs: number;
}> {
  return tauriInvoke<RustV2SyncApplyOutput>('core_apply_sync_delta_v2', {
    input: { update: updates, delete: deletes, conflicts, timestamps },
  });
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


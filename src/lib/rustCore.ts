import { platformName } from './platform';

async function tauriInvoke<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, payload);
}

export function hasRustCore(): boolean {
  return platformName === 'tauri';
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
  dirtyUpserts?: string[];
  dirtyDeletes?: string[];
}

interface RustV2SyncPrepareOutput {
  state: RustV2SyncState;
  inventory: { filename: string; hash: string }[] | null;
  changed: { filename: string; content: string; hash: string; baselineHash?: string }[];
  new: { filename: string; content: string; hash: string }[];
  deleted: string[];
  lastVersion: number | null;
  deletedBaselines: Record<string, string>;
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
  inventory: { filename: string; hash: string }[] | null;
  changed: { filename: string; content: string; hash: string; baseline_hash?: string }[];
  new: { filename: string; content: string; hash: string }[];
  deleted: string[];
  lastVersion: number | null;
  deletedBaselines: Record<string, string>;
  elapsedMs: number;
}> {
  const rustState: RustV2SyncState = {
    deviceId: state.deviceId,
    lastServerVersion: state.lastServerVersion,
    fileHashes: { ...state.fileHashes },
    ...(state.hashCache ? { hashCache: state.hashCache } : {}),
    ...(state.dirtyUpserts?.length ? { dirtyUpserts: state.dirtyUpserts } : {}),
    ...(state.dirtyDeletes?.length ? { dirtyDeletes: state.dirtyDeletes } : {}),
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
      ...(payload.state.dirtyUpserts?.length ? { dirtyUpserts: payload.state.dirtyUpserts } : {}),
      ...(payload.state.dirtyDeletes?.length ? { dirtyDeletes: payload.state.dirtyDeletes } : {}),
    },
    inventory: payload.inventory,
    changed: payload.changed.map((c) => ({
      filename: c.filename,
      content: c.content,
      hash: c.hash,
      ...(c.baselineHash ? { baseline_hash: c.baselineHash } : {}),
    })),
    new: payload.new,
    deleted: payload.deleted,
    lastVersion: payload.lastVersion,
    deletedBaselines: payload.deletedBaselines,
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

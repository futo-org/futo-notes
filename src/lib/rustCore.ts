import { platformName } from './platform';

async function tauriInvoke<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, payload);
}

export function hasRustCore(): boolean {
  return platformName === 'tauri';
}

interface RustV2SyncApplyOutput {
  updatedFilenames: string[];
  deletedFilenames: string[];
  conflictFilenames: string[];
  elapsedMs: number;
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
  try {
    return await tauriInvoke<RustV2SyncApplyOutput>('core_apply_sync_delta_v2', {
      input: { update: updates, delete: deletes, conflicts, timestamps },
    });
  } catch (e) {
    // Rust returns opaque error strings (e.g. "No such file or directory (os
    // error 2)") with no filename context. Log the batch so we can correlate
    // the failure to a specific file.
    const sample = (xs: { filename: string }[] | string[], n = 3) =>
      xs.slice(0, n).map((x) => (typeof x === 'string' ? x : x.filename));
    console.error('[rustCore] applySyncDeltaV2 failed', {
      error: e instanceof Error ? e.message : String(e),
      updates: updates.length,
      deletes: deletes.length,
      conflicts: conflicts.length,
      timestamps: Object.keys(timestamps).length,
      sampleUpdates: sample(updates),
      sampleDeletes: sample(deletes),
      sampleConflicts: sample(conflicts),
    });
    throw e;
  }
}

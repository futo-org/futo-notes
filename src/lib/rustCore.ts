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
  return tauriInvoke<RustV2SyncApplyOutput>('core_apply_sync_delta_v2', {
    input: { update: updates, delete: deletes, conflicts, timestamps },
  });
}

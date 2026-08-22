/**
 * Write-suppression tracker for the file watcher.
 *
 * When sync writes a note to disk, the OS file watcher fires a change event
 * moments later. Without suppression we'd treat the sync echo as an external
 * edit.
 *
 * Two independent maps track recent sync mutations:
 * - recentSyncWrites (5s TTL) — files written by sync (watcher events may
 *   writes are batched and watcher events may arrive after a delay)
 * - recentRemoteRenames (5s TTL) — rename pairs from sync so we can suppress
 *   the unlink event for the old filename
 */

/** TTL for `recentSyncWrites`/`recentRemoteRenames` (sync-originated writes).
 *  Also the Rust watcher's `SUPPRESSION_WINDOW_MS` — same value, independent
 *  constant (F21); asserted against `tests/conformance/constants.json`. */
export const SYNC_WRITE_TTL_MS = 5000;

export interface WriteSuppressor {
  recordSyncWrite(filename: string): void;
  isRecentSyncWrite(filename: string): boolean;
  recordRemoteRename(fromId: string, toId: string): void;
  getRecentRemoteRename(id: string): { toId: string; ts: number } | null;
}

export function createWriteSuppressor(): WriteSuppressor {
  const recentSyncWrites = new Map<string, number>();
  const recentRemoteRenames = new Map<string, { toId: string; ts: number }>();

  function recordSyncWrite(filename: string): void {
    recentSyncWrites.set(filename, Date.now());
    for (const [key, ts] of recentSyncWrites) {
      if (Date.now() - ts > SYNC_WRITE_TTL_MS) recentSyncWrites.delete(key);
    }
  }

  function isRecentSyncWrite(filename: string): boolean {
    const ts = recentSyncWrites.get(filename);
    return ts !== undefined && Date.now() - ts < SYNC_WRITE_TTL_MS;
  }

  function recordRemoteRename(fromId: string, toId: string): void {
    recentRemoteRenames.set(fromId, { toId, ts: Date.now() });
    for (const [key, value] of recentRemoteRenames) {
      if (Date.now() - value.ts > SYNC_WRITE_TTL_MS) recentRemoteRenames.delete(key);
    }
  }

  function getRecentRemoteRename(id: string): { toId: string; ts: number } | null {
    const entry = recentRemoteRenames.get(id);
    if (!entry) return null;
    if (Date.now() - entry.ts > SYNC_WRITE_TTL_MS) {
      recentRemoteRenames.delete(id);
      return null;
    }
    return entry;
  }

  return {
    recordSyncWrite,
    isRecentSyncWrite,
    recordRemoteRename,
    getRecentRemoteRename,
  };
}

export const writeSuppressor: WriteSuppressor = createWriteSuppressor();

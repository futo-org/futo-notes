/**
 * Write-suppression tracker for the file watcher.
 *
 * When the app writes a note to disk (local save or sync), the OS file watcher
 * fires a change event moments later. Without suppression we'd reload the note
 * the user just saved, clobbering their cursor position and undo history.
 *
 * Three independent maps track recent writes with different TTLs:
 * - recentWrites     (1s TTL) — local saves
 * - recentSyncWrites (5s TTL) — files written by sync (longer because sync
 *   writes are batched and watcher events may arrive after a delay)
 * - recentRemoteRenames (5s TTL) — rename pairs from sync so we can suppress
 *   the unlink event for the old filename
 */

export interface WriteSuppressor {
  recordWrite(filename: string): void;
  isRecentWrite(filename: string): boolean;
  recordSyncWrite(filename: string): void;
  isRecentSyncWrite(filename: string): boolean;
  recordRemoteRename(fromId: string, toId: string): void;
  getRecentRemoteRename(id: string): { toId: string; ts: number } | null;
  /** Snapshot current local writes so they survive TTL expiry during sync. */
  capturePreSyncWrites(): void;
  /** Check if a filename was a known local write when sync started. */
  isPreSyncWrite(filename: string): boolean;
  /** Clear the pre-sync snapshot (call after drain completes). */
  clearPreSyncWrites(): void;
}

export function createWriteSuppressor(): WriteSuppressor {
  const recentWrites = new Map<string, number>();
  const recentSyncWrites = new Map<string, number>();
  const recentRemoteRenames = new Map<string, { toId: string; ts: number }>();
  let preSyncWrites = new Set<string>();

  function recordWrite(filename: string): void {
    recentWrites.set(filename, Date.now());
    for (const [key, ts] of recentWrites) {
      if (Date.now() - ts > 2000) recentWrites.delete(key);
    }
  }

  function isRecentWrite(filename: string): boolean {
    const ts = recentWrites.get(filename);
    return ts !== undefined && Date.now() - ts < 1000;
  }

  function recordSyncWrite(filename: string): void {
    recentSyncWrites.set(filename, Date.now());
    for (const [key, ts] of recentSyncWrites) {
      if (Date.now() - ts > 5000) recentSyncWrites.delete(key);
    }
  }

  function isRecentSyncWrite(filename: string): boolean {
    const ts = recentSyncWrites.get(filename);
    return ts !== undefined && Date.now() - ts < 5000;
  }

  function recordRemoteRename(fromId: string, toId: string): void {
    recentRemoteRenames.set(fromId, { toId, ts: Date.now() });
    for (const [key, value] of recentRemoteRenames) {
      if (Date.now() - value.ts > 5000) recentRemoteRenames.delete(key);
    }
  }

  function getRecentRemoteRename(id: string): { toId: string; ts: number } | null {
    const entry = recentRemoteRenames.get(id);
    if (!entry) return null;
    if (Date.now() - entry.ts > 5000) {
      recentRemoteRenames.delete(id);
      return null;
    }
    return entry;
  }

  function capturePreSyncWrites(): void {
    preSyncWrites = new Set(recentWrites.keys());
  }

  function isPreSyncWrite(filename: string): boolean {
    return preSyncWrites.has(filename);
  }

  function clearPreSyncWrites(): void {
    preSyncWrites.clear();
  }

  return {
    recordWrite,
    isRecentWrite,
    recordSyncWrite,
    isRecentSyncWrite,
    recordRemoteRename,
    getRecentRemoteRename,
    capturePreSyncWrites,
    isPreSyncWrite,
    clearPreSyncWrites,
  };
}

// Module-level singleton. The sync manager and the local note ops both
// need to record writes so the watcher can ignore self-caused events;
// keeping a single suppressor avoids passing it through every call site.
// Tests that want isolation construct their own via `createWriteSuppressor()`.
export const writeSuppressor: WriteSuppressor = createWriteSuppressor();

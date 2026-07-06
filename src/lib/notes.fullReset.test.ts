// Regression: Full reset while connected pushed REAL deletions to the sync
// server (settings.md "Full reset", 2026-07-02 QA).
//
// deleteAllNotes() used to pause→wipe→resume: `resumeSyncV2()` re-armed the
// still-authenticated in-memory session before the caller's
// `window.location.reload()` landed, and in that window the resumed sync/live
// loop diffed the emptied vault against the persisted object map and pushed
// tombstones for every object — propagating as real deletions to every other
// device on the account. The spec requires the reset to run with live sync
// paused AND the connection + stored password dropped so a racing sync cannot
// resurrect (or tombstone) files; the next launch stays LOCAL.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/platform');
vi.mock('./fileSystem', () => ({
  writeNote: vi.fn(),
  deleteNoteFile: vi.fn(),
  deleteAllContent: vi.fn(),
  renameNote: vi.fn(),
  moveNoteFile: vi.fn(),
  getUniqueNoteId: vi.fn(),
  readNote: vi.fn(),
}));
vi.mock('./autoSyncV2', () => ({
  pauseSyncV2: vi.fn(),
  resumeSyncV2: vi.fn(),
  waitForSyncIdleV2: vi.fn(),
}));
vi.mock('./syncServiceE2ee', () => ({
  stopLiveSync: vi.fn(),
  disconnectE2ee: vi.fn(),
}));

import { deleteAllNotes } from './notes.svelte';
import { deleteAllContent } from './fileSystem';
import { pauseSyncV2, resumeSyncV2, waitForSyncIdleV2 } from './autoSyncV2';
import { disconnectE2ee } from './syncServiceE2ee';

/** First invocation order of a mock, for cross-mock sequencing assertions. */
function callOrder(fn: unknown): number {
  const order = (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
  expect(order, 'expected mock to have been called').toBeDefined();
  return order;
}

describe('deleteAllNotes (Full reset) durably kills the sync session', () => {
  it('drops the connection + stored password BEFORE wiping the vault', async () => {
    await deleteAllNotes();

    expect(disconnectE2ee).toHaveBeenCalledTimes(1);
    expect(deleteAllContent).toHaveBeenCalledTimes(1);
    // Disconnect first: once the vault is empty, any authenticated session
    // that wakes up would push tombstones for every object.
    expect(callOrder(disconnectE2ee)).toBeLessThan(callOrder(deleteAllContent));
  });

  it('pauses and drains in-flight sync before disconnecting', async () => {
    await deleteAllNotes();

    expect(callOrder(pauseSyncV2)).toBeLessThan(callOrder(disconnectE2ee));
    expect(callOrder(waitForSyncIdleV2)).toBeLessThan(callOrder(disconnectE2ee));
  });

  it('never re-arms sync while the session is still connected (resume only after disconnect)', async () => {
    await deleteAllNotes();

    expect(resumeSyncV2).toHaveBeenCalledTimes(1);
    expect(callOrder(resumeSyncV2)).toBeGreaterThan(callOrder(disconnectE2ee));
  });

  it('a failed wipe still propagates AND un-pauses sync (reset failure must not leave sync dead)', async () => {
    vi.mocked(deleteAllContent).mockRejectedValueOnce(new Error('disk full'));

    await expect(deleteAllNotes()).rejects.toThrow('disk full');
    // The session was already disconnected before the wipe attempt, so
    // un-pausing here cannot push anything; it just keeps the sync layer
    // usable if the user reconnects without restarting.
    expect(resumeSyncV2).toHaveBeenCalledTimes(1);
  });

  it('a failed disconnect aborts the reset without touching the vault', async () => {
    vi.mocked(disconnectE2ee).mockRejectedValueOnce(new Error('state write failed'));

    await expect(deleteAllNotes()).rejects.toThrow('state write failed');
    // Still connected → must NOT empty the vault (that is exactly the state
    // that produced the mass-tombstone push). Sync is un-paused so the
    // still-connected session keeps working normally.
    expect(deleteAllContent).not.toHaveBeenCalled();
    expect(resumeSyncV2).toHaveBeenCalledTimes(1);
  });
});

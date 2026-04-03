// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncSummary } from './syncServiceV2';

// ── Mocks ───────────────────────────────────────────────────

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));

const syncServiceMocks = vi.hoisted(() => ({
  syncNowV2: vi.fn<() => Promise<SyncSummary>>(),
  checkForChangesV2: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('./syncServiceV2', () => ({
  syncNowV2: syncServiceMocks.syncNowV2,
  checkForChangesV2: syncServiceMocks.checkForChangesV2,
}));

const appStateMocks = vi.hoisted(() => ({
  getCachedPreferences: vi.fn(() => ({
    sync: { serverUrl: 'http://localhost:3005', token: 'test-token' },
  })),
}));

vi.mock('./appState', () => ({
  getCachedPreferences: appStateMocks.getCachedPreferences,
}));

// ── Helpers ─────────────────────────────────────────────────

const emptySummary: SyncSummary = {
  uploaded: 0,
  downloaded: 0,
  deleted: 0,
  conflicts: 0,
  updatedIds: [],
  deletedIds: [],
  renamed: [],
};

/** Simulated network latency for a remote server with a large vault. */
const REMOTE_SYNC_LATENCY_MS = 400;

/** Creates a deferred promise + a resolve handle to settle it on demand. */
function deferred(): { promise: Promise<SyncSummary>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<SyncSummary>(r => {
    resolve = () => r(emptySummary);
  });
  return { promise, resolve };
}

// We need fresh module state per test since autoSyncV2 uses module-level globals.
async function freshAutoSync() {
  vi.resetModules();
  return await import('./autoSyncV2');
}

// ── Tests ───────────────────────────────────────────────────

describe('autoSyncV2 – pendingLocalSave spinner chaining', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const mod = await import('./autoSyncV2');
    mod.stopAutoSyncV2();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should NOT immediately chain a second sync when a save arrives during sync', async () => {
    const { startAutoSyncV2, notifySavedV2, stopAutoSyncV2 } = await freshAutoSync();

    const onSyncStateChange = vi.fn();
    const onSyncComplete = vi.fn();

    // Simulate a remote server with ~400ms round-trip (2000+ note vault)
    const sync1 = deferred();
    const sync2 = deferred();
    let callCount = 0;
    syncServiceMocks.syncNowV2.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return sync1.promise; // initial sync
      if (callCount === 2) return sync2.promise; // local-save sync
      // sync 3 = the chained retry — if it fires within 1s, the bug is present
      return deferred().promise;
    });

    startAutoSyncV2({
      onSyncComplete,
      onSyncError: vi.fn(),
      flushPendingSave: vi.fn(async () => {}),
      onSyncStateChange,
    });

    // ── Let the initial sync fire (2s delay) and complete ──
    await vi.advanceTimersByTimeAsync(2_000);
    sync1.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // ── Trigger a local-save sync ──
    notifySavedV2();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncServiceMocks.syncNowV2).toHaveBeenCalledTimes(2);

    // ── Simulate user typing mid-sync (save arrives while sync is in flight) ──
    await vi.advanceTimersByTimeAsync(REMOTE_SYNC_LATENCY_MS / 2); // 200ms into sync
    notifySavedV2(); // sets pendingLocalSave = true

    // ── Sync 2 completes after full latency ──
    await vi.advanceTimersByTimeAsync(REMOTE_SYNC_LATENCY_MS / 2); // remaining 200ms
    onSyncStateChange.mockClear();
    sync2.resolve();

    // Advance 1s — enough for the old immediate retry to fire and start a
    // chained sync, but not enough for the fixed 2s delayed retry.
    await vi.advanceTimersByTimeAsync(1_000);

    const calls = onSyncStateChange.mock.calls.map((args) => args[0] as boolean);

    // Should see sync end (false) but NOT an immediate restart (true).
    // Bug: [false, true] — spinner chains, visible for 400ms + 400ms + 1s = ~1.8s
    // Fix: [false]       — spinner hides, retry deferred 2s
    expect(calls).toEqual([false]);

    stopAutoSyncV2();
  });
});

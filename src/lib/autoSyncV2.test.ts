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
  loadV2SyncState: vi.fn(async () => ({
    deviceId: 'device-a',
    lastServerVersion: 0,
    fileHashes: {},
  })),
  saveV2SyncState: vi.fn(async () => {}),
}));

vi.mock('./appState', () => ({
  getCachedPreferences: appStateMocks.getCachedPreferences,
  loadV2SyncState: appStateMocks.loadV2SyncState,
  saveV2SyncState: appStateMocks.saveV2SyncState,
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

describe('autoSyncV2 – dirty journal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    appStateMocks.loadV2SyncState.mockReset();
    appStateMocks.saveV2SyncState.mockReset();
    appStateMocks.loadV2SyncState.mockResolvedValue({
      deviceId: 'device-a',
      lastServerVersion: 0,
      fileHashes: {},
    });
    appStateMocks.saveV2SyncState.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const mod = await import('./autoSyncV2');
    mod.stopAutoSyncV2();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('markDirtyUpsert persists filename to sync state', async () => {
    const { startAutoSyncV2, notifySavedV2, stopAutoSyncV2 } = await freshAutoSync();

    // syncNowV2 should never resolve for this test — we only care about the journal write
    syncServiceMocks.syncNowV2.mockReturnValue(new Promise(() => {}));

    startAutoSyncV2({
      onSyncComplete: vi.fn(),
      onSyncError: vi.fn(),
      flushPendingSave: vi.fn(async () => {}),
    });

    // Skip the initial sync timer
    await vi.advanceTimersByTimeAsync(2_000);

    // Clear the mock calls from initial setup / initial sync
    appStateMocks.saveV2SyncState.mockClear();
    appStateMocks.loadV2SyncState.mockResolvedValue({
      deviceId: 'device-a',
      lastServerVersion: 0,
      fileHashes: {},
    });

    // Trigger a save notification with a filename — this calls markDirtyUpsert internally
    notifySavedV2('file.md');

    // Let the async markDirtyUpsert settle
    await vi.advanceTimersByTimeAsync(0);

    // saveV2SyncState should have been called with dirtyUpserts containing the filename
    const saveCalls = appStateMocks.saveV2SyncState.mock.calls;
    const journalSave = saveCalls.find(
      (call) => call[0]?.dirtyUpserts && call[0].dirtyUpserts.includes('file.md'),
    );
    expect(journalSave).toBeDefined();

    stopAutoSyncV2();
  });

  it('markDirtyDelete persists filename to sync state', async () => {
    const { markDirtyDelete } = await freshAutoSync();

    appStateMocks.loadV2SyncState.mockResolvedValue({
      deviceId: 'device-a',
      lastServerVersion: 0,
      fileHashes: {},
    });

    await markDirtyDelete('file.md');

    const saveCalls = appStateMocks.saveV2SyncState.mock.calls;
    const journalSave = saveCalls.find(
      (call) => call[0]?.dirtyDeletes && call[0].dirtyDeletes.includes('file.md'),
    );
    expect(journalSave).toBeDefined();
  });

  it('markDirtyRename writes both entries', async () => {
    const { markDirtyRename } = await freshAutoSync();

    appStateMocks.loadV2SyncState.mockResolvedValue({
      deviceId: 'device-a',
      lastServerVersion: 0,
      fileHashes: {},
    });

    await markDirtyRename('old.md', 'new.md');

    const saveCalls = appStateMocks.saveV2SyncState.mock.calls;
    const journalSave = saveCalls.find(
      (call) =>
        call[0]?.dirtyDeletes?.includes('old.md') &&
        call[0]?.dirtyUpserts?.includes('new.md'),
    );
    expect(journalSave).toBeDefined();
  });
});

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

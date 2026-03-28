// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPreferences } from './preferences';
import type { SyncSummary } from './sync';

vi.mock('$lib/platform', () => ({
  hasFileSystem: true,
}));

vi.mock('./preferences', () => ({
  getCachedPreferences: vi.fn(),
}));

vi.mock('./sync', () => ({
  syncNow: vi.fn(),
}));

let sseNotificationHandler: (() => void) | null = null;

vi.mock('./sseClient', () => ({
  startSSE: vi.fn((onSyncAvailable: () => void) => {
    sseNotificationHandler = onSyncAvailable;
  }),
  stopSSE: vi.fn(),
  isSSEConnected: vi.fn(() => true),
}));

import { getCachedPreferences } from './preferences';
import { syncNow } from './sync';
import { startAutoSync, stopAutoSync, notifySaved, requestSync } from './autoSync';

const mockGetCachedPreferences = vi.mocked(getCachedPreferences);
const mockSyncNow = vi.mocked(syncNow);

function makePrefs(overrides: Partial<AppPreferences['sync']> = {}): AppPreferences {
  return {
    appearance: { theme: 'auto' },
    crashReporting: { enabled: false, alwaysSend: false },
    sync: {
      serverUrl: 'https://sync.example.com',
      token: 'test-token',
      lastSyncedAt: null,
      lastError: '',
      ...overrides,
    },
  };
}

describe('autoSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sseNotificationHandler = null;
    mockGetCachedPreferences.mockReturnValue(makePrefs());
  });

  afterEach(() => {
    stopAutoSync();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('window focus event triggers resume sync', async () => {
    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 1,
      deleted: 0,
      conflicts: 0,
      updatedIds: ['note-1'],
      deletedIds: [],
      renamed: [],
    };
    mockSyncNow.mockResolvedValue(summary);

    const onSyncComplete = vi.fn();
    const onSyncError = vi.fn();
    const flushPendingSave = vi.fn().mockResolvedValue(undefined);

    startAutoSync({
      onSyncComplete,
      onSyncError,
      flushPendingSave,
    });

    // Advance past initial sync timer
    await vi.advanceTimersByTimeAsync(2_000);
    mockSyncNow.mockClear();
    onSyncComplete.mockClear();

    // Advance past RESUME_COOLDOWN so handleResume doesn't bail
    await vi.advanceTimersByTimeAsync(10_000);

    // Simulate window focus (e.g., Alt-Tab back to app)
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSyncNow).toHaveBeenCalledTimes(1);
    expect(onSyncComplete).toHaveBeenCalled();
  });

  it('retries a dropped local-save sync after in-flight sync completes', async () => {
    let resolveSyncNow: ((v: SyncSummary) => void) | null = null;
    const summary: SyncSummary = {
      uploaded: 1,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      updatedIds: ['note-1'],
      deletedIds: [],
      renamed: [],
    };

    // First call: hang until we resolve manually. Subsequent calls: resolve immediately.
    mockSyncNow.mockImplementationOnce(() => new Promise<SyncSummary>(resolve => {
      resolveSyncNow = resolve;
    }));
    mockSyncNow.mockResolvedValue(summary);

    const onSyncComplete = vi.fn();
    const onSyncError = vi.fn();
    const flushPendingSave = vi.fn().mockResolvedValue(undefined);

    startAutoSync({
      onSyncComplete,
      onSyncError,
      flushPendingSave,
    });

    // Advance past initial sync timer — this starts the first (hanging) sync
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
    mockSyncNow.mockClear();
    onSyncComplete.mockClear();

    // While that sync is in-flight, a local save fires
    notifySaved();
    await vi.advanceTimersByTimeAsync(0);
    // syncNow should NOT have been called again yet — still in-flight
    expect(mockSyncNow).not.toHaveBeenCalled();

    // Complete the first sync
    resolveSyncNow!(summary);
    // Let the finally block's setTimeout(…, 0) fire
    await vi.advanceTimersByTimeAsync(0);

    // The dropped local-save should now have triggered a follow-up sync
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
    expect(onSyncComplete).toHaveBeenCalledTimes(2); // first sync + retry
  });

  it('requestSync() before startAutoSync() falls back to direct syncNow()', async () => {
    const summary: SyncSummary = {
      uploaded: 1,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      updatedIds: ['note-1'],
      deletedIds: [],
      renamed: [],
    };
    mockSyncNow.mockResolvedValue(summary);

    // Do NOT call startAutoSync() — callbacks is null
    // requestSync() should not throw "Sync system not initialized"
    await expect(requestSync()).resolves.toBeUndefined();
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });

  it('retries a deferred SSE sync after the editor stops deferring', async () => {
    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 1,
      deleted: 0,
      conflicts: 0,
      updatedIds: ['journal 2026-03-11'],
      deletedIds: [],
      renamed: [],
    };
    mockSyncNow.mockResolvedValue(summary);

    const flushPendingSave = vi.fn().mockResolvedValue(undefined);
    const onSyncComplete = vi.fn();
    const onSyncError = vi.fn();
    let deferSync = true;

    startAutoSync({
      onSyncComplete,
      onSyncError,
      flushPendingSave,
      shouldDeferSync: () => deferSync,
    });

    expect(sseNotificationHandler).not.toBeNull();

    sseNotificationHandler?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(mockSyncNow).not.toHaveBeenCalled();
    expect(onSyncComplete).not.toHaveBeenCalled();

    deferSync = false;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockSyncNow).toHaveBeenCalledTimes(1);
    expect(onSyncComplete).toHaveBeenCalledWith(summary);
    expect(onSyncError).not.toHaveBeenCalled();
    expect(flushPendingSave).not.toHaveBeenCalled();
  });
});

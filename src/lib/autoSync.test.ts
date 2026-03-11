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
  startSSE: vi.fn((_serverUrl: string, _token: string, onSyncAvailable: () => void) => {
    sseNotificationHandler = onSyncAvailable;
  }),
  stopSSE: vi.fn(),
  isSSEConnected: vi.fn(() => true),
}));

import { getCachedPreferences } from './preferences';
import { syncNow } from './sync';
import { startAutoSync, stopAutoSync } from './autoSync';

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

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncE2eeAuto: vi.fn(),
  isE2eeConfigured: vi.fn(),
  ensureLiveSync: vi.fn(),
  stopLiveSync: vi.fn(),
  notifyNoteChanged: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  liveListener: null as null | ((event: { payload: { live: boolean; status: string } }) => void),
}));

vi.mock('$lib/platform', () => ({
  hasFileSystem: true,
  isTauri: true,
}));

vi.mock('./syncServiceE2ee', () => ({
  syncE2eeAuto: mocks.syncE2eeAuto,
  isE2eeConfigured: mocks.isE2eeConfigured,
  ensureLiveSync: mocks.ensureLiveSync,
  stopLiveSync: mocks.stopLiveSync,
  notifyNoteChanged: mocks.notifyNoteChanged,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

import { startAutoSyncV2, stopAutoSyncV2, type AutoSyncCallbacks } from './autoSyncV2';

function summary() {
  return {
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    updatedIds: [],
    deletedIds: [],
    renamed: [],
    peerUpdatedIds: [],
    peerDeletedIds: [],
  };
}

function callbacks(): AutoSyncCallbacks {
  return {
    onSyncComplete: vi.fn(),
    onSyncError: vi.fn(),
    flushPendingSave: vi.fn(async () => {}),
  };
}

describe('autoSyncV2 polling cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    if (!('navigator' in globalThis)) {
      vi.stubGlobal('navigator', { onLine: true });
    } else {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    }
    mocks.syncE2eeAuto.mockResolvedValue(summary());
    mocks.isE2eeConfigured.mockReturnValue(true);
    mocks.ensureLiveSync.mockResolvedValue(undefined);
    mocks.stopLiveSync.mockResolvedValue(undefined);
    mocks.notifyNoteChanged.mockResolvedValue(undefined);
    mocks.unlisten = vi.fn();
    mocks.liveListener = null;
    mocks.listen.mockImplementation(async (event: string, cb: typeof mocks.liveListener) => {
      if (event === 'sync:live-state') mocks.liveListener = cb;
      return mocks.unlisten;
    });
  });

  afterEach(() => {
    stopAutoSyncV2();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps the 15s poll cadence while live sync is disconnected', async () => {
    startAutoSyncV2(callbacks());
    await vi.advanceTimersByTimeAsync(8_000);
    mocks.syncE2eeAuto.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(3);
  });

  it('backs off polling while live sync is connected', async () => {
    startAutoSyncV2(callbacks());
    await vi.advanceTimersByTimeAsync(8_000);
    mocks.syncE2eeAuto.mockClear();

    expect(mocks.liveListener).toBeTruthy();
    mocks.liveListener?.({ payload: { live: true, status: 'connected' } });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(2);
  });
});

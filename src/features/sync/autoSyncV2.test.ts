// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncE2eeAuto: vi.fn(),
  isE2eeConfigured: vi.fn(),
  ensureLiveSync: vi.fn(),
  stopLiveSync: vi.fn(),
  notifyNoteChanged: vi.fn(),
  whenSyncCredentialsSettled: vi.fn(),
  settleCredentials: () => {},
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
  whenSyncCredentialsSettled: mocks.whenSyncCredentialsSettled,
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
    mocks.whenSyncCredentialsSettled.mockReturnValue(
      new Promise<void>((resolve) => {
        mocks.settleCredentials = resolve;
      }),
    );
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
    mocks.settleCredentials();
    await vi.advanceTimersByTimeAsync(8_000);
    mocks.syncE2eeAuto.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(3);
  });

  it('backs off polling while live sync is connected', async () => {
    startAutoSyncV2(callbacks());
    mocks.settleCredentials();
    await vi.advanceTimersByTimeAsync(8_000);
    mocks.syncE2eeAuto.mockClear();

    expect(mocks.liveListener).toBeTruthy();
    mocks.liveListener?.({ payload: { live: true, status: 'connected' } });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(2);
  });
});

// "Once I open the app, sync should start immediately." It used to wait a flat
// 8s (8.6s measured from process start to the first cycle), inherited from a
// mobile perf pass for a shell that no longer runs this code. The first cycle
// now waits on the one thing it genuinely depends on — the boot credential load
// that makes `isE2eeConfigured()` answer truthfully — and on nothing else.
describe('autoSyncV2 first cycle after launch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    mocks.syncE2eeAuto.mockResolvedValue(summary());
    mocks.isE2eeConfigured.mockReturnValue(true);
    mocks.ensureLiveSync.mockResolvedValue(undefined);
    mocks.stopLiveSync.mockResolvedValue(undefined);
    mocks.whenSyncCredentialsSettled.mockReturnValue(
      new Promise<void>((resolve) => {
        mocks.settleCredentials = resolve;
      }),
    );
    mocks.listen.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    stopAutoSyncV2();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('runs the first cycle as soon as boot credentials settle, with no timer wait', async () => {
    startAutoSyncV2(callbacks());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.syncE2eeAuto).not.toHaveBeenCalled();

    mocks.settleCredentials();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(1);
  });

  it('reports the first cycle as the initial trigger', async () => {
    const cb = callbacks();
    startAutoSyncV2(cb);
    mocks.settleCredentials();
    await vi.advanceTimersByTimeAsync(0);

    expect(cb.onSyncComplete).toHaveBeenCalledWith(expect.anything(), 'initial');
  });

  it('reports a failed cycle with the trigger that caused it', async () => {
    const cb = callbacks();
    const error = new TypeError('Load failed');
    mocks.syncE2eeAuto.mockRejectedValueOnce(error);
    startAutoSyncV2(cb);
    mocks.settleCredentials();
    await vi.advanceTimersByTimeAsync(0);

    expect(cb.onSyncError).toHaveBeenCalledWith(error, 'initial');
  });

  it('does not run a second first cycle when the fallback timer comes due', async () => {
    startAutoSyncV2(callbacks());
    mocks.settleCredentials();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(1);

    // Far enough to pass the fallback but short of the first 15s poll.
    await vi.advanceTimersByTimeAsync(14_000);

    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(1);
  });

  it('still runs a first cycle when nothing ever settles the credentials', async () => {
    // A host that never runs the boot credential hook must not be left with a
    // session that never syncs at all.
    startAutoSyncV2(callbacks());
    await vi.advanceTimersByTimeAsync(7_000);
    expect(mocks.syncE2eeAuto).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(1);
  });

  it('retries on the initial ladder when credentials settle to no configured vault', async () => {
    mocks.isE2eeConfigured.mockReturnValue(false);
    startAutoSyncV2(callbacks());
    mocks.settleCredentials();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.syncE2eeAuto).not.toHaveBeenCalled();

    mocks.isE2eeConfigured.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(mocks.syncE2eeAuto).toHaveBeenCalledTimes(1);
  });
});

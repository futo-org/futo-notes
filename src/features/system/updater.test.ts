import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PendingUpdate } from './updater';

const checkMock = vi.fn();
const relaunchMock = vi.fn();

vi.mock('$lib/platform', () => ({ isDesktop: true }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: checkMock }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: relaunchMock }));

import {
  checkForUpdate,
  installUpdate,
  relaunchApp,
  selfUpdateSupported,
  updaterSupported,
} from './updater';

beforeEach(() => {
  checkMock.mockReset();
  relaunchMock.mockReset();
  vi.unstubAllEnvs();
});

describe('updaterSupported', () => {
  it('is true on desktop', () => {
    expect(updaterSupported()).toBe(true);
  });
});

describe('fake update mode (dev VITE_FAKE_UPDATE)', () => {
  it('selfUpdateSupported short-circuits true (a dev build reports unsupported otherwise)', async () => {
    vi.stubEnv('VITE_FAKE_UPDATE', '2.0.0');
    expect(await selfUpdateSupported()).toBe(true);
  });

  it('checkForUpdate returns a synthetic update without hitting the plugin', async () => {
    vi.stubEnv('VITE_FAKE_UPDATE', '2.0.0');
    const u = await checkForUpdate();
    expect(u?.version).toBe('2.0.0');
    expect(u?.currentVersion).toBe('0.1.0');
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('installUpdate simulates progress to 100, signals completion, never relaunches', async () => {
    vi.stubEnv('VITE_FAKE_UPDATE', '2.0.0');
    vi.useFakeTimers();
    const u = await checkForUpdate();
    const progress: Array<[number, number | null]> = [];
    const done = vi.fn();
    const p = installUpdate(u!, (received, total) => progress.push([received, total]), done);
    await vi.advanceTimersByTimeAsync(200 * 6 + 50);
    await p;
    expect(progress.at(-1)).toEqual([100, 100]);
    expect(done).toHaveBeenCalledOnce();
    expect(relaunchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('relaunchApp is a no-op (does not kill the dev app)', async () => {
    vi.stubEnv('VITE_FAKE_UPDATE', '2.0.0');
    await relaunchApp();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it('with fake off, checkForUpdate falls through to the real plugin', async () => {
    checkMock.mockResolvedValue(null);
    expect(await checkForUpdate()).toBeNull();
    expect(checkMock).toHaveBeenCalledOnce();
  });
});

describe('checkForUpdate', () => {
  it('returns null when already up to date', async () => {
    checkMock.mockResolvedValue(null);
    expect(await checkForUpdate()).toBeNull();
  });

  it('maps version/notes/date from the plugin Update', async () => {
    checkMock.mockResolvedValue({
      version: '1.6.0',
      currentVersion: '1.5.4',
      body: 'Bug fixes',
      date: '2026-06-23T00:00:00Z',
    });
    const u = await checkForUpdate();
    expect(u).toMatchObject({
      version: '1.6.0',
      currentVersion: '1.5.4',
      notes: 'Bug fixes',
      date: '2026-06-23T00:00:00Z',
    });
    expect(u?.handle).toBeDefined();
  });

  it('normalizes empty notes/date to undefined', async () => {
    checkMock.mockResolvedValue({ version: '1.6.0', currentVersion: '1.5.4', body: '', date: '' });
    const u = await checkForUpdate();
    expect(u?.notes).toBeUndefined();
    expect(u?.date).toBeUndefined();
  });

  it('propagates endpoint/network errors to the caller', async () => {
    checkMock.mockRejectedValue(new Error('network down'));
    await expect(checkForUpdate()).rejects.toThrow('network down');
  });

  it('returns null without hitting the endpoint when unsupported', async () => {
    vi.resetModules();
    vi.doMock('$lib/platform', () => ({ isDesktop: false }));
    vi.doMock('@tauri-apps/plugin-updater', () => ({ check: checkMock }));
    const { checkForUpdate: cfu, updaterSupported: us } = await import('./updater');
    checkMock.mockClear();
    expect(us()).toBe(false);
    expect(await cfu()).toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
    vi.resetModules();
  });
});

describe('installUpdate', () => {
  it('accumulates byte progress then relaunches', async () => {
    const events = [
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Progress', data: { chunkLength: 60 } },
      { event: 'Finished' },
    ];
    const downloadAndInstall = vi.fn(async (cb: (e: unknown) => void) => {
      for (const e of events) cb(e);
    });
    const update = {
      version: '1.6.0',
      currentVersion: '1.5.4',
      handle: { downloadAndInstall },
    } as unknown as PendingUpdate;

    const progress: Array<[number, number | null]> = [];
    await installUpdate(update, (received, total) => progress.push([received, total]));

    expect(progress).toEqual([
      [0, 100],
      [40, 100],
      [100, 100],
      [100, 100],
    ]);
    expect(relaunchMock).toHaveBeenCalledOnce();
  });

  it('handles a missing contentLength (unknown total)', async () => {
    const events = [
      { event: 'Started', data: {} },
      { event: 'Progress', data: { chunkLength: 25 } },
      { event: 'Finished' },
    ];
    const downloadAndInstall = vi.fn(async (cb: (e: unknown) => void) => {
      for (const e of events) cb(e);
    });
    const update = { handle: { downloadAndInstall } } as unknown as PendingUpdate;

    const progress: Array<[number, number | null]> = [];
    await installUpdate(update, (received, total) => progress.push([received, total]));

    expect(progress).toEqual([
      [0, null],
      [25, null],
      [25, null],
    ]);
    expect(relaunchMock).toHaveBeenCalledOnce();
  });

  it('fires onDownloadComplete on the Finished event (before relaunch)', async () => {
    const events = [
      { event: 'Started', data: { contentLength: 50 } },
      { event: 'Progress', data: { chunkLength: 50 } },
      { event: 'Finished' },
    ];
    const downloadAndInstall = vi.fn(async (cb: (e: unknown) => void) => {
      for (const e of events) cb(e);
    });
    const update = { handle: { downloadAndInstall } } as unknown as PendingUpdate;

    const onDownloadComplete = vi.fn();
    await installUpdate(update, undefined, onDownloadComplete);
    expect(onDownloadComplete).toHaveBeenCalledOnce();
    expect(relaunchMock).toHaveBeenCalledOnce();
  });
});

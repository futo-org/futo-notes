// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PendingUpdate } from './updater';

const checkMock = vi.fn();
const installMock = vi.fn();
const relaunchMock = vi.fn();
const supportedMock = vi.fn(() => true);
const selfSupportedMock = vi.fn(async () => true);

vi.mock('./updater', () => ({
  checkForUpdate: checkMock,
  installUpdate: installMock,
  relaunchApp: relaunchMock,
  updaterSupported: supportedMock,
  selfUpdateSupported: selfSupportedMock,
}));

const loadPreferencesMock = vi.fn(async () => ({ updates: { enabled: true } }));
vi.mock('$shared/state/appState', () => ({ loadPreferences: loadPreferencesMock }));

function makeUpdate(version = '1.6.0', notes?: string): PendingUpdate {
  return {
    version,
    currentVersion: '1.5.0',
    notes,
    handle: {} as PendingUpdate['handle'],
  };
}

async function fresh() {
  vi.resetModules();
  const mod = await import('./updateChecker.svelte');
  return mod.updateChecker;
}

beforeEach(() => {
  checkMock.mockReset();
  installMock.mockReset();
  relaunchMock.mockReset();
  supportedMock.mockReset().mockReturnValue(true);
  selfSupportedMock.mockReset().mockResolvedValue(true);
  loadPreferencesMock.mockReset().mockResolvedValue({ updates: { enabled: true } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('check (manual)', () => {
  it('surfaces an available update and shows the banner', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check();
    expect(upd.phase).toBe('available');
    expect(upd.pending?.version).toBe('2.0.0');
    expect(upd.bannerVisible).toBe(true);
  });

  it('reports up-to-date and keeps the banner hidden', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(null);
    await upd.check();
    expect(upd.phase).toBe('up-to-date');
    expect(upd.bannerVisible).toBe(false);
  });

  it('surfaces errors but does not pop the banner (not engaged)', async () => {
    const upd = await fresh();
    checkMock.mockRejectedValue(new Error('network down'));
    await upd.check();
    expect(upd.phase).toBe('error');
    expect(upd.error).toBe('network down');
    expect(upd.bannerVisible).toBe(false);
  });
});

describe('check (silent / background)', () => {
  it('found → available + banner', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check({ silent: true });
    expect(upd.phase).toBe('available');
    expect(upd.bannerVisible).toBe(true);
  });

  it('none → idle (no "up-to-date" nag)', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(null);
    await upd.check({ silent: true });
    expect(upd.phase).toBe('idle');
    expect(upd.bannerVisible).toBe(false);
  });

  it('error → swallowed, never wedges on "checking", no banner', async () => {
    const upd = await fresh();
    checkMock.mockRejectedValue(new Error('boom'));
    await expect(upd.check({ silent: true })).resolves.toBeUndefined();
    expect(upd.phase).not.toBe('checking');
    expect(upd.phase).toBe('idle');
    expect(upd.bannerVisible).toBe(false);
  });

  it('a hung background check never blocks the manual Settings button', async () => {
    const upd = await fresh();
    checkMock.mockReturnValue(new Promise(() => {}));
    void upd.check({ silent: true });
    expect(upd.busy).toBe(false);
    expect(upd.phase).toBe('idle');
  });

  it('does not clobber an install already in progress', async () => {
    const upd = await fresh();
    upd.phase = 'downloading';
    checkMock.mockResolvedValue(makeUpdate('9.9.9'));
    await upd.check({ silent: true });
    expect(upd.phase).toBe('downloading');
  });

  it('does not clobber an engaged error state (preserves the retry banner)', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check();
    installMock.mockRejectedValue(new Error('verify failed'));
    await upd.install();
    expect(upd.phase).toBe('error');
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check({ silent: true });
    expect(upd.phase).toBe('error');
    expect(upd.error).toBe('verify failed');
  });

  it('a NEWER version overrides a stuck error (transient failure must not wedge auto-update)', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check();
    installMock.mockRejectedValue(new Error('verify failed'));
    await upd.install();
    expect(upd.phase).toBe('error');
    checkMock.mockResolvedValue(makeUpdate('2.1.0'));
    await upd.check({ silent: true });
    expect(upd.phase).toBe('available');
    expect(upd.pending?.version).toBe('2.1.0');
    expect(upd.bannerVisible).toBe(true);
  });

  it('retracts a stale "available" when the offered release is gone (yanked)', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check({ silent: true });
    expect(upd.phase).toBe('available');
    checkMock.mockResolvedValue(null);
    await upd.check({ silent: true });
    expect(upd.phase).toBe('idle');
    expect(upd.pending).toBeNull();
    expect(upd.bannerVisible).toBe(false);
  });
});

describe('install', () => {
  it('forwards progress, then auto-relaunches when installUpdate returns', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check();
    installMock.mockImplementation(
      async (_u: PendingUpdate, onProgress: (r: number, t: number | null) => void) => {
        onProgress(40, 100);
      },
    );
    await upd.install();
    expect(installMock).toHaveBeenCalledOnce();
    expect(upd.percent).toBe(40);
    expect(relaunchMock).toHaveBeenCalledOnce();
    expect(upd.phase).toBe('restart');
  });

  it('on failure shows the banner with a retry (engaged)', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check();
    installMock.mockRejectedValue(new Error('verify failed'));
    await upd.install();
    expect(upd.phase).toBe('error');
    expect(upd.error).toBe('verify failed');
    expect(upd.bannerVisible).toBe(true); // engaged + pending
  });

  it('no-ops without a pending update', async () => {
    const upd = await fresh();
    await upd.install();
    expect(installMock).not.toHaveBeenCalled();
  });

  it('advances to "installing" on download-complete even when total is unknown', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check();
    installMock.mockImplementation(
      async (
        _u: PendingUpdate,
        onProgress: (r: number, t: number | null) => void,
        onDownloadComplete: () => void,
      ) => {
        onProgress(1024, null);
        expect(upd.phase).toBe('downloading'); // can't compute completion → still downloading
        onDownloadComplete();
        expect(upd.phase).toBe('installing'); // flipped by the download-complete signal
      },
    );
    await upd.install();
    expect(installMock).toHaveBeenCalledOnce();
  });
});

describe('start', () => {
  it('no-ops when self-update is unsupported', async () => {
    supportedMock.mockReturnValue(false);
    const upd = await fresh();
    await upd.start();
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('no-ops when updates are disabled in preferences', async () => {
    loadPreferencesMock.mockResolvedValue({ updates: { enabled: false } });
    const upd = await fresh();
    await upd.start();
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('checks immediately and again on the hourly interval', async () => {
    vi.useFakeTimers();
    const upd = await fresh();
    checkMock.mockResolvedValue(null);
    await upd.start();
    expect(checkMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(checkMock).toHaveBeenCalledTimes(2);

    upd.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(checkMock).toHaveBeenCalledTimes(2); // stopped — no further checks
  });

  it('is idempotent', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(null);
    await upd.start();
    await upd.start();
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it('a stop()+start() while the support gate is awaiting does not leak an interval', async () => {
    vi.useFakeTimers();
    const upd = await fresh();
    checkMock.mockResolvedValue(null);
    let resolveGate!: (v: boolean) => void;
    selfSupportedMock.mockReturnValue(
      new Promise<boolean>((r) => {
        resolveGate = r;
      }),
    );

    const p1 = upd.start(); // claims #started, awaits the gate
    upd.stop(); // teardown: clears #started
    const p2 = upd.start(); // remount: re-claims, awaits the same gate
    resolveGate(true);
    await Promise.all([p1, p2]);

    expect(checkMock).toHaveBeenCalledTimes(1); // one immediate check
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(checkMock).toHaveBeenCalledTimes(2); // exactly one interval, not two
    upd.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(checkMock).toHaveBeenCalledTimes(2); // stop() cancels the only timer
  });
});

describe('disable', () => {
  it('clears a pending update so the banner + action disappear', async () => {
    const upd = await fresh();
    checkMock.mockResolvedValue(makeUpdate('2.0.0'));
    await upd.check();
    expect(upd.phase).toBe('available');
    expect(upd.bannerVisible).toBe(true);

    upd.disable();
    expect(upd.phase).toBe('idle');
    expect(upd.pending).toBeNull();
    expect(upd.bannerVisible).toBe(false);
  });

  it('stops the hourly poll', async () => {
    vi.useFakeTimers();
    const upd = await fresh();
    checkMock.mockResolvedValue(null);
    await upd.start();
    expect(checkMock).toHaveBeenCalledTimes(1);

    upd.disable();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(checkMock).toHaveBeenCalledTimes(1); // no further checks after disable
  });

  it('a silent check resolving after disable() does not resurrect the banner', async () => {
    const upd = await fresh();
    let resolveCheck!: (u: PendingUpdate) => void;
    checkMock.mockReturnValue(
      new Promise((r) => {
        resolveCheck = r;
      }),
    );
    const inFlight = upd.check({ silent: true });
    upd.disable();
    resolveCheck(makeUpdate('2.0.0'));
    await inFlight;
    expect(upd.phase).toBe('idle');
    expect(upd.pending).toBeNull();
    expect(upd.bannerVisible).toBe(false);

    checkMock.mockResolvedValue(makeUpdate('2.1.0'));
    await upd.start();
    await vi.waitFor(() => expect(upd.phase).toBe('available'));
    expect(upd.bannerVisible).toBe(true);
    upd.stop();
  });
});

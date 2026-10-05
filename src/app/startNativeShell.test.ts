// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeCleanup: vi.fn(),
  fileCleanup: vi.fn(),
  onCloseRequested: vi.fn(),
  onFileChange: vi.fn(),
  loadVaultAvailability: vi.fn(),
  onVaultCommandFailed: vi.fn(),
  recheckVaultAvailability: vi.fn(async () => undefined),
  showGlobalToast: vi.fn(),
}));

vi.mock('$lib/platform', () => ({ isTauri: true }));
vi.mock('$lib/platform/tauri', () => ({
  flushAppConfigWrites: vi.fn(async () => undefined),
  onFileChange: mocks.onFileChange,
  onVaultCommandFailed: mocks.onVaultCommandFailed,
  sweepStaleTemps: vi.fn(async () => undefined),
  reportUnsavedEdits: vi.fn(async () => undefined),
}));
vi.mock('$features/storage/vaultAvailability.svelte', () => ({
  loadVaultAvailability: mocks.loadVaultAvailability,
  recheckVaultAvailability: mocks.recheckVaultAvailability,
}));
vi.mock('$shared/notifications/toastBus.svelte', () => ({
  showGlobalToast: mocks.showGlobalToast,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: vi.fn(),
    onCloseRequested: mocks.onCloseRequested,
  }),
}));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: vi.fn() }));

import { startNativeShell } from './startNativeShell';

const vaultStatus = (overrides: { available?: boolean } = {}) => ({
  displayPath: '/vault',
  isCustom: false,
  available: overrides.available ?? true,
  deletesArePermanent: false,
  folderDeletesArePermanent: false,
});

describe('startNativeShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onFileChange.mockReturnValue(mocks.fileCleanup);
    mocks.onCloseRequested.mockResolvedValue(mocks.closeCleanup);
    mocks.loadVaultAvailability.mockResolvedValue(vaultStatus());
  });

  it('closes the window even when the save drain hangs', async () => {
    vi.useFakeTimers();
    try {
      let closeHandler!: (event: { preventDefault: () => void }) => Promise<void>;
      mocks.onCloseRequested.mockImplementation(async (handler) => {
        closeHandler = handler;
        return mocks.closeCleanup;
      });
      startNativeShell({
        enqueueFileChange: vi.fn(),
        isSavePending: () => false,
        flushSave: vi.fn(() => new Promise<void>(() => {})),
      });
      await vi.waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalledOnce());

      const closed = closeHandler({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(3000);
      await closed;

      const { exit } = await import('@tauri-apps/plugin-process');
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the window when the save drain rejects', async () => {
    let closeHandler!: (event: { preventDefault: () => void }) => Promise<void>;
    mocks.onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return mocks.closeCleanup;
    });
    startNativeShell({
      enqueueFileChange: vi.fn(),
      isSavePending: () => false,
      flushSave: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    await vi.waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalledOnce());

    await closeHandler({ preventDefault: vi.fn() });

    const { exit } = await import('@tauri-apps/plugin-process');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('disposes handlers that finish registering after teardown', async () => {
    const stop = startNativeShell({
      enqueueFileChange: vi.fn(),
      isSavePending: () => false,
      flushSave: vi.fn(async () => undefined),
    });

    stop();

    await vi.waitFor(() => {
      expect(mocks.onFileChange).toHaveBeenCalledOnce();
      expect(mocks.onCloseRequested).toHaveBeenCalledOnce();
    });
    expect(mocks.fileCleanup).toHaveBeenCalledOnce();
    expect(mocks.closeCleanup).toHaveBeenCalledOnce();
  });

  it('tells the user when the watcher never started', async () => {
    startNativeShell({
      enqueueFileChange: vi.fn(),
      flushSave: vi.fn(async () => undefined),
      isSavePending: () => false,
    });
    await vi.waitFor(() => expect(mocks.onFileChange).toHaveBeenCalledOnce());

    // A watcher that failed to start looks exactly like a vault nobody is
    // editing, so the shell has to say so rather than only log it.
    const onStartFailed = mocks.onFileChange.mock.calls[0][1] as (message: string) => void;
    onStartFailed('inotify limit reached');

    await vi.waitFor(() =>
      expect(mocks.showGlobalToast).toHaveBeenCalledWith({ path: 'system.watcherUnavailable' }),
    );
  });

  it('leaves the watcher failure to the vault banner when the vault is why it failed', async () => {
    mocks.loadVaultAvailability.mockResolvedValue(vaultStatus({ available: false }));
    startNativeShell({
      enqueueFileChange: vi.fn(),
      flushSave: vi.fn(async () => undefined),
      isSavePending: () => false,
    });
    await vi.waitFor(() => expect(mocks.onFileChange).toHaveBeenCalledOnce());

    // The decision is the typed vault status, not the failure message's prose —
    // Rust is free to reword its errors without changing what the user sees.
    const onStartFailed = mocks.onFileChange.mock.calls[0][1] as (message: string) => void;
    onStartFailed('anything the backend said');

    await vi.waitFor(() => expect(mocks.loadVaultAvailability).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.showGlobalToast).not.toHaveBeenCalled();
  });

  it('re-checks the vault whenever a vault command fails', () => {
    startNativeShell({
      enqueueFileChange: vi.fn(),
      flushSave: vi.fn(async () => undefined),
      isSavePending: () => false,
    });
    const onFailed = mocks.onVaultCommandFailed.mock.calls[0][0] as () => void;
    onFailed();
    expect(mocks.recheckVaultAvailability).toHaveBeenCalledOnce();
  });
});

describe('startNativeShell close handler, slow disk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onFileChange.mockReturnValue(mocks.fileCleanup);
    mocks.onCloseRequested.mockResolvedValue(mocks.closeCleanup);
    mocks.loadVaultAvailability.mockResolvedValue(vaultStatus());
  });

  it('waits past the 3 s race for a write that is still running, up to its cap', async () => {
    vi.useFakeTimers();
    try {
      let closeHandler!: (event: { preventDefault: () => void }) => Promise<void>;
      mocks.onCloseRequested.mockImplementation(async (handler) => {
        closeHandler = handler;
        return mocks.closeCleanup;
      });
      let finishWrite!: () => void;
      let writing = true;
      startNativeShell({
        enqueueFileChange: vi.fn(),
        isSavePending: () => writing,
        flushSave: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishWrite = () => {
                writing = false;
                resolve();
              };
            }),
        ),
      });
      await vi.waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalledOnce());
      const { exit } = await import('@tauri-apps/plugin-process');
      vi.mocked(exit).mockClear();

      const closed = closeHandler({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(exit).not.toHaveBeenCalled();
      finishWrite();
      await closed;
      expect(exit).toHaveBeenCalledWith(0);

      // A write that never finishes cannot trap the window for ever.
      vi.mocked(exit).mockClear();
      writing = true;
      const stuck = closeHandler({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(15_000);
      await stuck;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

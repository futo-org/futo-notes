// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeCleanup: vi.fn(),
  fileCleanup: vi.fn(),
  onCloseRequested: vi.fn(),
  onFileChange: vi.fn(),
  vaultStatus: vi.fn(),
  showGlobalToast: vi.fn(),
}));

vi.mock('$lib/platform', () => ({ isTauri: true }));
vi.mock('$lib/platform/tauri', () => ({
  onFileChange: mocks.onFileChange,
  vaultStatus: mocks.vaultStatus,
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

import enCatalog from '../../languages/en.json';
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
    mocks.vaultStatus.mockResolvedValue(vaultStatus());
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
    startNativeShell({ enqueueFileChange: vi.fn(), flushSave: vi.fn(async () => undefined) });
    await vi.waitFor(() => expect(mocks.onFileChange).toHaveBeenCalledOnce());

    // A watcher that failed to start looks exactly like a vault nobody is
    // editing, so the shell has to say so rather than only log it.
    const onStartFailed = mocks.onFileChange.mock.calls[0][1] as (message: string) => void;
    onStartFailed('inotify limit reached');

    await vi.waitFor(() =>
      expect(mocks.showGlobalToast).toHaveBeenCalledWith({ path: 'system.watcherUnavailable' }),
    );
  });

  it('lets the vault message win when the vault is why the watcher failed', async () => {
    mocks.vaultStatus.mockResolvedValue(vaultStatus({ available: false }));
    startNativeShell({ enqueueFileChange: vi.fn(), flushSave: vi.fn(async () => undefined) });
    await vi.waitFor(() => expect(mocks.onFileChange).toHaveBeenCalledOnce());

    // The decision is the typed vault status, not the failure message's prose —
    // Rust is free to reword its errors without changing which toast wins.
    const onStartFailed = mocks.onFileChange.mock.calls[0][1] as (message: string) => void;
    onStartFailed('anything the backend said');

    // One toast slot: the watcher failure is a symptom, and overwriting the message
    // that names the way out would leave the user with nothing actionable.
    await vi.waitFor(() =>
      expect(mocks.showGlobalToast).toHaveBeenCalledWith({
        path: 'system.notesFolderUnavailable',
        arguments: { folderPath: '/vault' },
      }),
    );
    expect(mocks.showGlobalToast).not.toHaveBeenCalledWith({
      path: 'system.watcherUnavailable',
    });
  });

  // The folder has to be NAMED: github#44's reporter read an unnamed failure as
  // a server fault and audited a healthy server before looking at his disk.
  it('names the unreachable notes folder and points at Settings', async () => {
    mocks.vaultStatus.mockResolvedValue(vaultStatus({ available: false }));
    startNativeShell({ enqueueFileChange: vi.fn(), flushSave: vi.fn(async () => undefined) });

    await vi.waitFor(() =>
      expect(mocks.showGlobalToast).toHaveBeenCalledWith({
        path: 'system.notesFolderUnavailable',
        arguments: { folderPath: '/vault' },
      }),
    );

    // The descriptor only carries the folder; the sentence has to spend it. Pin
    // the English catalog wording so a translation pass cannot quietly drop the
    // placeholder and take github#44's fix back out.
    expect(enCatalog.messages.system.notesFolderUnavailable).toBe(
      "Can't find your vault folder at {folderPath}. Please reconfigure in settings.",
    );
  });

  it('stays quiet about a reachable notes folder', async () => {
    startNativeShell({ enqueueFileChange: vi.fn(), flushSave: vi.fn(async () => undefined) });
    await vi.waitFor(() => expect(mocks.vaultStatus).toHaveBeenCalledOnce());

    expect(mocks.showGlobalToast).not.toHaveBeenCalled();
  });
});

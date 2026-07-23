// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeCleanup: vi.fn(),
  fileCleanup: vi.fn(),
  onCloseRequested: vi.fn(),
  onFileChange: vi.fn(),
}));

vi.mock('$lib/platform', () => ({ isTauri: true }));
vi.mock('$lib/platform/tauri', () => ({
  onFileChange: mocks.onFileChange,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: vi.fn(),
    onCloseRequested: mocks.onCloseRequested,
  }),
}));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: vi.fn() }));

import { startNativeShell } from './startNativeShell';

describe('startNativeShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onFileChange.mockReturnValue(mocks.fileCleanup);
    mocks.onCloseRequested.mockResolvedValue(mocks.closeCleanup);
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
});

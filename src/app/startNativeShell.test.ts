// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeCleanup: vi.fn(),
  fileCleanup: vi.fn(),
  menuCleanup: vi.fn(),
  onCloseRequested: vi.fn(),
  onFileChange: vi.fn(),
  onMenuAction: vi.fn(),
}));

vi.mock('$lib/platform', () => ({ isTauri: true }));
vi.mock('$lib/platform/tauri', () => ({
  onFileChange: mocks.onFileChange,
  onMenuAction: mocks.onMenuAction,
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
    mocks.onMenuAction.mockReturnValue(mocks.menuCleanup);
    mocks.onFileChange.mockReturnValue(mocks.fileCleanup);
    mocks.onCloseRequested.mockResolvedValue(mocks.closeCleanup);
  });

  it('disposes handlers that finish registering after teardown', async () => {
    const stop = startNativeShell({
      createNote: vi.fn(),
      enqueueFileChange: vi.fn(),
      flushSave: vi.fn(async () => undefined),
      toggleSidebar: vi.fn(),
    });

    stop();

    await vi.waitFor(() => {
      expect(mocks.onMenuAction).toHaveBeenCalledOnce();
      expect(mocks.onFileChange).toHaveBeenCalledOnce();
      expect(mocks.onCloseRequested).toHaveBeenCalledOnce();
    });
    expect(mocks.menuCleanup).toHaveBeenCalledOnce();
    expect(mocks.fileCleanup).toHaveBeenCalledOnce();
    expect(mocks.closeCleanup).toHaveBeenCalledOnce();
  });
});

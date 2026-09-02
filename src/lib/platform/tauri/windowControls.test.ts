import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriWindow = vi.hoisted(() => ({
  setTitle: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: tauriWindow.setTitle,
  }),
}));

import { applyAppWindowTitle } from './windowControls';

describe('applyAppWindowTitle', () => {
  beforeEach(() => {
    tauriWindow.setTitle.mockReset();
  });

  it('preserves the dev identity when the active note changes', async () => {
    await applyAppWindowTitle('Welcome');

    expect(tauriWindow.setTitle).toHaveBeenCalledWith('Welcome — FUTO Notes (Dev)');
  });
});

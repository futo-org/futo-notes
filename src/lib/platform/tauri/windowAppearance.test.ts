import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  theme: vi.fn(),
  onThemeChanged: vi.fn(),
  unlistenWindow: vi.fn(),
  unlistenPortal: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTheme: tauriMocks.setTheme,
    theme: tauriMocks.theme,
    onThemeChanged: tauriMocks.onThemeChanged,
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriMocks.listen }));

import { releaseNativeWindowAppearance, subscribeToNativeThemeChanges } from './windowAppearance';

describe('releaseNativeWindowAppearance', () => {
  it('hands the window back to the OS before reading its theme', async () => {
    tauriMocks.setTheme.mockResolvedValue(undefined);
    tauriMocks.theme.mockImplementation(async () =>
      tauriMocks.setTheme.mock.calls.length ? 'light' : 'dark',
    );

    await expect(releaseNativeWindowAppearance()).resolves.toBe('light');
    expect(tauriMocks.setTheme).toHaveBeenCalledWith(null);
  });
});

describe('subscribeToNativeThemeChanges', () => {
  beforeEach(() => {
    tauriMocks.onThemeChanged.mockResolvedValue(tauriMocks.unlistenWindow);
    tauriMocks.listen.mockResolvedValue(tauriMocks.unlistenPortal);
  });

  it('forwards both the window ThemeChanged and the Linux portal event, and stops both', async () => {
    const onChange = vi.fn();
    const stop = await subscribeToNativeThemeChanges(onChange);

    tauriMocks.onThemeChanged.mock.calls[0][0]({ payload: 'dark' });
    expect(tauriMocks.listen).toHaveBeenCalledWith('linux-theme-changed', expect.any(Function));
    tauriMocks.listen.mock.calls[0][1]({ payload: 'light' });
    expect(onChange.mock.calls).toEqual([['dark'], ['light']]);

    stop();
    expect(tauriMocks.unlistenWindow).toHaveBeenCalledOnce();
    expect(tauriMocks.unlistenPortal).toHaveBeenCalledOnce();
  });
});

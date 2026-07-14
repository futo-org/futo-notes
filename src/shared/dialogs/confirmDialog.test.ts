// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';

const askMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: askMock }));

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('$lib/platform');
});

describe('confirmDialog', () => {
  it('uses window.confirm outside Tauri and never touches plugin-dialog', async () => {
    vi.doMock('$lib/platform', () => ({ isTauri: false }));
    const { confirmDialog } = await import('./confirmDialog');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    await expect(confirmDialog('Delete?', { title: 'Delete' })).resolves.toBe(true);
    confirmSpy.mockReturnValue(false);
    await expect(confirmDialog('Delete?', { title: 'Delete' })).resolves.toBe(false);

    expect(confirmSpy).toHaveBeenCalledWith('Delete?');
    expect(askMock).not.toHaveBeenCalled();
  });

  it('uses plugin-dialog ask() under Tauri', async () => {
    vi.doMock('$lib/platform', () => ({ isTauri: true }));
    const { confirmDialog } = await import('./confirmDialog');
    askMock.mockResolvedValue(true);

    await expect(
      confirmDialog('Delete this folder?', { title: 'Delete folder', kind: 'warning' }),
    ).resolves.toBe(true);

    expect(askMock).toHaveBeenCalledWith('Delete this folder?', {
      title: 'Delete folder',
      kind: 'warning',
    });
  });
});

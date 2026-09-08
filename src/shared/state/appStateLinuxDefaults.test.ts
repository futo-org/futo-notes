// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  readAppData: vi.fn(async (path: string) =>
    path === '.app-state.json'
      ? JSON.stringify({
          deviceId: 'existing-device',
          preferences: { theme: 'dark', interfaceFont: 'system' },
        })
      : null,
  ),
  writeAppData: vi.fn(),
}));

vi.mock('$lib/platform', () => ({
  getPlatformFS: vi.fn(async () => ({
    readAppData: platform.readAppData,
    writeAppData: platform.writeAppData,
  })),
  hasFileSystem: true,
  isLinux: true,
  isTauri: true,
}));

import { loadPreferences } from './appState';

describe('Linux desktop appearance defaults', () => {
  it('drops the removed interface-font preference', async () => {
    expect((await loadPreferences()).appearance).toEqual({ theme: 'dark' });
  });
});

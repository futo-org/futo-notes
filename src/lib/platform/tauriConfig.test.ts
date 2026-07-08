import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/api/path', () => ({
  documentDir: vi.fn(() => Promise.resolve('/home/user/Documents')),
  appDataDir: vi.fn(() => Promise.resolve('/home/user/.local/share/com.futo.notes')),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
  isAbsolute: vi.fn((p: string) => Promise.resolve(p.startsWith('/'))),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(() => Promise.reject(new Error('not found'))),
  writeTextFile: vi.fn(() => Promise.resolve()),
  readFile: vi.fn(() => Promise.reject(new Error('not found'))),
  writeFile: vi.fn(() => Promise.resolve()),
  readDir: vi.fn(() => Promise.resolve([])),
  remove: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  exists: vi.fn(() => Promise.resolve(false)),
  stat: vi.fn(() => Promise.resolve({ mtime: new Date() })),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(() => Promise.resolve('0.0.0-test')),
}));

import { invoke } from '@tauri-apps/api/core';
import { getConfig, saveConfig, setNotesDir, loadOpenFoldersConfig } from './tauri';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper: configure mock invoke to handle the standard set of commands
 * used by getConfig/saveConfig/setNotesDir.
 */
function setupInvokeMock(overrides: Partial<Record<string, unknown>> = {}) {
  const defaults: Record<string, unknown> = {
    notes_dir_override_load: null,
    notes_dir_override_save: undefined,
    resolve_default_notes_root: '/home/user/Documents/futo-notes',
    appdata_read: null,
    appdata_write: undefined,
    ...overrides,
  };
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd in defaults) return defaults[cmd];
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

describe('getConfig', () => {
  it('returns default config when no override and no config file', async () => {
    setupInvokeMock();
    const cfg = await getConfig();
    expect(cfg.notesDir).toBe('/home/user/Documents/futo-notes');
    expect(cfg.isCustomDir).toBe(false);
    expect(cfg.defaultNotesDir).toBe('/home/user/Documents/futo-notes');
    expect(cfg.sidebarWidth).toBeUndefined();
    expect(cfg.graphSidebarWidth).toBeUndefined();
  });

  it('returns custom dir when override is set', async () => {
    setupInvokeMock({ notes_dir_override_load: '/custom/notes' });
    const cfg = await getConfig();
    expect(cfg.notesDir).toBe('/custom/notes');
    expect(cfg.isCustomDir).toBe(true);
    expect(cfg.defaultNotesDir).toBe('/home/user/Documents/futo-notes');
  });

  it('reads sidebar widths from config file', async () => {
    setupInvokeMock();
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(true);
    vi.mocked(readTextFile).mockResolvedValueOnce(
      JSON.stringify({ sidebarWidth: 300, graphSidebarWidth: 400 }),
    );
    const cfg = await getConfig();
    expect(cfg.sidebarWidth).toBe(300);
    expect(cfg.graphSidebarWidth).toBe(400);
  });

  it('degrades to defaults when the config read is denied (macOS EPERM)', async () => {
    setupInvokeMock();
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(true);
    // macOS TCC/permission denial opening .app-config.json.
    vi.mocked(readTextFile).mockRejectedValueOnce(
      new Error('Operation not permitted (os error 1)'),
    );
    const cfg = await getConfig();
    expect(cfg.notesDir).toBe('/home/user/Documents/futo-notes');
    expect(cfg.sidebarWidth).toBeUndefined();
  });

  it('handles invalid JSON in config file gracefully', async () => {
    setupInvokeMock();
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(true);
    vi.mocked(readTextFile).mockResolvedValueOnce('not valid json{');
    const cfg = await getConfig();
    expect(cfg.sidebarWidth).toBeUndefined();
    expect(cfg.graphSidebarWidth).toBeUndefined();
  });
});

describe('saveConfig', () => {
  it('merges sidebarWidth into existing config', async () => {
    setupInvokeMock();
    // Mock plugin-fs readTextFile to return existing config
    const { readTextFile, writeTextFile, rename, exists } = await import('@tauri-apps/plugin-fs');
    const mockReadTextFile = vi.mocked(readTextFile);
    const mockWriteTextFile = vi.mocked(writeTextFile);
    const mockRename = vi.mocked(rename);
    vi.mocked(exists).mockResolvedValueOnce(true);
    mockReadTextFile.mockResolvedValueOnce(
      JSON.stringify({ sidebarWidth: 280, graphSidebarWidth: 320 }),
    );

    await saveConfig({ sidebarWidth: 350 });
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    // Atomic write: writes to temp then renames
    const writtenContent = mockWriteTextFile.mock.calls[0][1] as string;
    const written = JSON.parse(writtenContent);
    expect(written.sidebarWidth).toBe(350);
    expect(written.graphSidebarWidth).toBe(320);
    expect(mockRename).toHaveBeenCalledTimes(1);
  });

  it('can set a width to null', async () => {
    setupInvokeMock();
    const { readTextFile, writeTextFile, exists } = await import('@tauri-apps/plugin-fs');
    const mockReadTextFile = vi.mocked(readTextFile);
    const mockWriteTextFile = vi.mocked(writeTextFile);
    vi.mocked(exists).mockResolvedValueOnce(true);
    mockReadTextFile.mockResolvedValueOnce(JSON.stringify({ sidebarWidth: 280 }));

    await saveConfig({ sidebarWidth: null });
    const writtenContent = mockWriteTextFile.mock.calls[0][1] as string;
    const written = JSON.parse(writtenContent);
    expect(written.sidebarWidth).toBeNull();
  });

  it('persists openFolders alongside other config fields', async () => {
    setupInvokeMock();
    const { readTextFile, writeTextFile, exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(true);
    vi.mocked(readTextFile).mockResolvedValueOnce(JSON.stringify({ sidebarWidth: 280 }));

    await saveConfig({ openFolders: ['Projects', 'Projects/2026'] });
    const writtenContent = vi.mocked(writeTextFile).mock.calls[0][1] as string;
    const written = JSON.parse(writtenContent);
    expect(written.openFolders).toEqual(['Projects', 'Projects/2026']);
    // Doesn't clobber existing fields
    expect(written.sidebarWidth).toBe(280);
  });

  it('does not write a partial config when the existing config read is denied', async () => {
    setupInvokeMock();
    const { readTextFile, writeTextFile, rename, exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(true);
    vi.mocked(readTextFile).mockRejectedValueOnce(
      new Error('Operation not permitted (os error 1)'),
    );

    await expect(saveConfig({ sidebarWidth: 360 })).rejects.toThrow('Operation not permitted');
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('loadOpenFoldersConfig', () => {
  it('returns null when the config file has no openFolders entry', async () => {
    setupInvokeMock();
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(true);
    vi.mocked(readTextFile).mockResolvedValueOnce(JSON.stringify({ sidebarWidth: 300 }));

    expect(await loadOpenFoldersConfig()).toBeNull();
  });

  it('returns null when the config file is missing', async () => {
    setupInvokeMock();
    const { exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(false);

    expect(await loadOpenFoldersConfig()).toBeNull();
  });

  it('returns the persisted folder paths and filters non-strings', async () => {
    setupInvokeMock();
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(true);
    // Simulate a file containing junk values to make sure we don't
    // hand them back to callers as-is.
    vi.mocked(readTextFile).mockResolvedValueOnce(
      JSON.stringify({ openFolders: ['Projects', 42, 'Projects/2026', null] }),
    );

    expect(await loadOpenFoldersConfig()).toEqual(['Projects', 'Projects/2026']);
  });

  it('returns an empty array when openFolders was persisted as []', async () => {
    setupInvokeMock();
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    vi.mocked(exists).mockResolvedValueOnce(true);
    vi.mocked(readTextFile).mockResolvedValueOnce(JSON.stringify({ openFolders: [] }));

    expect(await loadOpenFoldersConfig()).toEqual([]);
  });
});

describe('setNotesDir', () => {
  it('saves override for absolute path', async () => {
    const overrideSaves: unknown[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'notes_dir_override_save') {
        overrideSaves.push(args);
        return undefined;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await setNotesDir('/new/notes/dir');
    expect(overrideSaves).toEqual([{ dir: '/new/notes/dir' }]);
  });

  it('clears override when dir is null', async () => {
    const overrideSaves: unknown[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'notes_dir_override_save') {
        overrideSaves.push(args);
        return undefined;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await setNotesDir(null);
    expect(overrideSaves).toEqual([{ dir: null }]);
  });

  it('rejects relative paths', async () => {
    await expect(setNotesDir('relative/path')).rejects.toThrow('path must be absolute');
  });
});

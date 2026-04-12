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

import { invoke } from '@tauri-apps/api/core';
import { getConfig, saveConfig, setNotesDir } from './tauri';

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
    fs_ensure_dir: undefined,
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
    expect(cfg.notesDir).toBe('/home/user/Documents/stonefruit');
    expect(cfg.isCustomDir).toBe(false);
    expect(cfg.defaultNotesDir).toBe('/home/user/Documents/stonefruit');
    expect(cfg.sidebarWidth).toBeUndefined();
    expect(cfg.graphSidebarWidth).toBeUndefined();
  });

  it('returns custom dir when override is set', async () => {
    setupInvokeMock({ notes_dir_override_load: '/custom/notes' });
    const cfg = await getConfig();
    expect(cfg.notesDir).toBe('/custom/notes');
    expect(cfg.isCustomDir).toBe(true);
    expect(cfg.defaultNotesDir).toBe('/home/user/Documents/stonefruit');
  });

  it('reads sidebar widths from config file', async () => {
    setupInvokeMock({
      appdata_read: JSON.stringify({ sidebarWidth: 300, graphSidebarWidth: 400 }),
    });
    const cfg = await getConfig();
    expect(cfg.sidebarWidth).toBe(300);
    expect(cfg.graphSidebarWidth).toBe(400);
  });

  it('handles invalid JSON in config file gracefully', async () => {
    setupInvokeMock({ appdata_read: 'not valid json{' });
    const cfg = await getConfig();
    expect(cfg.sidebarWidth).toBeUndefined();
    expect(cfg.graphSidebarWidth).toBeUndefined();
  });
});

describe('saveConfig', () => {
  it('merges sidebarWidth into existing config', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'notes_dir_override_load') return null;
      if (cmd === 'fs_ensure_dir') return undefined;
      if (cmd === 'appdata_read')
        return JSON.stringify({ sidebarWidth: 280, graphSidebarWidth: 320 });
      if (cmd === 'appdata_write') {
        const a = args as { relPath: string; content: string };
        writes.push({ path: a.relPath, content: a.content });
        return undefined;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await saveConfig({ sidebarWidth: 350 });
    expect(writes).toHaveLength(1);
    const written = JSON.parse(writes[0].content);
    expect(written.sidebarWidth).toBe(350);
    expect(written.graphSidebarWidth).toBe(320);
  });

  it('can set a width to null', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'notes_dir_override_load') return null;
      if (cmd === 'fs_ensure_dir') return undefined;
      if (cmd === 'appdata_read') return JSON.stringify({ sidebarWidth: 280 });
      if (cmd === 'appdata_write') {
        const a = args as { relPath: string; content: string };
        writes.push({ path: a.relPath, content: a.content });
        return undefined;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await saveConfig({ sidebarWidth: null });
    const written = JSON.parse(writes[0].content);
    expect(written.sidebarWidth).toBeNull();
  });
});

describe('setNotesDir', () => {
  it('saves override for absolute path', async () => {
    const overrideSaves: unknown[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'fs_ensure_dir') return undefined;
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

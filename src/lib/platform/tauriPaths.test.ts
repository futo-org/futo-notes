import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri APIs before importing the module under test
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { getNotesRoot, getDefaultNotesRoot, loadNotesDirOverride, saveNotesDirOverride, ensureDir } from './tauriPaths';
import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadNotesDirOverride', () => {
  it('returns override path when set', async () => {
    mockInvoke.mockResolvedValueOnce('/custom/notes');
    const result = await loadNotesDirOverride();
    expect(result).toBe('/custom/notes');
    expect(mockInvoke).toHaveBeenCalledWith('notes_dir_override_load');
  });

  it('returns null when no override', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const result = await loadNotesDirOverride();
    expect(result).toBeNull();
  });
});

describe('saveNotesDirOverride', () => {
  it('saves a custom directory', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveNotesDirOverride('/custom/notes');
    expect(mockInvoke).toHaveBeenCalledWith('notes_dir_override_save', { dir: '/custom/notes' });
  });

  it('clears override by passing null', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveNotesDirOverride(null);
    expect(mockInvoke).toHaveBeenCalledWith('notes_dir_override_save', { dir: null });
  });
});

describe('getDefaultNotesRoot', () => {
  it('delegates to Rust (honors STONEFRUIT_DATA_DIR)', async () => {
    mockInvoke.mockResolvedValueOnce('/tmp/wt-test-data/notes');
    const result = await getDefaultNotesRoot();
    expect(result).toBe('/tmp/wt-test-data/notes');
    expect(mockInvoke).toHaveBeenCalledWith('resolve_default_notes_root');
  });

  it('returns the Documents/stonefruit path in production', async () => {
    mockInvoke.mockResolvedValueOnce('/home/user/Documents/stonefruit');
    const result = await getDefaultNotesRoot();
    expect(result).toBe('/home/user/Documents/stonefruit');
  });
});

describe('getNotesRoot', () => {
  it('returns override dir when set', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'notes_dir_override_load') return '/custom/notes';
      if (cmd === 'fs_ensure_dir') return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    const result = await getNotesRoot();
    expect(result).toBe('/custom/notes');
    expect(mockInvoke).toHaveBeenCalledWith('fs_ensure_dir', { path: '/custom/notes' });
  });

  it('returns Rust-resolved default dir when no override', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'notes_dir_override_load') return null;
      if (cmd === 'resolve_default_notes_root') return '/home/user/Documents/stonefruit';
      if (cmd === 'fs_ensure_dir') return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    const result = await getNotesRoot();
    expect(result).toBe('/home/user/Documents/stonefruit');
    expect(mockInvoke).toHaveBeenCalledWith('fs_ensure_dir', {
      path: '/home/user/Documents/stonefruit',
    });
  });

  it('honors env-derived root from Rust (e.g. STONEFRUIT_DATA_DIR for dev/test isolation)', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'notes_dir_override_load') return null;
      if (cmd === 'resolve_default_notes_root') return '/tmp/wt-abc/data/notes';
      if (cmd === 'fs_ensure_dir') return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    const result = await getNotesRoot();
    expect(result).toBe('/tmp/wt-abc/data/notes');
  });
});

describe('ensureDir', () => {
  it('invokes fs_ensure_dir', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await ensureDir('/some/path');
    expect(mockInvoke).toHaveBeenCalledWith('fs_ensure_dir', { path: '/some/path' });
  });
});

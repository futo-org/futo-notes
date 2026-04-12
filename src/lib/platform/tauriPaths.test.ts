import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri APIs before importing the module under test
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  documentDir: vi.fn(),
  appDataDir: vi.fn(),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
}));

import { getNotesRoot, getDefaultNotesRoot, loadNotesDirOverride, saveNotesDirOverride, ensureDir } from './tauriPaths';
import { invoke } from '@tauri-apps/api/core';
import { documentDir, appDataDir } from '@tauri-apps/api/path';

const mockInvoke = vi.mocked(invoke);
const mockDocumentDir = vi.mocked(documentDir);
const mockAppDataDir = vi.mocked(appDataDir);

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
  it('uses documentDir when available', async () => {
    mockDocumentDir.mockResolvedValueOnce('/home/user/Documents');
    const result = await getDefaultNotesRoot();
    expect(result).toBe('/home/user/Documents/stonefruit');
  });

  it('falls back to appDataDir when documentDir fails', async () => {
    mockDocumentDir.mockRejectedValueOnce(new Error('not available'));
    mockAppDataDir.mockResolvedValueOnce('/home/user/.local/share/com.futo.notes');
    const result = await getDefaultNotesRoot();
    expect(result).toBe('/home/user/.local/share/com.futo.notes/stonefruit');
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

  it('returns default dir when no override', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'notes_dir_override_load') return null;
      if (cmd === 'fs_ensure_dir') return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    mockDocumentDir.mockResolvedValueOnce('/home/user/Documents');
    const result = await getNotesRoot();
    expect(result).toBe('/home/user/Documents/stonefruit');
    expect(mockInvoke).toHaveBeenCalledWith('fs_ensure_dir', {
      path: '/home/user/Documents/stonefruit',
    });
  });
});

describe('ensureDir', () => {
  it('invokes fs_ensure_dir', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await ensureDir('/some/path');
    expect(mockInvoke).toHaveBeenCalledWith('fs_ensure_dir', { path: '/some/path' });
  });
});

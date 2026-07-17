import { readFileSync } from 'node:fs';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: vi.fn(),
}));

import {
  resolveNotesRoot,
  resolveDefaultNotesRoot,
  loadNotesDirOverride,
  saveNotesDirOverride,
  ensureDirectory,
} from './notesRoot';
import { invoke } from '@tauri-apps/api/core';
import { mkdir } from '@tauri-apps/plugin-fs';

const mockInvoke = vi.mocked(invoke);
const mockMkdir = vi.mocked(mkdir);

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

describe('resolveDefaultNotesRoot', () => {
  it('delegates to Rust (honors FUTO_NOTES_DATA_DIR)', async () => {
    mockInvoke.mockResolvedValueOnce('/tmp/wt-test-data/notes');
    const result = await resolveDefaultNotesRoot();
    expect(result).toBe('/tmp/wt-test-data/notes');
    expect(mockInvoke).toHaveBeenCalledWith('resolve_default_notes_root');
  });

  it('returns the Documents/futo-notes path in production', async () => {
    mockInvoke.mockResolvedValueOnce('/home/user/Documents/futo-notes');
    const result = await resolveDefaultNotesRoot();
    expect(result).toBe('/home/user/Documents/futo-notes');
  });

  it('keeps environment isolation and the debug/production split Rust-owned', () => {
    const rustSource = readFileSync(
      new URL('../../../../apps/tauri/src-tauri/src/vault_location.rs', import.meta.url),
      'utf8',
    );

    expect(rustSource).toMatch(
      /if let Some\(data_dir\) = environment_data_dir\(\) \{\s*return Ok\(data_dir\.join\("notes"\)\);/,
    );
    expect(rustSource).toMatch(
      /#\[cfg\(debug_assertions\)\]\s*return Ok\(documents\.join\("fake-notes"\)\);/,
    );
    expect(rustSource).toMatch(
      /#\[cfg\(not\(debug_assertions\)\)\]\s*Ok\(documents\.join\("futo-notes"\)\)/,
    );
  });
});

describe('resolveNotesRoot', () => {
  it('returns override dir when set and creates it', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'notes_dir_override_load') return '/custom/notes';
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    mockMkdir.mockResolvedValueOnce(undefined);
    const result = await resolveNotesRoot();
    expect(result).toBe('/custom/notes');
    expect(mockMkdir).toHaveBeenCalledWith('/custom/notes', { recursive: true });
  });

  it('returns Rust-resolved default dir when no override and creates it', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'notes_dir_override_load') return null;
      if (cmd === 'resolve_default_notes_root') return '/home/user/Documents/futo-notes';
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    mockMkdir.mockResolvedValueOnce(undefined);
    const result = await resolveNotesRoot();
    expect(result).toBe('/home/user/Documents/futo-notes');
    expect(mockMkdir).toHaveBeenCalledWith('/home/user/Documents/futo-notes', { recursive: true });
  });

  it('honors env-derived root from Rust (e.g. FUTO_NOTES_DATA_DIR for dev/test isolation)', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'notes_dir_override_load') return null;
      if (cmd === 'resolve_default_notes_root') return '/tmp/wt-abc/data/notes';
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    mockMkdir.mockResolvedValueOnce(undefined);
    const result = await resolveNotesRoot();
    expect(result).toBe('/tmp/wt-abc/data/notes');
  });
});

describe('ensureDirectory', () => {
  it('invokes plugin-fs mkdir recursively', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    await ensureDirectory('/some/path');
    expect(mockMkdir).toHaveBeenCalledWith('/some/path', { recursive: true });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyLocalMutation: vi.fn(),
  createFolder: vi.fn(),
  moveFolder: vi.fn(),
  rebaseOpenFolders: vi.fn(),
  renameFolder: vi.fn(),
}));

vi.mock('$lib/localNoteStore', () => ({
  getLocalNoteStore: vi.fn(async () => ({
    createFolder: mocks.createFolder,
    moveFolder: mocks.moveFolder,
    renameFolder: mocks.renameFolder,
  })),
}));
vi.mock('$features/notes/notes.svelte', () => ({
  _applyLocalMutation: mocks.applyLocalMutation,
}));
vi.mock('./folderExpansion.svelte', () => ({
  openFolderAndAncestors: vi.fn(),
  rebaseOpenFolders: mocks.rebaseOpenFolders,
  removeOpenFolderTree: vi.fn(),
}));

import {
  createFolder,
  moveFolder,
  renameFolderInPlace,
  renameOrMoveFolder,
} from './folderOperations';

describe('renameOrMoveFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns and applies the complete domain rename map from one store workflow', async () => {
    const mutation = {
      removed: ['Projects/Roadmap'],
      upserted: [],
      renamed: [{ from: 'Projects/Roadmap', to: 'Archive/Roadmap' }],
      folders: ['Archive'],
      finalId: null,
      finalFolder: 'Archive',
      warnings: [],
    };
    mocks.renameFolder.mockResolvedValue(mutation);

    const result = await renameOrMoveFolder('Projects', 'Archive', []);

    expect(mocks.renameFolder).toHaveBeenCalledOnce();
    expect(mocks.renameFolder).toHaveBeenCalledWith('Projects', 'Archive');
    expect(mocks.applyLocalMutation).toHaveBeenCalledWith(mutation);
    expect(result).toEqual({
      ok: true,
      renames: mutation.renamed,
      finalFolder: 'Archive',
    });
  });
});

describe('moveFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies and rebases to the collision-resolved folder returned by the store', async () => {
    const mutation = {
      removed: ['Work/Note'],
      upserted: [],
      renamed: [{ from: 'Work/Note', to: 'Archive/Work-2/Note' }],
      folders: ['Archive', 'Archive/Work', 'Archive/Work-2'],
      finalId: null,
      finalFolder: 'Archive/Work-2',
      warnings: [],
    };
    mocks.moveFolder.mockResolvedValue(mutation);

    const result = await moveFolder('Work', 'Archive');

    expect(mocks.moveFolder).toHaveBeenCalledWith('Work', 'Archive');
    expect(mocks.applyLocalMutation).toHaveBeenCalledWith(mutation);
    expect(mocks.rebaseOpenFolders).toHaveBeenCalledWith('Work', 'Archive/Work-2');
    expect(result.finalFolder).toBe('Archive/Work-2');
  });
});

describe('renameFolderInPlace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: the inline rename used to splice the typed text straight into
  // the destination PATH, so "a/b" quietly MOVED the folder into a brand-new
  // "a" — both components being individually legal — instead of reporting the
  // separator as an illegal character in a name.
  it('rejects a path separator in the new name instead of nesting the folder', async () => {
    const result = await renameFolderInPlace('Work', 'a/b', []);

    expect(result).toEqual({
      ok: false,
      error: { path: 'folders.validation.forbiddenCharacter' },
    });
    expect(mocks.renameFolder).not.toHaveBeenCalled();
  });

  // Same root cause: an empty name collapsed the destination path to the
  // parent, so the store was asked to rename the folder onto its own parent.
  it('rejects an empty name instead of renaming the folder onto its parent', async () => {
    const result = await renameFolderInPlace('Projects/Work', '   ', []);

    expect(result).toEqual({ ok: false, error: { path: 'folders.validation.empty' } });
    expect(mocks.renameFolder).not.toHaveBeenCalled();
  });

  it('reports a forbidden character against a folder, not a note title', async () => {
    await expect(renameFolderInPlace('Work', 'a:b', [])).resolves.toEqual({
      ok: false,
      error: { path: 'folders.validation.forbiddenCharacter' },
    });
  });

  it('rejects a case-insensitive sibling collision', async () => {
    await expect(renameFolderInPlace('Work', 'archive', ['Archive'])).resolves.toEqual({
      ok: false,
      error: { path: 'folders.duplicateName' },
    });
    expect(mocks.renameFolder).not.toHaveBeenCalled();
  });

  it('is a no-op when the name is unchanged', async () => {
    await expect(renameFolderInPlace('Projects/Work', 'Work', [])).resolves.toEqual({ ok: true });
    expect(mocks.renameFolder).not.toHaveBeenCalled();
  });

  it('renames within the current parent when the name is legal', async () => {
    const mutation = {
      removed: [],
      upserted: [],
      renamed: [{ from: 'Projects/Work/Note', to: 'Projects/Archive/Note' }],
      folders: ['Projects', 'Projects/Archive'],
      finalId: null,
      finalFolder: 'Projects/Archive',
      warnings: [],
    };
    mocks.renameFolder.mockResolvedValue(mutation);

    const result = await renameFolderInPlace('Projects/Work', ' Archive ', []);

    expect(mocks.renameFolder).toHaveBeenCalledWith('Projects/Work', 'Projects/Archive');
    expect(result.ok).toBe(true);
    expect(result.finalFolder).toBe('Projects/Archive');
  });
});

describe('createFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies the committed folder projection', async () => {
    const mutation = {
      removed: [],
      upserted: [],
      renamed: [],
      folders: ['Projects'],
      finalId: null,
      finalFolder: null,
      warnings: [],
    };
    mocks.createFolder.mockResolvedValue(mutation);

    await expect(createFolder('', 'Projects', [])).resolves.toEqual({
      ok: true,
      path: 'Projects',
    });
    expect(mocks.applyLocalMutation).toHaveBeenCalledWith(mutation);
  });
});

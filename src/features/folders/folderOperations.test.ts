import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyLocalMutation: vi.fn(),
  createFolder: vi.fn(),
  rebaseOpenFolders: vi.fn(),
  renameFolder: vi.fn(),
}));

vi.mock('$lib/localNoteStore', () => ({
  getLocalNoteStore: vi.fn(async () => ({
    createFolder: mocks.createFolder,
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

import { createFolder, renameOrMoveFolder } from './folderOperations';

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
      warnings: [],
    };
    mocks.renameFolder.mockResolvedValue(mutation);

    const result = await renameOrMoveFolder('Projects', 'Archive', []);

    expect(mocks.renameFolder).toHaveBeenCalledOnce();
    expect(mocks.renameFolder).toHaveBeenCalledWith('Projects', 'Archive');
    expect(mocks.applyLocalMutation).toHaveBeenCalledWith(mutation);
    expect(result).toEqual({ ok: true, renames: mutation.renamed });
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

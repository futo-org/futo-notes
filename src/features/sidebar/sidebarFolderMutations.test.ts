import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  deleteNote: vi.fn(),
  moveNote: vi.fn(),
  renameFolderInPlace: vi.fn(),
  showGlobalToast: vi.fn(),
  getAllNotes: vi.fn(() => []),
  getNoteById: vi.fn(),
  getSaveIdentityChange: vi.fn(),
}));

vi.mock('$features/folders/folderExpansion.svelte', () => ({
  clearDragHoverExpanded: vi.fn(),
}));
vi.mock('$features/folders/emptyFolders.svelte', () => ({
  getEmptyFolders: vi.fn(() => []),
}));
vi.mock('$features/folders/folderOperations', () => ({
  deleteFolder: vi.fn(),
  renameFolderInPlace: mocks.renameFolderInPlace,
}));
vi.mock('$features/notes/notes.svelte', () => ({
  deleteNote: mocks.deleteNote,
  getAllNotes: mocks.getAllNotes,
  getNoteById: mocks.getNoteById,
  getSaveIdentityChange: mocks.getSaveIdentityChange,
  moveNote: mocks.moveNote,
}));
vi.mock('$shared/dialogs/confirmDialog', () => ({
  confirmDialog: mocks.confirmDialog,
}));
vi.mock('$shared/notifications/toastBus.svelte', () => ({
  showGlobalToast: mocks.showGlobalToast,
}));

import {
  confirmDeleteSidebarNote,
  moveSidebarNote,
  renameSidebarFolder,
  renameSidebarNote,
} from './sidebarFolderMutations';

describe('confirmDeleteSidebarNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.getNoteById.mockImplementation((id: string) => ({ id }));
    mocks.getSaveIdentityChange.mockReturnValue(null);
  });

  it('closes the live session when the deleted sidebar row is the active note', async () => {
    const onActiveNoteDeleted = vi.fn();

    await confirmDeleteSidebarNote('Projects/Roadmap', {
      getActiveNoteId: () => 'Projects/Roadmap',
      runWithActiveNoteLock: (operation) => operation(),
      onNoteIdsRenamed: vi.fn(),
      onNoteIdsDeleted: vi.fn(),
      onSelect: vi.fn(),
      onActiveNoteDeleted,
      onActiveNoteMoved: vi.fn(),
    });

    expect(mocks.deleteNote).toHaveBeenCalledWith('Projects/Roadmap');
    expect(onActiveNoteDeleted).toHaveBeenCalledOnce();
    expect(mocks.deleteNote.mock.invocationCallOrder[0]).toBeLessThan(
      onActiveNoteDeleted.mock.invocationCallOrder[0],
    );
    expect(mocks.showGlobalToast).toHaveBeenCalledWith('Note deleted');
  });

  it('does not disturb the live session when deleting a background note', async () => {
    const onActiveNoteDeleted = vi.fn();
    const onNoteIdsDeleted = vi.fn();

    await confirmDeleteSidebarNote('Archive/Old', {
      getActiveNoteId: () => 'Projects/Roadmap',
      runWithActiveNoteLock: (operation) => operation(),
      onNoteIdsRenamed: vi.fn(),
      onNoteIdsDeleted,
      onSelect: vi.fn(),
      onActiveNoteDeleted,
      onActiveNoteMoved: vi.fn(),
    });

    expect(onActiveNoteDeleted).not.toHaveBeenCalled();
    expect(onNoteIdsDeleted).toHaveBeenCalledWith(['Archive/Old']);
  });

  it('flushes and retargets the live session from the post-save id after an active note move', async () => {
    let activeId = 'Projects/Roadmap';
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => {
      activeId = 'Projects/Renamed roadmap';
      mocks.getSaveIdentityChange.mockReturnValue({
        from: 'Projects/Roadmap',
        to: 'Projects/Renamed roadmap',
      });
      return operation();
    });
    mocks.getNoteById.mockImplementation((id: string) =>
      id === 'Projects/Renamed roadmap' ? { id } : undefined,
    );
    mocks.moveNote.mockResolvedValue({ id: 'Archive/Renamed roadmap-2', mtime: 1 });
    const onActiveNoteMoved = vi.fn();
    const onNoteIdsRenamed = vi.fn();

    await moveSidebarNote('Projects/Roadmap', 'Archive', {
      getActiveNoteId: () => activeId,
      runWithActiveNoteLock,
      onNoteIdsRenamed,
      onNoteIdsDeleted: vi.fn(),
      onSelect: vi.fn(),
      onActiveNoteDeleted: vi.fn(),
      onActiveNoteMoved,
    });

    expect(mocks.moveNote).toHaveBeenCalledWith(
      'Projects/Renamed roadmap',
      'Archive/Renamed roadmap',
    );
    expect(runWithActiveNoteLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.moveNote.mock.invocationCallOrder[0],
    );
    expect(onActiveNoteMoved).toHaveBeenCalledWith(
      'Projects/Renamed roadmap',
      'Archive/Renamed roadmap-2',
      'Renamed roadmap-2',
    );
    expect(onNoteIdsRenamed).toHaveBeenCalledWith([
      { from: 'Projects/Renamed roadmap', to: 'Archive/Renamed roadmap-2' },
    ]);
  });

  it('flushes an active note before renaming its containing folder', async () => {
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    mocks.renameFolderInPlace.mockResolvedValue({
      ok: true,
      renames: [{ from: 'Projects/Roadmap', to: 'Work/Roadmap' }],
    });

    await renameSidebarFolder('Projects', 'Work', {
      getActiveNoteId: () => 'Projects/Roadmap',
      runWithActiveNoteLock,
      onNoteIdsRenamed: vi.fn(),
      onNoteIdsDeleted: vi.fn(),
      onSelect: vi.fn(),
      onActiveNoteDeleted: vi.fn(),
      onActiveNoteMoved: vi.fn(),
    });

    expect(runWithActiveNoteLock).toHaveBeenCalledOnce();
    expect(runWithActiveNoteLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.renameFolderInPlace.mock.invocationCallOrder[0],
    );
  });

  it('publishes a background note rename so open and recently closed tabs can retarget', async () => {
    mocks.moveNote.mockResolvedValue({ id: 'Archive/Old-2', mtime: 1 });
    const onNoteIdsRenamed = vi.fn();

    await moveSidebarNote('Projects/Old', 'Archive', {
      getActiveNoteId: () => 'Projects/Roadmap',
      runWithActiveNoteLock: (operation) => operation(),
      onNoteIdsRenamed,
      onNoteIdsDeleted: vi.fn(),
      onSelect: vi.fn(),
      onActiveNoteDeleted: vi.fn(),
      onActiveNoteMoved: vi.fn(),
    });

    expect(onNoteIdsRenamed).toHaveBeenCalledWith([{ from: 'Projects/Old', to: 'Archive/Old-2' }]);
  });
});

describe('sidebar note targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.getNoteById.mockImplementation((id: string) => ({ id }));
    mocks.getSaveIdentityChange.mockReturnValue(null);
  });

  it('deletes the id the flush renamed the active note to', async () => {
    let activeId = 'Projects/Roadmap';
    mocks.getNoteById.mockImplementation((id: string) =>
      id === 'Projects/Renamed roadmap' ? { id } : undefined,
    );

    await confirmDeleteSidebarNote('Projects/Roadmap', {
      getActiveNoteId: () => activeId,
      runWithActiveNoteLock: async <T>(operation: () => Promise<T>) => {
        activeId = 'Projects/Renamed roadmap';
        mocks.getSaveIdentityChange.mockReturnValue({
          from: 'Projects/Roadmap',
          to: 'Projects/Renamed roadmap',
        });
        return operation();
      },
      onNoteIdsRenamed: vi.fn(),
      onNoteIdsDeleted: vi.fn(),
      onSelect: vi.fn(),
      onActiveNoteDeleted: vi.fn(),
      onActiveNoteMoved: vi.fn(),
    });

    expect(mocks.deleteNote).toHaveBeenCalledExactlyOnceWith('Projects/Renamed roadmap');
  });

  it('deletes nothing when the picked note vanished without the flush renaming it', async () => {
    let activeId = 'Projects/Roadmap';
    mocks.getNoteById.mockImplementation((id: string) =>
      id === 'Archive/Old' ? { id } : undefined,
    );
    const onNoteIdsDeleted = vi.fn();

    await confirmDeleteSidebarNote('Projects/Roadmap', {
      getActiveNoteId: () => activeId,
      runWithActiveNoteLock: async <T>(operation: () => Promise<T>) => {
        activeId = 'Archive/Old';
        return operation();
      },
      onNoteIdsRenamed: vi.fn(),
      onNoteIdsDeleted,
      onSelect: vi.fn(),
      onActiveNoteDeleted: vi.fn(),
      onActiveNoteMoved: vi.fn(),
    });

    expect(mocks.deleteNote).not.toHaveBeenCalled();
    expect(onNoteIdsDeleted).not.toHaveBeenCalled();
    expect(mocks.showGlobalToast).toHaveBeenCalledWith('That note is no longer available');
  });
});

describe('renameSidebarNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNoteById.mockImplementation((id: string) => ({ id }));
    mocks.getSaveIdentityChange.mockReturnValue(null);
  });

  function options(overrides: Record<string, unknown> = {}) {
    return {
      getActiveNoteId: () => null,
      runWithActiveNoteLock: <T>(operation: () => Promise<T>) => operation(),
      onNoteIdsRenamed: vi.fn(),
      onNoteIdsDeleted: vi.fn(),
      onSelect: vi.fn(),
      onActiveNoteDeleted: vi.fn(),
      onActiveNoteMoved: vi.fn(),
      ...overrides,
    } as Parameters<typeof renameSidebarNote>[2];
  }

  it('renames the file to the typed name verbatim — the filename IS the title', async () => {
    mocks.moveNote.mockResolvedValue({ id: 'Projects/grocery list', mtime: 1 });
    const onNoteIdsRenamed = vi.fn();

    const error = await renameSidebarNote(
      'Projects/Roadmap',
      '  grocery list  ',
      options({ onNoteIdsRenamed }),
    );

    // Only surrounding whitespace goes; no case, dash, or word "improvement".
    expect(mocks.moveNote).toHaveBeenCalledWith('Projects/Roadmap', 'Projects/grocery list');
    expect(error).toBeNull();
    expect(onNoteIdsRenamed).toHaveBeenCalledWith([
      { from: 'Projects/Roadmap', to: 'Projects/grocery list' },
    ]);
  });

  it('reports a forbidden character instead of sanitizing it away', async () => {
    await expect(renameSidebarNote('Roadmap', 'a:b', options())).resolves.toBe(
      "That character can't be used in a note title",
    );
    expect(mocks.moveNote).not.toHaveBeenCalled();
  });

  it('rejects a path separator rather than moving the note into a new folder', async () => {
    await expect(renameSidebarNote('Roadmap', 'a/b', options())).resolves.toBe(
      "That character can't be used in a note title",
    );
    expect(mocks.moveNote).not.toHaveBeenCalled();
  });

  it('rejects an empty name and leaves the note alone', async () => {
    await expect(renameSidebarNote('Roadmap', '   ', options())).resolves.toBe(
      'Title cannot be empty',
    );
    expect(mocks.moveNote).not.toHaveBeenCalled();
  });

  it('blocks a case-insensitive duplicate in the same folder', async () => {
    mocks.getAllNotes.mockReturnValue([{ id: 'Projects/Roadmap' }, { id: 'Projects/Notes' }]);

    await expect(renameSidebarNote('Projects/Roadmap', 'notes', options())).resolves.toBe(
      'A note with this name already exists',
    );
    expect(mocks.moveNote).not.toHaveBeenCalled();
  });

  it('is a no-op when the name is unchanged', async () => {
    await expect(renameSidebarNote('Projects/Roadmap', 'Roadmap', options())).resolves.toBeNull();
    expect(mocks.moveNote).not.toHaveBeenCalled();
  });

  it('flushes the live session first and retargets it to the committed id', async () => {
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    mocks.moveNote.mockResolvedValue({ id: 'Projects/Plan-2', mtime: 1 });
    const onActiveNoteMoved = vi.fn();

    const error = await renameSidebarNote(
      'Projects/Roadmap',
      'Plan',
      options({
        getActiveNoteId: () => 'Projects/Roadmap',
        runWithActiveNoteLock,
        onActiveNoteMoved,
      }),
    );

    expect(error).toBeNull();
    expect(runWithActiveNoteLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.moveNote.mock.invocationCallOrder[0],
    );
    expect(onActiveNoteMoved).toHaveBeenCalledWith('Projects/Roadmap', 'Projects/Plan-2', 'Plan-2');
  });

  it('reports a store failure instead of losing the edit', async () => {
    mocks.moveNote.mockRejectedValue(new Error('disk is full'));

    await expect(renameSidebarNote('Roadmap', 'Plan', options())).resolves.toBe('disk is full');
  });
});

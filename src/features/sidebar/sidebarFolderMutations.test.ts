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

type Options = Parameters<typeof renameSidebarNote>[2];

function options(overrides: Partial<Options> = {}): Options {
  return {
    getActiveNoteId: () => null,
    runWithActiveNoteLock: <T>(operation: () => Promise<T>) => operation(),
    onNoteIdsRenamed: vi.fn(),
    onNoteIdsDeleted: vi.fn(),
    onSelect: vi.fn(),
    onActiveNoteDeleted: vi.fn(),
    onActiveNoteMoved: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirmDialog.mockResolvedValue(true);
  mocks.getNoteById.mockImplementation((id: string) => ({ id }));
  mocks.getSaveIdentityChange.mockReturnValue(null);
});

describe('sidebar note delete and move', () => {
  it('closes the live session when the deleted sidebar row is the active note', async () => {
    const onActiveNoteDeleted = vi.fn();

    await confirmDeleteSidebarNote(
      'Projects/Roadmap',
      options({ getActiveNoteId: () => 'Projects/Roadmap', onActiveNoteDeleted }),
    );

    expect(mocks.deleteNote).toHaveBeenCalledWith('Projects/Roadmap');
    expect(onActiveNoteDeleted).toHaveBeenCalledOnce();
    expect(mocks.deleteNote.mock.invocationCallOrder[0]).toBeLessThan(
      onActiveNoteDeleted.mock.invocationCallOrder[0],
    );
    expect(mocks.showGlobalToast).toHaveBeenCalledWith({ path: 'notes.deleted' });
  });

  it('does not disturb the live session when deleting a background note', async () => {
    const onActiveNoteDeleted = vi.fn();
    const onNoteIdsDeleted = vi.fn();

    await confirmDeleteSidebarNote(
      'Archive/Old',
      options({
        getActiveNoteId: () => 'Projects/Roadmap',
        onNoteIdsDeleted,
        onActiveNoteDeleted,
      }),
    );

    expect(onActiveNoteDeleted).not.toHaveBeenCalled();
    expect(onNoteIdsDeleted).toHaveBeenCalledWith(['Archive/Old']);
  });

  it('deletes nothing when the picked note vanished without the flush renaming it', async () => {
    let activeId = 'Projects/Roadmap';
    mocks.getNoteById.mockImplementation((id: string) =>
      id === 'Archive/Old' ? { id } : undefined,
    );
    const onNoteIdsDeleted = vi.fn();

    await confirmDeleteSidebarNote(
      'Projects/Roadmap',
      options({
        getActiveNoteId: () => activeId,
        runWithActiveNoteLock: async <T>(operation: () => Promise<T>) => {
          activeId = 'Archive/Old';
          return operation();
        },
        onNoteIdsDeleted,
      }),
    );

    expect(mocks.deleteNote).not.toHaveBeenCalled();
    expect(onNoteIdsDeleted).not.toHaveBeenCalled();
    expect(mocks.showGlobalToast).toHaveBeenCalledWith({ path: 'notes.unavailable' });
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

    await moveSidebarNote(
      'Projects/Roadmap',
      'Archive',
      options({
        getActiveNoteId: () => activeId,
        runWithActiveNoteLock,
        onNoteIdsRenamed,
        onActiveNoteMoved,
      }),
    );

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

    await renameSidebarFolder(
      'Projects',
      'Work',
      options({ getActiveNoteId: () => 'Projects/Roadmap', runWithActiveNoteLock }),
    );

    expect(runWithActiveNoteLock).toHaveBeenCalledOnce();
    expect(runWithActiveNoteLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.renameFolderInPlace.mock.invocationCallOrder[0],
    );
  });

  it('publishes a background note rename so open and recently closed tabs can retarget', async () => {
    mocks.moveNote.mockResolvedValue({ id: 'Archive/Old-2', mtime: 1 });
    const onNoteIdsRenamed = vi.fn();

    await moveSidebarNote(
      'Projects/Old',
      'Archive',
      options({ getActiveNoteId: () => 'Projects/Roadmap', onNoteIdsRenamed }),
    );

    expect(onNoteIdsRenamed).toHaveBeenCalledWith([{ from: 'Projects/Old', to: 'Archive/Old-2' }]);
  });
});

describe('renameSidebarNote', () => {
  it.each([
    [
      'a path separator, rather than moving the note into a new folder',
      'a/b',
      { path: 'notes.title.forbiddenCharacter' },
    ],
    ['an empty name', '   ', { path: 'notes.title.empty' }],
    ['a case-insensitive duplicate in the same folder', 'notes', { path: 'notes.title.duplicate' }],
    ['an unchanged name, as a no-op', 'Roadmap', null],
  ])('leaves the note alone for %s', async (_case, name, expected) => {
    mocks.getAllNotes.mockReturnValue([{ id: 'Projects/Roadmap' }, { id: 'Projects/Notes' }]);

    await expect(renameSidebarNote('Projects/Roadmap', name, options())).resolves.toEqual(expected);
    expect(mocks.moveNote).not.toHaveBeenCalled();
  });

  it('flushes the live session first, then publishes and retargets the committed id', async () => {
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    mocks.moveNote.mockResolvedValue({ id: 'Projects/Plan-2', mtime: 1 });
    const onActiveNoteMoved = vi.fn();
    const onNoteIdsRenamed = vi.fn();

    const error = await renameSidebarNote(
      'Projects/Roadmap',
      '  Plan  ',
      options({
        getActiveNoteId: () => 'Projects/Roadmap',
        runWithActiveNoteLock,
        onActiveNoteMoved,
        onNoteIdsRenamed,
      }),
    );

    expect(error).toBeNull();
    // Only surrounding whitespace goes; the typed name is otherwise the filename.
    expect(mocks.moveNote).toHaveBeenCalledWith('Projects/Roadmap', 'Projects/Plan');
    expect(runWithActiveNoteLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.moveNote.mock.invocationCallOrder[0],
    );
    expect(onNoteIdsRenamed).toHaveBeenCalledWith([
      { from: 'Projects/Roadmap', to: 'Projects/Plan-2' },
    ]);
    expect(onActiveNoteMoved).toHaveBeenCalledWith('Projects/Roadmap', 'Projects/Plan-2', 'Plan-2');
  });

  it('reports a store failure instead of losing the edit', async () => {
    mocks.moveNote.mockRejectedValue(new Error('disk is full'));

    await expect(renameSidebarNote('Roadmap', 'Plan', options())).resolves.toEqual({
      path: 'notes.errors.renameFailed',
    });
  });
});

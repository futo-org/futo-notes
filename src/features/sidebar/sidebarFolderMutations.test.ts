import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  deleteNote: vi.fn(),
  moveNote: vi.fn(),
  renameOrMoveFolder: vi.fn(),
  showGlobalToast: vi.fn(),
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
  renameOrMoveFolder: mocks.renameOrMoveFolder,
}));
vi.mock('$features/notes/notes.svelte', () => ({
  deleteNote: mocks.deleteNote,
  getAllNotes: vi.fn(() => []),
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
} from './sidebarFolderMutations';

describe('confirmDeleteSidebarNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
    // Notes exist unless a test says otherwise; the action target is resolved
    // against the projection.
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
    // The flush renamed it, so the old id is no longer a note.
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
    mocks.renameOrMoveFolder.mockResolvedValue({
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
      mocks.renameOrMoveFolder.mock.invocationCallOrder[0],
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

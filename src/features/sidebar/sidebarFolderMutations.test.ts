import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  deleteNote: vi.fn(),
  moveNote: vi.fn(),
  showGlobalToast: vi.fn(),
}));

vi.mock('$features/folders/folderExpansion.svelte', () => ({
  clearDragHoverExpanded: vi.fn(),
}));
vi.mock('$features/folders/emptyFolders.svelte', () => ({
  getEmptyFolders: vi.fn(() => []),
  refreshEmptyFolders: vi.fn(),
}));
vi.mock('$features/folders/folderOperations', () => ({
  deleteFolder: vi.fn(),
  renameOrMoveFolder: vi.fn(),
}));
vi.mock('$features/notes/notes.svelte', () => ({
  deleteNote: mocks.deleteNote,
  getAllNotes: vi.fn(() => []),
  moveNote: mocks.moveNote,
}));
vi.mock('$shared/dialogs/confirmDialog', () => ({
  confirmDialog: mocks.confirmDialog,
}));
vi.mock('$shared/notifications/toastBus.svelte', () => ({
  showGlobalToast: mocks.showGlobalToast,
}));

import { confirmDeleteSidebarNote } from './sidebarFolderMutations';

describe('confirmDeleteSidebarNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
  });

  it('closes the live session when the deleted sidebar row is the active note', async () => {
    const onActiveNoteDeleted = vi.fn();

    await confirmDeleteSidebarNote('Projects/Roadmap', {
      getActiveNoteId: () => 'Projects/Roadmap',
      onSelect: vi.fn(),
      onActiveNoteDeleted,
      onActiveNoteMoved: vi.fn(),
    });

    expect(mocks.deleteNote).toHaveBeenCalledWith('Projects/Roadmap');
    expect(onActiveNoteDeleted).toHaveBeenCalledOnce();
    expect(onActiveNoteDeleted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteNote.mock.invocationCallOrder[0],
    );
    expect(mocks.showGlobalToast).toHaveBeenCalledWith('Note deleted');
  });

  it('does not disturb the live session when deleting a background note', async () => {
    const onActiveNoteDeleted = vi.fn();

    await confirmDeleteSidebarNote('Archive/Old', {
      getActiveNoteId: () => 'Projects/Roadmap',
      onSelect: vi.fn(),
      onActiveNoteDeleted,
      onActiveNoteMoved: vi.fn(),
    });

    expect(onActiveNoteDeleted).not.toHaveBeenCalled();
  });

  it('retargets the live session to the domain-selected id after an active note move', async () => {
    mocks.moveNote.mockResolvedValue({ id: 'Archive/Roadmap-2', mtime: 1 });
    const onActiveNoteMoved = vi.fn();

    const { moveSidebarNote } = await import('./sidebarFolderMutations');
    await moveSidebarNote('Projects/Roadmap', 'Archive', {
      getActiveNoteId: () => 'Projects/Roadmap',
      onSelect: vi.fn(),
      onActiveNoteDeleted: vi.fn(),
      onActiveNoteMoved,
    });

    expect(onActiveNoteMoved).toHaveBeenCalledWith(
      'Projects/Roadmap',
      'Archive/Roadmap-2',
      'Roadmap-2',
    );
  });
});

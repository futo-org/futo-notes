import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  deleteNote: vi.fn(),
  moveNote: vi.fn(),
  getNoteById: vi.fn(),
  getSaveIdentityChange: vi.fn(),
}));

vi.mock('$lib/platform', () => ({ isTauri: false, getPlatformFS: vi.fn() }));
vi.mock('$lib/platform/tauri', () => ({ getConfig: vi.fn() }));
vi.mock('$shared/dialogs/confirmDialog', () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock('$features/notes/notes.svelte', () => ({
  deleteNote: mocks.deleteNote,
  moveNote: mocks.moveNote,
  getNoteById: mocks.getNoteById,
  getSaveIdentityChange: mocks.getSaveIdentityChange,
}));

import { createCurrentNoteActions } from './createCurrentNoteActions.svelte';

describe('createCurrentNoteActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNoteById.mockImplementation((id: string) => ({ id }));
    mocks.getSaveIdentityChange.mockReturnValue(null);
  });

  it('confirms before deleting the active note and reports the completed action', async () => {
    mocks.confirmDialog.mockResolvedValue(true);
    const showToast = vi.fn();
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const onDeleted = vi.fn();
    const onDeleteConfirmed = vi.fn();
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => 'Projects/Roadmap',
      runWithActiveNoteLock,
      showToast,
      onMoved: vi.fn(),
      onDeleted,
      onDeleteConfirmed,
    });

    await actions.deleteCurrentNote();

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      'Delete this note? This action cannot be undone.',
      { title: 'Delete note', kind: 'warning' },
    );
    expect(mocks.deleteNote).toHaveBeenCalledWith('Projects/Roadmap');
    expect(onDeleted).toHaveBeenCalledWith('Projects/Roadmap');
    expect(runWithActiveNoteLock).toHaveBeenCalledOnce();
    expect(onDeleteConfirmed).toHaveBeenCalledOnce();
    expect(runWithActiveNoteLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteNote.mock.invocationCallOrder[0],
    );
    expect(mocks.deleteNote.mock.invocationCallOrder[0]).toBeLessThan(
      onDeleteConfirmed.mock.invocationCallOrder[0],
    );
    expect(showToast).toHaveBeenCalledWith('Note deleted');
  });

  it('keeps the graph stub as a toast-only action', () => {
    const showToast = vi.fn();
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => 'Roadmap',
      runWithActiveNoteLock: (operation) => operation(),
      showToast,
      onMoved: vi.fn(),
      onDeleted: vi.fn(),
      onDeleteConfirmed: vi.fn(),
    });

    actions.graphView();

    expect(showToast).toHaveBeenCalledWith('coming soon');
  });

  it('shows a failure toast and does not reject when the move fails', async () => {
    mocks.moveNote.mockRejectedValue(new Error('A note with that name already exists'));
    const showToast = vi.fn();
    const onMoved = vi.fn();
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => 'Projects/Roadmap',
      runWithActiveNoteLock: async <T>(operation: () => Promise<T>) => operation(),
      showToast,
      onMoved,
      onDeleted: vi.fn(),
      onDeleteConfirmed: vi.fn(),
    });

    await expect(actions.moveToFolder('Archive')).resolves.toBeUndefined();

    expect(showToast).toHaveBeenCalledWith('A note with that name already exists');
    expect(onMoved).not.toHaveBeenCalled();
  });
});

describe('createCurrentNoteActions note targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNoteById.mockImplementation((id: string) => ({ id }));
    mocks.getSaveIdentityChange.mockReturnValue(null);
  });

  it('ignores a save that renamed some other note', async () => {
    mocks.getSaveIdentityChange.mockReturnValue({ from: 'Something else', to: 'Its new name' });
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.getNoteById.mockImplementation((id: string) =>
      id === 'Its new name' ? { id } : undefined,
    );
    const showToast = vi.fn();
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => 'Doomed',
      runWithActiveNoteLock: async <T>(operation: () => Promise<T>) => operation(),
      showToast,
      onMoved: vi.fn(),
      onDeleted: vi.fn(),
      onDeleteConfirmed: vi.fn(),
    });

    await actions.deleteCurrentNote();

    expect(mocks.deleteNote).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('That note is no longer available');
  });

  it('deletes the picked note, not one navigated to while the flush ran', async () => {
    let activeId: string = 'Doomed';
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.getNoteById.mockImplementation((id: string) => (id === 'Doomed' ? { id } : undefined));
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => {
      activeId = 'Innocent';
      return operation();
    });
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => activeId,
      runWithActiveNoteLock,
      showToast: vi.fn(),
      onMoved: vi.fn(),
      onDeleted: vi.fn(),
      onDeleteConfirmed: vi.fn(),
    });

    await actions.deleteCurrentNote();

    expect(mocks.deleteNote).toHaveBeenCalledExactlyOnceWith('Doomed');
  });

  it('deletes the id the flush minted for an unsaved draft, not the note switched to', async () => {
    let activeId: string | null = null;
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.getNoteById.mockImplementation((id: string) =>
      id === 'Fresh draft' || id === 'Bystander' ? { id } : undefined,
    );
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => {
      mocks.getSaveIdentityChange.mockReturnValue({ from: null, to: 'Fresh draft' });
      activeId = 'Bystander';
      return operation();
    });
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => activeId,
      runWithActiveNoteLock,
      showToast: vi.fn(),
      onMoved: vi.fn(),
      onDeleted: vi.fn(),
      onDeleteConfirmed: vi.fn(),
    });

    await actions.deleteCurrentNote();

    expect(mocks.deleteNote).toHaveBeenCalledExactlyOnceWith('Fresh draft');
  });

  it('deletes nothing when the picked note vanished without the flush renaming it', async () => {
    let activeId: string | null = 'Doomed';
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.getNoteById.mockImplementation((id: string) => (id === 'Bystander' ? { id } : undefined));
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => {
      activeId = 'Bystander';
      return operation();
    });
    const onDeleted = vi.fn();
    const showToast = vi.fn();
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => activeId,
      runWithActiveNoteLock,
      showToast,
      onMoved: vi.fn(),
      onDeleted,
      onDeleteConfirmed: vi.fn(),
    });

    await actions.deleteCurrentNote();

    expect(mocks.deleteNote).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('That note is no longer available');
  });

  it('moves the picked note, not one navigated to while the flush ran', async () => {
    let activeId: string = 'Mover';
    mocks.getNoteById.mockImplementation((id: string) => (id === 'Mover' ? { id } : undefined));
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => {
      activeId = 'Bystander';
      return operation();
    });
    mocks.moveNote.mockResolvedValue({ id: 'Work/Mover', mtime: 1 });
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => activeId,
      runWithActiveNoteLock,
      showToast: vi.fn(),
      onMoved: vi.fn(),
      onDeleted: vi.fn(),
      onDeleteConfirmed: vi.fn(),
    });

    await actions.moveToFolder('Work');

    expect(mocks.moveNote).toHaveBeenCalledWith('Mover', 'Work/Mover');
  });

  it('flushes a pending save before moving and uses the post-save note id', async () => {
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
    mocks.moveNote.mockResolvedValue({ id: 'Archive/Renamed roadmap', mtime: 1 });
    const onMoved = vi.fn();
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => activeId,
      runWithActiveNoteLock,
      showToast: vi.fn(),
      onMoved,
      onDeleted: vi.fn(),
      onDeleteConfirmed: vi.fn(),
    });

    await actions.moveToFolder('Archive');

    expect(runWithActiveNoteLock).toHaveBeenCalledOnce();
    expect(mocks.moveNote).toHaveBeenCalledWith(
      'Projects/Renamed roadmap',
      'Archive/Renamed roadmap',
    );
    expect(runWithActiveNoteLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.moveNote.mock.invocationCallOrder[0],
    );
    expect(onMoved).toHaveBeenCalledWith(
      'Projects/Renamed roadmap',
      'Archive/Renamed roadmap',
      'Renamed roadmap',
    );
  });
});

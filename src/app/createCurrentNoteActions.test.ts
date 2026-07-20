import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  deleteNote: vi.fn(),
  moveNote: vi.fn(),
}));

vi.mock('$lib/platform', () => ({ isTauri: false, getPlatformFS: vi.fn() }));
vi.mock('$lib/platform/tauri', () => ({ getConfig: vi.fn() }));
vi.mock('$shared/dialogs/confirmDialog', () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock('$features/notes/notes.svelte', () => ({
  deleteNote: mocks.deleteNote,
  moveNote: mocks.moveNote,
}));

import { createCurrentNoteActions } from './createCurrentNoteActions.svelte';

describe('createCurrentNoteActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('flushes a pending save before moving and uses the post-save note id', async () => {
    let activeId = 'Projects/Roadmap';
    const runWithActiveNoteLock = vi.fn(async <T>(operation: () => Promise<T>) => {
      activeId = 'Projects/Renamed roadmap';
      return operation();
    });
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

    // Must resolve — a rejection here escapes the void onpick handler as an
    // unhandled promise rejection (the regression this locks).
    await expect(actions.moveToFolder('Archive')).resolves.toBeUndefined();

    expect(showToast).toHaveBeenCalledWith('A note with that name already exists');
    expect(onMoved).not.toHaveBeenCalled();
  });
});

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
    const onDeleteConfirmed = vi.fn();
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => 'Projects/Roadmap',
      showToast,
      onMoved: vi.fn(),
      onDeleteConfirmed,
    });

    await actions.deleteCurrentNote();

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      'Delete this note? This action cannot be undone.',
      { title: 'Delete note', kind: 'warning' },
    );
    expect(mocks.deleteNote).toHaveBeenCalledWith('Projects/Roadmap');
    expect(onDeleteConfirmed).toHaveBeenCalledOnce();
    expect(onDeleteConfirmed.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteNote.mock.invocationCallOrder[0],
    );
    expect(showToast).toHaveBeenCalledWith('Note deleted');
  });

  it('keeps the graph stub as a toast-only action', () => {
    const showToast = vi.fn();
    const actions = createCurrentNoteActions({
      getActiveNoteId: () => 'Roadmap',
      showToast,
      onMoved: vi.fn(),
      onDeleteConfirmed: vi.fn(),
    });

    actions.graphView();

    expect(showToast).toHaveBeenCalledWith('coming soon');
  });
});

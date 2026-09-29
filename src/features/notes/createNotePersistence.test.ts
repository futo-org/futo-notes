// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('./notes.svelte', () => ({
  updateNote: vi.fn(),
  _applyLocalMutation: vi.fn(),
  recordSaveIdentityChange: vi.fn(),
}));

import { _applyLocalMutation, updateNote } from './notes.svelte';
import { createNotePersistence } from './createNotePersistence';
import type { LocalNoteMutation } from '$lib/localNoteStore';

function parkedSave(reconcileOpenNote: (state: { savedContent: string }) => void) {
  const parkedMutation = {
    warnings: [],
    upserted: [
      { note: { id: 'Original (conflict 2026-07-29)', title: 'Original (conflict 2026-07-29)' } },
    ],
  } as unknown as LocalNoteMutation;
  vi.mocked(updateNote).mockResolvedValue({
    id: 'Original',
    mtime: 123,
    disposition: 'parked',
    parkedId: 'Original (conflict 2026-07-29)',
    unappliedMutation: parkedMutation,
  });
  const state = {
    originalId: 'Original',
    savedContent: 'original content',
    savedTitle: 'Original',
    title: ' Original ',
  };
  const onSaved = vi.fn();
  const reconcile = vi.fn(async () => reconcileOpenNote(state));
  const saveNote = createNotePersistence({
    clearPendingFolder: vi.fn(),
    getEditorContent: () => 'my draft',
    getNoteId: () => 'Original',
    getPendingFolder: () => null,
    getState: () => ({ ...state }),
    hasDuplicateTitle: () => false,
    isLoading: () => false,
    onSaved,
    reconcileOpenNote: reconcile,
    showTitleWarning: vi.fn(),
  });
  return { onSaved, parkedMutation, reconcile, saveNote };
}

describe('createNotePersistence', () => {
  beforeEach(() => {
    vi.mocked(updateNote).mockReset();
    vi.mocked(_applyLocalMutation).mockClear();
  });

  it('refuses to save while the session is loading (F1 straddle guard)', async () => {
    // A save that reaches here mid-note-switch would write the outgoing
    // note's stale title/content under the incoming note's originalId — see
    // IsLoading in createNotePersistence.ts.
    const onSaved = vi.fn();
    const saveNote = createNotePersistence({
      clearPendingFolder: vi.fn(),
      getEditorContent: () => 'edited content',
      getNoteId: () => 'Incoming',
      getPendingFolder: () => null,
      getState: () => ({
        originalId: 'Incoming',
        savedContent: 'outgoing saved content',
        savedTitle: 'Outgoing',
        title: 'Outgoing',
      }),
      hasDuplicateTitle: () => false,
      isLoading: () => true,
      onSaved,
      reconcileOpenNote: vi.fn(),
      showTitleWarning: vi.fn(),
    });

    await expect(saveNote()).resolves.toBe(false);

    expect(updateNote).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('warns when a duplicate title blocks the save', async () => {
    const showTitleWarning = vi.fn();
    const saveNote = createNotePersistence({
      clearPendingFolder: vi.fn(),
      getEditorContent: () => 'edited content',
      getNoteId: () => 'Original',
      getPendingFolder: () => null,
      getState: () => ({
        originalId: 'Original',
        savedContent: 'original content',
        savedTitle: 'Original',
        title: 'Duplicate',
      }),
      hasDuplicateTitle: () => true,
      isLoading: () => false,
      onSaved: vi.fn(),
      reconcileOpenNote: vi.fn(),
      showTitleWarning,
    });

    await expect(saveNote()).resolves.toBe(false);

    expect(showTitleWarning).toHaveBeenCalledExactlyOnceWith({ path: 'notes.title.duplicate' });
    expect(updateNote).not.toHaveBeenCalled();
  });

  it.each(['wrote', 'recreated'] as const)(
    'commits saved baselines and reports a disk write after %s',
    async (disposition) => {
      vi.mocked(updateNote).mockResolvedValue({
        id: 'Original',
        mtime: 123,
        disposition,
      });
      const onSaved = vi.fn();
      const reconcileOpenNote = vi.fn();
      const saveNote = createNotePersistence({
        clearPendingFolder: vi.fn(),
        getEditorContent: () => 'edited content',
        getNoteId: () => 'Original',
        getPendingFolder: () => null,
        getState: () => ({
          originalId: 'Original',
          savedContent: 'original content',
          savedTitle: 'Original',
          title: 'Original',
        }),
        hasDuplicateTitle: () => false,
        isLoading: () => false,
        onSaved,
        reconcileOpenNote,
        showTitleWarning: vi.fn(),
      });

      await expect(saveNote()).resolves.toBe(true);

      expect(updateNote).toHaveBeenCalledWith('Original', 'edited content', {
        originalId: 'Original',
        base: 'original content',
      });
      expect(onSaved).toHaveBeenCalledOnce();
      expect(reconcileOpenNote).not.toHaveBeenCalled();
    },
  );

  it('commits the saved baseline without notifying sync when the draft converged', async () => {
    vi.mocked(updateNote).mockResolvedValue({
      id: 'Original',
      mtime: 123,
      disposition: 'converged',
    });
    const onSaved = vi.fn();
    const saveNote = createNotePersistence({
      clearPendingFolder: vi.fn(),
      getEditorContent: () => 'edited content',
      getNoteId: () => 'Original',
      getPendingFolder: () => null,
      getState: () => ({
        originalId: 'Original',
        savedContent: 'original content',
        savedTitle: 'Original',
        title: 'Original',
      }),
      hasDuplicateTitle: () => false,
      isLoading: () => false,
      onSaved,
      reconcileOpenNote: vi.fn(),
      showTitleWarning: vi.fn(),
    });

    await expect(saveNote()).resolves.toBe(false);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('reconciles a parked draft against the exact raw editor title snapshot', async () => {
    // An unfocused editor adopts the peer's original: the baseline moves to it.
    const { onSaved, parkedMutation, reconcile, saveNote } = parkedSave((state) => {
      state.savedContent = 'peer content';
    });

    await expect(saveNote()).resolves.toBe(false);

    expect(onSaved).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledExactlyOnceWith('Original', {
      content: 'my draft',
      title: ' Original ',
    });
    expect(_applyLocalMutation).toHaveBeenCalledExactlyOnceWith(parkedMutation);
    expect(vi.mocked(_applyLocalMutation).mock.invocationCallOrder[0]).toBeLessThan(
      reconcile.mock.invocationCallOrder[0],
    );
  });

  it('follows the parked copy with the parked draft as its baseline when the adopt waits', async () => {
    // A focused editor defers the adopt. Staying on the original id with the
    // pre-park baseline parked a fresh copy on every later save.
    const { onSaved, saveNote } = parkedSave(() => {});

    await expect(saveNote()).resolves.toBe(false);

    expect(onSaved).toHaveBeenCalledExactlyOnceWith({
      id: 'Original (conflict 2026-07-29)',
      title: 'Original (conflict 2026-07-29)',
      requestedTitle: ' Original ',
      content: 'my draft',
      savedOriginalId: 'Original',
      keepsOriginal: true,
    });
  });
});

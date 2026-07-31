// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('./notes.svelte', () => ({ updateNote: vi.fn() }));

import { updateNote } from './notes.svelte';
import { createNotePersistence } from './createNotePersistence';

describe('createNotePersistence', () => {
  beforeEach(() => {
    vi.mocked(updateNote).mockReset();
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
      onSaved: vi.fn(),
      reconcileOpenNote: vi.fn(),
      showTitleWarning,
    });

    await expect(saveNote()).resolves.toBe(false);

    expect(showTitleWarning).toHaveBeenCalledExactlyOnceWith(
      'A note with this name already exists',
    );
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
        onSaved,
        reconcileOpenNote,
        showTitleWarning: vi.fn(),
      });

      await expect(saveNote()).resolves.toBe(true);

      expect(updateNote).toHaveBeenCalledWith('Original', 'Original', 'edited content', {
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
      onSaved,
      reconcileOpenNote: vi.fn(),
      showTitleWarning: vi.fn(),
    });

    await expect(saveNote()).resolves.toBe(false);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('reconciles the open note without advancing its saved baseline when the draft parks', async () => {
    vi.mocked(updateNote).mockResolvedValue({
      id: 'Original',
      mtime: 123,
      disposition: 'parked',
      parkedId: 'Original (conflict 2026-07-29)',
    });
    const onSaved = vi.fn();
    const reconcileOpenNote = vi.fn(async () => true);
    const saveNote = createNotePersistence({
      clearPendingFolder: vi.fn(),
      getEditorContent: () => 'my draft',
      getNoteId: () => 'Original',
      getPendingFolder: () => null,
      getState: () => ({
        originalId: 'Original',
        savedContent: 'original content',
        savedTitle: 'Original',
        title: 'Original',
      }),
      hasDuplicateTitle: () => false,
      onSaved,
      reconcileOpenNote,
      showTitleWarning: vi.fn(),
    });

    await expect(saveNote()).resolves.toBe(false);

    expect(onSaved).not.toHaveBeenCalled();
    expect(reconcileOpenNote).toHaveBeenCalledExactlyOnceWith('Original');
  });
});

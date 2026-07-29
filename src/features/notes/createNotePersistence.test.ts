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
      showTitleWarning,
    });

    await expect(saveNote()).resolves.toBe(false);

    expect(showTitleWarning).toHaveBeenCalledExactlyOnceWith(
      'A note with this name already exists',
    );
    expect(updateNote).not.toHaveBeenCalled();
  });
});

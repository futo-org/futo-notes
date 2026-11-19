// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));

import { createNotePersistence } from './createNotePersistence';

function persistence(
  state: { originalId: string; savedTitle: string; title: string },
  overrides: {
    hasDuplicateTitle?: () => boolean;
    isLoading?: () => boolean;
  } = {},
) {
  const saveBody = vi.fn(async () => {});
  const renameNote = vi.fn(async (_newId: string) => {});
  const onTitleSaved = vi.fn();
  const showTitleWarning = vi.fn();
  const save = createNotePersistence({
    getEditorNoteId: () => state.originalId,
    getState: () => ({ ...state }),
    hasDuplicateTitle: overrides.hasDuplicateTitle ?? (() => false),
    isLoading: overrides.isLoading ?? (() => false),
    onTitleSaved,
    saveBody,
    renameNote,
    showTitleWarning,
  });
  return { save, saveBody, renameNote, onTitleSaved, showTitleWarning };
}

const original = {
  originalId: 'Original',
  savedTitle: 'Original',
  title: 'Original',
};

describe('createNotePersistence', () => {
  it('saves nothing while a note switch is opening the next note', async () => {
    const { save, saveBody, renameNote } = persistence(
      { ...original, title: 'Outgoing' },
      { isLoading: () => true },
    );

    await save();

    expect(saveBody).not.toHaveBeenCalled();
    expect(renameNote).not.toHaveBeenCalled();
  });

  it('a duplicate title warns but still saves the body under its current name', async () => {
    const { save, saveBody, renameNote, onTitleSaved, showTitleWarning } = persistence(
      { ...original, title: 'Duplicate' },
      { hasDuplicateTitle: () => true },
    );

    await save();

    expect(showTitleWarning).toHaveBeenCalledExactlyOnceWith({ path: 'notes.title.duplicate' });
    expect(saveBody).toHaveBeenCalledOnce();
    expect(renameNote).not.toHaveBeenCalled();
    // The field keeps the refused title: the save took no title.
    expect(onTitleSaved).not.toHaveBeenCalled();
  });

  it('saves a title edit as a rename; the editor names the destination in its folder', async () => {
    const { save, saveBody, renameNote, onTitleSaved } = persistence({
      ...original,
      originalId: 'Work/Original',
      title: 'Renamed',
    });

    await save();

    expect(renameNote).toHaveBeenCalledExactlyOnceWith('Renamed');
    expect(saveBody).not.toHaveBeenCalled();
    expect(onTitleSaved).toHaveBeenCalledExactlyOnceWith('Renamed');
  });

  it('asks the editor to write its draft when the title is unchanged', async () => {
    // The editor knows what it has written; a draft disk already holds writes nothing.
    const { save, saveBody, renameNote } = persistence(original);
    await save();
    expect(saveBody).toHaveBeenCalledOnce();
    expect(renameNote).not.toHaveBeenCalled();
  });

  it('rejects when the save fails, taking no title', async () => {
    const { save, renameNote, onTitleSaved } = persistence({ ...original, title: 'Renamed' });
    renameNote.mockRejectedValueOnce(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(save()).rejects.toThrow('disk full');

    warn.mockRestore();
    expect(onTitleSaved).not.toHaveBeenCalled();
  });
});

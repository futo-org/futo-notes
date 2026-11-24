import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotePreview } from '$shared/types/note';
import { getEmptyFolders, setFolderSnapshot } from '$features/folders/emptyFolders.svelte';
import {
  _applyLocalMutation,
  createNote,
  getAllNotes,
  handleExternalFileChange,
  moveNote,
  refreshNotesAfterSync,
  refreshNotesFromStorage,
  search,
  setNoteSortOrder,
  setNotesUniverse,
} from './notes.svelte';
import { _setLocalNoteStoreForTest, type LocalNoteMetadata } from '$lib/localNoteStore';
import { fakeStore, metadata, mutation, upsert } from './__test__/notesContractFixtures';

function preview(id: string): NotePreview {
  return { id, title: id, preview: '', modificationTime: 1, tags: [] };
}

// eslint-disable-next-line max-lines-per-function -- One contract matrix covers every mutation projection.
describe('TypeScript local-note projection', () => {
  beforeEach(() => {
    setNotesUniverse([]);
    setFolderSnapshot([], []);
    _setLocalNoteStoreForTest(null);
  });

  it('accepts the store collision result instead of predicting a create id', async () => {
    const save = vi.fn(async () => mutation({ upserted: [upsert('Draft-2')], finalId: 'Draft-2' }));
    _setLocalNoteStoreForTest(fakeStore({ save }));

    await expect(createNote('Draft', 'body')).resolves.toEqual({ id: 'Draft-2', mtime: 123 });
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(null, 'Draft', 'body');
    expect(getAllNotes().map((note) => note.id)).toEqual(['Draft-2']);
  });

  it('projects a rename and every backlink rewrite from one committed result', async () => {
    setNotesUniverse([preview('Old'), preview('Links')]);
    const move = vi.fn(async () =>
      mutation({
        removed: ['Old'],
        renamed: [{ from: 'Old', to: 'Folder/New' }],
        upserted: [upsert('Folder/New', 0), upsert('Links', 1, 'See [[Folder/New]]')],
        finalId: 'Folder/New',
      }),
    );
    _setLocalNoteStoreForTest(fakeStore({ move }));

    await expect(moveNote('Old', 'Folder/New')).resolves.toEqual({
      id: 'Folder/New',
      mtime: 123,
    });
    expect(move).toHaveBeenCalledOnce();
    expect(getAllNotes().map((note) => note.id)).toEqual(['Folder/New', 'Links']);
    expect(getAllNotes().find((note) => note.id === 'Links')?.preview).toBe('See [[Folder/New]]');
  });

  it('changes the sort order with one engine call and projects its snapshot verbatim', async () => {
    setNotesUniverse([preview('Newest'), preview('Alpha')]);
    const setSortOrder = vi.fn(async () => ({
      notes: [metadata('Alpha'), metadata('Newest')],
      folders: ['Kept'],
    }));
    const snapshot = vi.fn();
    _setLocalNoteStoreForTest(fakeStore({ setSortOrder, snapshot }));

    await setNoteSortOrder({ key: 'name', direction: 'ascending' });

    expect(setSortOrder).toHaveBeenCalledExactlyOnceWith({ key: 'name', direction: 'ascending' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(getAllNotes().map((note) => note.id)).toEqual(['Alpha', 'Newest']);
    expect([...getEmptyFolders()]).toEqual(['Kept']);
  });

  it('sends rapid sort picks to the engine one at a time, in order', async () => {
    let resolveFirst!: (snapshot: { notes: LocalNoteMetadata[]; folders: string[] }) => void;
    const setSortOrder = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ notes: LocalNoteMetadata[]; folders: string[] }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => ({ notes: [metadata('B')], folders: [] }));
    _setLocalNoteStoreForTest(fakeStore({ setSortOrder }));

    const first = setNoteSortOrder({ key: 'name', direction: 'ascending' });
    const second = setNoteSortOrder({ key: 'name', direction: 'descending' });
    await Promise.resolve();
    expect(setSortOrder).toHaveBeenCalledOnce();

    resolveFirst({ notes: [metadata('A')], folders: [] });
    await Promise.all([first, second]);
    expect(setSortOrder.mock.calls.map(([order]) => order)).toEqual([
      { key: 'name', direction: 'ascending' },
      { key: 'name', direction: 'descending' },
    ]);
    expect(getAllNotes().map((note) => note.id)).toEqual(['B']);
  });

  it('re-reads a storage refresh when a mutation lands while the scan is in flight', async () => {
    setNotesUniverse([preview('Existing')]);
    let resolveFirst!: (snapshot: { notes: LocalNoteMetadata[]; folders: string[] }) => void;
    const snapshot = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ notes: LocalNoteMetadata[]; folders: string[] }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => ({
        notes: [metadata('New'), metadata('Existing')],
        folders: [],
      }));
    _setLocalNoteStoreForTest(fakeStore({ snapshot }));

    const refresh = refreshNotesFromStorage();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
    _applyLocalMutation(mutation({ upserted: [upsert('New')] }));
    resolveFirst({ notes: [metadata('Existing')], folders: [] });
    await refresh;

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(getAllNotes().map((note) => note.id)).toEqual(['New', 'Existing']);
  });

  it('applies the engine mutation returned for sync-written files', async () => {
    setNotesUniverse([preview('Old')]);
    const projected = mutation({
      removed: ['Old'],
      upserted: [upsert('New')],
      renamed: [{ from: 'Old', to: 'New' }],
      folders: ['Archive'],
    });
    const refreshExternalChanges = vi.fn(async () => projected);
    _setLocalNoteStoreForTest(fakeStore({ refreshExternalChanges }));

    await refreshNotesAfterSync(['New'], ['Old'], [{ fromId: 'Old', toId: 'New' }]);

    expect(refreshExternalChanges).toHaveBeenCalledExactlyOnceWith(
      ['New'],
      ['Old'],
      [{ fromId: 'Old', toId: 'New' }],
    );
    expect(getAllNotes().map((note) => note.id)).toEqual(['New']);
    expect(getEmptyFolders()).toEqual(new Set(['Archive']));
  });

  it('keeps sync completion alive when scoped projection and recovery both fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refreshExternalChanges = vi.fn(async () => {
      throw new Error('scoped projection failed');
    });
    const rescan = vi.fn(async () => {
      throw new Error('search recovery failed');
    });
    const snapshot = vi.fn(async () => {
      throw new Error('snapshot recovery failed');
    });
    _setLocalNoteStoreForTest(fakeStore({ refreshExternalChanges, rescan, snapshot }));

    await expect(refreshNotesAfterSync(['New'], [], [])).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  // The projection holds no sort rule (ADR-0001): it reproduces the engine's
  // order purely by applying removals and position splices.
  it('applies engine-reported positions as verbatim splices', () => {
    setNotesUniverse([preview('A'), preview('B'), preview('C')]);

    _applyLocalMutation(mutation({ upserted: [upsert('D', 1)] }));
    expect(getAllNotes().map((note) => note.id)).toEqual(['A', 'D', 'B', 'C']);

    // Re-ranking an existing row moves it: old row drops, splice re-inserts.
    _applyLocalMutation(mutation({ upserted: [upsert('C', 0)] }));
    expect(getAllNotes().map((note) => note.id)).toEqual(['C', 'A', 'D', 'B']);

    _applyLocalMutation(mutation({ removed: ['A'] }));
    expect(getAllNotes().map((note) => note.id)).toEqual(['C', 'D', 'B']);
  });

  it('clamps an out-of-range position instead of crashing', () => {
    setNotesUniverse([preview('A')]);
    _applyLocalMutation(mutation({ upserted: [upsert('Z', 99)] }));
    expect(getAllNotes().map((note) => note.id)).toEqual(['A', 'Z']);
  });

  it('applies the engine-reported folder projection with the note rows', () => {
    _applyLocalMutation(mutation({ folders: ['Empty', 'Projects'] }));
    expect([...getEmptyFolders()]).toEqual(['Empty', 'Projects']);
  });

  // The create path no longer suppresses the watcher (D2); the own-create echo
  // is made harmless because reconciling it is an idempotent no-op — the note
  // is already in the cache, so the snapshot refresh produces no duplicate and
  // no change.
  it('reconciling an own-create watcher echo is an idempotent no-op', async () => {
    _setLocalNoteStoreForTest(
      fakeStore({
        snapshot: vi.fn(async () => ({
          notes: [metadata('New note', 'my body')],
          folders: [],
        })),
      }),
    );
    setNotesUniverse([
      { id: 'New note', title: 'New note', preview: 'my body', modificationTime: 1, tags: [] },
    ]);

    await handleExternalFileChange('New note.md');

    const notes = getAllNotes();
    expect(notes.map((note) => note.id)).toEqual(['New note']);
    expect(notes[0].preview).toBe('my body');
  });

  it('does not fall back to shell substring search', async () => {
    setNotesUniverse([{ ...preview('Matching title'), preview: 'needle' }]);
    const storeSearch = vi.fn(async () => []);
    _setLocalNoteStoreForTest(fakeStore({ search: storeSearch }));

    await expect(search('needle')).resolves.toEqual([]);
    // No limit given: the store applies its own default.
    expect(storeSearch).toHaveBeenCalledWith('needle', undefined);
  });
});

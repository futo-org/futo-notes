import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotePreview } from '../types';
import {
  createNote,
  getAllNotes,
  moveNote,
  search,
  setNotesUniverse,
  updateNote,
} from './notes.svelte';
import {
  _setLocalNoteStoreForTest,
  type LocalNoteMetadata,
  type LocalNoteMutation,
  type LocalNoteStore,
} from './localNoteStore';

function metadata(id: string, preview = ''): LocalNoteMetadata {
  const slash = id.lastIndexOf('/');
  return {
    id,
    title: slash < 0 ? id : id.slice(slash + 1),
    folder: slash < 0 ? '' : id.slice(0, slash),
    modifiedMs: 123,
    preview,
    richPreview: preview,
    tags: [],
  };
}

function mutation(overrides: Partial<LocalNoteMutation> = {}): LocalNoteMutation {
  return { upserted: [], removed: [], renamed: [], warnings: [], ...overrides };
}

function preview(id: string): NotePreview {
  return { id, title: id, preview: '', modificationTime: 1, tags: [] };
}

function fakeStore(overrides: Partial<LocalNoteStore> = {}): LocalNoteStore {
  return {
    bootstrap: vi.fn(),
    snapshot: vi.fn(),
    inventory: vi.fn(),
    read: vi.fn(),
    exists: vi.fn(),
    save: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    reset: vi.fn(),
    search: vi.fn(async () => []),
    searchStatus: vi.fn(async () => ({ keyword: { ready: true } })),
    rescan: vi.fn(),
    ...overrides,
  } as LocalNoteStore;
}

describe('TypeScript local-note projection', () => {
  beforeEach(() => {
    setNotesUniverse([]);
    _setLocalNoteStoreForTest(null);
  });

  it('accepts the store collision result instead of predicting a create id', async () => {
    const save = vi.fn(async () => mutation({ upserted: [metadata('Draft-2')] }));
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
        upserted: [metadata('Folder/New'), metadata('Links', 'See [[Folder/New]]')],
      }),
    );
    _setLocalNoteStoreForTest(fakeStore({ move }));

    await expect(moveNote('Old', 'Folder/New')).resolves.toEqual({
      id: 'Folder/New',
      mtime: 123,
    });
    expect(move).toHaveBeenCalledOnce();
    expect(
      getAllNotes()
        .map((note) => note.id)
        .sort(),
    ).toEqual(['Folder/New', 'Links']);
    expect(getAllNotes().find((note) => note.id === 'Links')?.preview).toBe('See [[Folder/New]]');
  });

  it('sends editor save, rename, and content as one store operation', async () => {
    const save = vi.fn(async () =>
      mutation({
        removed: ['Old'],
        renamed: [{ from: 'Old', to: 'New' }],
        upserted: [metadata('New')],
      }),
    );
    _setLocalNoteStoreForTest(fakeStore({ save }));

    await updateNote('New', 'ignored shell title', 'latest body', 'Old', 456);
    expect(save).toHaveBeenCalledWith('Old', 'New', 'latest body', 456);
  });

  it('does not fall back to shell substring search', async () => {
    setNotesUniverse([{ ...preview('Matching title'), preview: 'needle' }]);
    const storeSearch = vi.fn(async () => []);
    _setLocalNoteStoreForTest(fakeStore({ search: storeSearch }));

    await expect(search('needle')).resolves.toEqual([]);
    expect(storeSearch).toHaveBeenCalledWith('needle');
  });
});

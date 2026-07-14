import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotePreview } from '../types';
import {
  createNote,
  getAllNotes,
  handleExternalFileChange,
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
    expect(storeSearch).toHaveBeenCalledWith('needle');
  });
});

// A4: the shared search-readiness promise must be bounded (never-ready index
// can't hang search) and un-poisonable (a transient status-probe rejection
// doesn't permanently reject it). Fresh module per test for clean init state.
describe('search readiness (A4)', () => {
  async function freshModules() {
    vi.resetModules();
    const notes = await import('./notes.svelte');
    const ln = await import('./localNoteStore');
    return { notes, ln };
  }

  function bootstrapResult(notes: LocalNoteMetadata[] = []) {
    return { snapshot: { notes, folders: [] }, seeded: 0, migrated: 0, warnings: [] };
  }

  it('degrades promptly instead of hanging when the index never becomes ready', async () => {
    const { notes, ln } = await freshModules();
    notes._setSearchReadyTimeoutForTest(60);
    ln._setLocalNoteStoreForTest(
      fakeStore({
        bootstrap: vi.fn(async () => bootstrapResult()),
        searchStatus: vi.fn(async () => ({ keyword: { ready: false } })),
        search: vi.fn(async () => []),
      }),
    );
    await notes.initNotes();

    const started = Date.now();
    await expect(notes.search('needle')).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('survives a transient searchStatus rejection without poisoning search', async () => {
    const { notes, ln } = await freshModules();
    notes._setSearchReadyTimeoutForTest(2000);
    let probes = 0;
    ln._setLocalNoteStoreForTest(
      fakeStore({
        bootstrap: vi.fn(async () => bootstrapResult([metadata('X', 'body')])),
        searchStatus: vi.fn(async () => {
          probes += 1;
          if (probes === 1) throw new Error('transient probe failure');
          return { keyword: { ready: true } };
        }),
        search: vi.fn(async () => [{ noteId: 'X', score: 1, source: 'keyword' }]),
      }),
    );
    await notes.initNotes();

    const results = await notes.search('q');
    expect(results.map((item) => item.note.id)).toEqual(['X']);
    expect(probes).toBeGreaterThanOrEqual(2);
  });
});

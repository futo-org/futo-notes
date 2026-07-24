import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotePreview } from '$shared/types/note';
import { getEmptyFolders, setFolderSnapshot } from '$features/folders/emptyFolders.svelte';
import {
  _applyLocalMutation,
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
  type LocalNoteUpsert,
} from '$lib/localNoteStore';

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

function upsert(id: string, position = 0, preview = ''): LocalNoteUpsert {
  return { note: metadata(id, preview), position };
}

function mutation(overrides: Partial<LocalNoteMutation> = {}): LocalNoteMutation {
  return {
    upserted: [],
    removed: [],
    renamed: [],
    folders: [],
    finalId: null,
    finalFolder: null,
    warnings: [],
    ...overrides,
  };
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
    flushDraft: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    reset: vi.fn(),
    search: vi.fn(async () => []),
    waitUntilSearchReady: vi.fn(async () => true),
    rescan: vi.fn(),
    ...overrides,
  } as LocalNoteStore;
}

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

  it('sends editor save, rename, and content as one store operation', async () => {
    const save = vi.fn(async () =>
      mutation({
        removed: ['Old'],
        renamed: [{ from: 'Old', to: 'New' }],
        upserted: [upsert('New')],
        finalId: 'New',
      }),
    );
    _setLocalNoteStoreForTest(fakeStore({ save }));

    await updateNote('New', 'ignored shell title', 'latest body', 'Old', 456);
    expect(save).toHaveBeenCalledWith('Old', 'New', 'latest body', 456);
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
    expect(storeSearch).toHaveBeenCalledWith('needle');
  });
});

// A4: the engine-owned readiness wait is bounded and a rejection cannot poison
// later searches. Each test loads a fresh module for clean initialization.
describe('search readiness (A4)', () => {
  async function freshModules() {
    vi.resetModules();
    const notes = await import('./notes.svelte');
    const ln = await import('$lib/localNoteStore');
    return { notes, ln };
  }

  function bootstrapResult(notes: LocalNoteMetadata[] = []) {
    return { snapshot: { notes, folders: [] }, seeded: 0, migrated: 0, warnings: [] };
  }

  it('passes the configured budget to the engine wait and degrades when it reports not-ready', async () => {
    const { notes, ln } = await freshModules();
    notes._setSearchReadyTimeoutForTest(60);
    const waitUntilSearchReady = vi.fn(async () => false);
    ln._setLocalNoteStoreForTest(
      fakeStore({
        bootstrap: vi.fn(async () => bootstrapResult()),
        waitUntilSearchReady,
        search: vi.fn(async () => []),
      }),
    );
    await notes.initNotes();

    await expect(notes.search('needle')).resolves.toEqual([]);
    expect(waitUntilSearchReady).toHaveBeenCalledWith(60);
  });

  it('survives a rejected readiness wait without poisoning search', async () => {
    const { notes, ln } = await freshModules();
    ln._setLocalNoteStoreForTest(
      fakeStore({
        bootstrap: vi.fn(async () => bootstrapResult([metadata('X', 'body')])),
        waitUntilSearchReady: vi.fn(async () => {
          throw new Error('transient wait failure');
        }),
        search: vi.fn(async () => [{ noteId: 'X', score: 1, source: 'keyword' }]),
      }),
    );
    await notes.initNotes();

    const results = await notes.search('q');
    expect(results.map((item) => item.note.id)).toEqual(['X']);
  });
});

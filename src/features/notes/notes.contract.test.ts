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
  type LocalFlushDraftResult,
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

function flushResult(
  kind: LocalFlushDraftResult['disposition']['kind'],
  resultMutation: LocalNoteMutation | null,
  parkedId = 'Note (conflict 2026-07-29)',
): LocalFlushDraftResult {
  return {
    disposition: kind === 'parkedConflict' ? { kind, parkedId } : { kind },
    mutation: resultMutation,
  };
}

function preview(id: string): NotePreview {
  return { id, title: id, preview: '', modificationTime: 1, tags: [] };
}

/** `updateNote` hands its mutation back unprojected; this is the caller's half. */
function projectAsCallerWould(result: { mutation: LocalNoteMutation | null }): void {
  if (result.mutation) _applyLocalMutation(result.mutation);
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

// eslint-disable-next-line max-lines-per-function -- One contract matrix covers every mutation projection and draft disposition.
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

  it.each([
    ['wrote', 'wrote'],
    ['recreated', 'recreated'],
  ] as const)('projects a %s body flush and reports it committed', async (kind, disposition) => {
    const committed = mutation({ upserted: [upsert('Note')], finalId: 'Note' });
    const flushDraft = vi.fn(async () => flushResult(kind, committed));
    const save = vi.fn();
    _setLocalNoteStoreForTest(fakeStore({ flushDraft, save }));

    const result = await updateNote('Note', 'ignored shell title', 'latest body', {
      originalId: 'Note',
      base: 'saved body',
    });

    expect(result).toMatchObject({ id: 'Note', disposition, mutation: committed });
    expect(flushDraft).toHaveBeenCalledWith('Note', 'saved body', 'latest body');
    expect(save).not.toHaveBeenCalled();
    projectAsCallerWould(result);
    expect(getAllNotes().map((note) => note.id)).toEqual(['Note']);
  });

  it('reports convergence without projecting a mutation', async () => {
    setNotesUniverse([preview('Note')]);
    const flushDraft = vi.fn(async () => flushResult('converged', null));
    _setLocalNoteStoreForTest(fakeStore({ flushDraft }));

    await expect(
      updateNote('Note', 'ignored shell title', 'same body', {
        originalId: 'Note',
        base: 'saved body',
      }),
    ).resolves.toMatchObject({ id: 'Note', disposition: 'converged' });

    expect(getAllNotes().map((note) => note.id)).toEqual(['Note']);
  });

  it('projects a parked conflict copy without retargeting the original note', async () => {
    setNotesUniverse([preview('Note')]);
    const parkedId = 'Note (conflict 2026-07-29)';
    const parked = mutation({ upserted: [upsert(parkedId, 1)], finalId: parkedId });
    const flushDraft = vi.fn(async () => flushResult('parkedConflict', parked, parkedId));
    _setLocalNoteStoreForTest(fakeStore({ flushDraft }));

    const result = await updateNote('Note', 'ignored shell title', 'my draft', {
      originalId: 'Note',
      base: 'saved body',
    });

    expect(result).toMatchObject({ id: 'Note', disposition: 'parked', parkedId });
    projectAsCallerWould(result);
    expect(getAllNotes().map((note) => note.id)).toEqual(['Note', parkedId]);
  });

  it('saves a rename as one store workflow', async () => {
    const renamed = mutation({
      removed: ['Old'],
      renamed: [{ from: 'Old', to: 'New' }],
      upserted: [upsert('New')],
      finalId: 'New',
    });
    const flushDraft = vi.fn();
    const move = vi.fn();
    const save = vi.fn(async () => renamed);
    _setLocalNoteStoreForTest(fakeStore({ flushDraft, move, save }));

    await expect(
      updateNote('New', 'ignored shell title', 'latest body', {
        originalId: 'Old',
        base: 'saved body',
      }),
    ).resolves.toMatchObject({ id: 'New', disposition: 'wrote' });

    expect(save).toHaveBeenCalledExactlyOnceWith('Old', 'New', 'latest body', undefined);
    expect(flushDraft).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it('keeps override-mtime saves on the unconditional store verb', async () => {
    const save = vi.fn(async () => mutation({ upserted: [upsert('Note')], finalId: 'Note' }));
    const flushDraft = vi.fn();
    _setLocalNoteStoreForTest(fakeStore({ save, flushDraft }));

    await updateNote('Note', 'ignored shell title', 'restored body', {
      originalId: 'Note',
      base: 'saved body',
      overrideMtime: 456,
    });

    expect(save).toHaveBeenCalledWith('Note', 'Note', 'restored body', 456);
    expect(flushDraft).not.toHaveBeenCalled();
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

// The notes readiness promise is module-scoped, so these suites load a fresh
// module per test for clean initialization.
async function freshModules() {
  vi.resetModules();
  const notes = await import('./notes.svelte');
  const ln = await import('$lib/localNoteStore');
  return { notes, ln };
}

function bootstrapResult(notes: LocalNoteMetadata[] = []) {
  return { snapshot: { notes, folders: [] }, seeded: 0, migrated: 0, warnings: [] };
}

// A4: the engine-owned readiness wait is bounded and a rejection cannot poison
// later searches.
describe('search readiness (A4)', () => {
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

// #33: a failed startup bootstrap must still settle the readiness promise, or
// every awaiter (tab hydration → hash routing) hangs forever.
describe('notes readiness settles on bootstrap failure (#33)', () => {
  it('resolves whenNotesReady as ready after a successful init', async () => {
    const { notes, ln } = await freshModules();
    ln._setLocalNoteStoreForTest(fakeStore({ bootstrap: vi.fn(async () => bootstrapResult()) }));

    await notes.initNotes();

    await expect(notes.whenNotesReady()).resolves.toBe('ready');
  });

  it('rejects initNotes and settles whenNotesReady as failed when bootstrap rejects', async () => {
    const { notes, ln } = await freshModules();
    ln._setLocalNoteStoreForTest(
      fakeStore({
        bootstrap: vi.fn(async () => {
          throw new Error('vault scan failed');
        }),
      }),
    );

    await expect(notes.initNotes()).rejects.toThrow('vault scan failed');

    // Before the fix this hung forever (the promise never settled).
    await expect(notes.whenNotesReady()).resolves.toBe('failed');
  });
});

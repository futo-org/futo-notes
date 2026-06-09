import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('$lib/platform');
// Spy on the Rust-engine shim so we can assert mutations keep it fresh.
// engineQuery/engineStatus default to undefined here, which is falsy, so
// search() cleanly falls through to MiniSearch — matching the !isTauri path.
vi.mock('./searchEngine', () => ({
  engineNotify: vi.fn(async () => {}),
  engineQuery: vi.fn(async () => null),
  engineStatus: vi.fn(async () => null),
  engineRebuild: vi.fn(async () => {}),
  isEngineAvailable: vi.fn(() => false),
}));

import { testFS } from '$lib/platform';
import { engineNotify } from './searchEngine';

const notify = engineNotify as unknown as ReturnType<typeof vi.fn>;

// notes.svelte.ts holds module-level state; reset modules for a clean cache.
async function freshNotes() {
  vi.resetModules();
  return import('./notes.svelte');
}

beforeEach(() => {
  testFS._reset();
  notify.mockClear();
});

afterAll(() => {
  testFS._cleanup();
});

describe('search engine staleness: local mutations notify the Rust engine', () => {
  it('createNote notifies a change for the new note', async () => {
    const { initNotes, createNote } = await freshNotes();
    await initNotes();
    notify.mockClear();

    await createNote('fresh-note', '# Fresh\nbody');

    expect(notify).toHaveBeenCalledWith('change', 'fresh-note.md');
  });

  it('updateNote (content edit) notifies a change', async () => {
    await testFS.writeNote('edit-me', 'old body');
    const { initNotes, updateNote } = await freshNotes();
    await initNotes();
    notify.mockClear();

    await updateNote('edit-me', 'Edit Me', 'new body', 'edit-me');

    expect(notify).toHaveBeenCalledWith('change', 'edit-me.md');
  });

  it('updateNote (rename) notifies change for the new path and unlink for the old', async () => {
    await testFS.writeNote('old-name', 'content');
    const { initNotes, updateNote } = await freshNotes();
    await initNotes();
    notify.mockClear();

    await updateNote('new-name', 'New Name', 'content', 'old-name');

    const calls = notify.mock.calls;
    expect(calls).toContainEqual(['change', 'new-name.md']);
    expect(calls).toContainEqual(['unlink', 'old-name.md']);
  });

  it('deleteNote notifies an unlink', async () => {
    await testFS.writeNote('doomed', 'goodbye');
    const { initNotes, deleteNote } = await freshNotes();
    await initNotes();
    notify.mockClear();

    await deleteNote('doomed');

    expect(notify).toHaveBeenCalledWith('unlink', 'doomed.md');
  });

  it('moveNote notifies a rename from old → new path', async () => {
    await testFS.writeNote('A/note', 'body');
    const { initNotes, moveNote } = await freshNotes();
    await initNotes();
    notify.mockClear();

    await moveNote('A/note', 'B/note');

    expect(notify).toHaveBeenCalledWith('rename', 'B/note.md', 'A/note.md');
  });

  it('wikilink rewrite during a move notifies a change for the rewritten note', async () => {
    await testFS.writeNote('Specs/folder-support', '# Folder support');
    await testFS.writeNote('Other/note', 'see [[Specs/folder-support]] for details');
    const { initNotes, moveNote } = await freshNotes();
    await initNotes();
    notify.mockClear();

    await moveNote('Specs/folder-support', 'Specs/folders');

    // The other note's wikilink body changed → engine must be told.
    expect(notify.mock.calls).toContainEqual(['change', 'Other/note.md']);
  });
});

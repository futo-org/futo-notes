import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

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
  return import('$lib/notes.svelte');
}

beforeEach(() => {
  testFS._reset();
  notify.mockClear();
});

afterAll(() => {
  testFS._cleanup();
});

// Warm the module-transform cache before any timed test runs (PKT-20): see
// src/lib/notes.test.ts for why this must happen outside the test timer, and
// for why the explicit timeout below is needed (default hookTimeout is 10s;
// this hook absorbs an unbounded one-time transform cost, observed 5-15s+
// under CI load).
beforeAll(async () => {
  await freshNotes();
}, 120_000);

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

  it('updateNote (rename) re-keys the old path to the new one and notifies its change', async () => {
    await testFS.writeNote('old-name', 'content');
    const { initNotes, updateNote } = await freshNotes();
    await initNotes();
    notify.mockClear();

    await updateNote('new-name', 'New Name', 'content', 'old-name');

    // The title rename now goes through the atomic domain rename (like
    // drag-drop): a single `rename` re-keys old → new in the index, then the
    // body write notifies a `change` for the new path — keeping the Rust
    // engine as fresh as the old write-new + unlink-old pair did.
    const calls = notify.mock.calls;
    expect(calls).toContainEqual(['rename', 'new-name.md', 'old-name.md']);
    expect(calls).toContainEqual(['change', 'new-name.md']);
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

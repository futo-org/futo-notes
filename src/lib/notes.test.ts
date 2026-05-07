import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('$lib/platform');
vi.mock('./rustCore');

import { testFS } from '$lib/platform';

// notes.svelte.ts has module-level state (initialized, notesCache). Use resetModules to get fresh state.
async function freshNotes() {
  vi.resetModules();
  return import('./notes.svelte');
}

beforeEach(() => {
  testFS._reset();
});

afterAll(() => {
  testFS._cleanup();
});

describe('initNotes', () => {
  // Bumped timeout: this test imports the full notes module (~5s on slow CI
  // runners under load). Default 5s puts us right at the cliff.
  it('rebuilds cache from files on disk', async () => {
    await testFS.writeNote('hello-world', '# Hello World\nThis is content');
    await testFS.writeNote('second-note', '# Second\nMore content');

    const { initNotes, getAllNotes } = await freshNotes();
    await initNotes();

    const notes = getAllNotes();
    expect(notes).toHaveLength(2);
    const ids = notes.map((n) => n.id).sort();
    expect(ids).toEqual(['hello-world', 'second-note']);
  }, 15000);

  it('is idempotent', async () => {
    await testFS.writeNote('test', 'content');

    const { initNotes, getAllNotes } = await freshNotes();
    await initNotes();
    await initNotes(); // second call should be no-op

    expect(getAllNotes()).toHaveLength(1);
  });
});

describe('createNote', () => {
  it('writes file and adds to cache', async () => {
    const { initNotes, createNote, getAllNotes } = await freshNotes();
    await initNotes();

    const result = await createNote('My Note', '# My Note\nContent here');
    expect(result.id).toBe('My Note');
    expect(result.mtime).toBeGreaterThan(0);

    // Should be in cache
    const notes = getAllNotes();
    expect(notes.find((n) => n.id === 'My Note')).toBeDefined();

    // Should be on disk
    const content = await testFS.readNote('My Note');
    expect(content).toBe('# My Note\nContent here');
  });

  it('generates unique id on conflict', async () => {
    await testFS.writeNote('My Note', 'existing');

    const { initNotes, createNote } = await freshNotes();
    await initNotes();

    const result = await createNote('My Note', 'new content');
    expect(result.id).toBe('My Note-2');
  });
});

describe('updateNote', () => {
  it('updates content and cache', async () => {
    await testFS.writeNote('test', 'old content');

    const { initNotes, updateNote, getNoteById, readNote } = await freshNotes();
    await initNotes();

    await updateNote('test', 'Test', 'new content', 'test');
    const note = getNoteById('test');
    expect(note).toBeDefined();
    expect(note!.preview).toBe('new content');

    const content = await readNote('test');
    expect(content).toBe('new content');
  });

  it('handles rename (deletes old, writes new)', async () => {
    await testFS.writeNote('old-name', 'content');

    const { initNotes, updateNote, getNoteById } = await freshNotes();
    await initNotes();

    const result = await updateNote('new-name', 'New Name', 'updated content', 'old-name');
    expect(result.id).toBe('new-name');

    // Old file should be gone
    expect(await testFS.noteExists('old-name')).toBe(false);
    // New file should exist
    expect(await testFS.noteExists('new-name')).toBe(true);

    // Cache should have new, not old
    expect(getNoteById('old-name')).toBeUndefined();
    expect(getNoteById('new-name')).toBeDefined();
  });
});

describe('deleteNote', () => {
  it('removes file and cache', async () => {
    await testFS.writeNote('doomed', 'goodbye');

    const { initNotes, deleteNote, getNoteById } = await freshNotes();
    await initNotes();
    expect(getNoteById('doomed')).toBeDefined();

    await deleteNote('doomed');

    expect(getNoteById('doomed')).toBeUndefined();
    expect(await testFS.noteExists('doomed')).toBe(false);
  });
});

describe('getAllNotes / getNoteById', () => {
  it('returns notes sorted by modification time descending', async () => {
    await testFS.writeNote('older', 'old content', 1000000000000);
    await testFS.writeNote('newer', 'new content', 2000000000000);

    const { initNotes, getAllNotes } = await freshNotes();
    await initNotes();

    const notes = getAllNotes();
    expect(notes[0].id).toBe('newer');
    expect(notes[1].id).toBe('older');
  });

  it('getNoteById finds by id', async () => {
    await testFS.writeNote('findme', 'here I am');

    const { initNotes, getNoteById } = await freshNotes();
    await initNotes();

    const note = getNoteById('findme');
    expect(note).toBeDefined();
    expect(note!.id).toBe('findme');
  });

  it('getNoteById returns undefined for missing', async () => {
    const { initNotes, getNoteById } = await freshNotes();
    await initNotes();

    expect(getNoteById('nonexistent')).toBeUndefined();
  });

  it('newly created note appears at position 0', async () => {
    await testFS.writeNote('existing-a', 'content a', 1000000000000);
    await testFS.writeNote('existing-b', 'content b', 1500000000000);

    const { initNotes, createNote, getAllNotes } = await freshNotes();
    await initNotes();

    await createNote('brand-new', 'fresh content');

    const notes = getAllNotes();
    expect(notes[0].id).toBe('brand-new');
  });

  it('editing a note not at position 0 moves it to position 0', async () => {
    await testFS.writeNote('oldest', 'oldest content', 1000000000000);
    await testFS.writeNote('middle', 'middle content', 1400000000000);
    await testFS.writeNote('newest', 'newest content', 1700000000000);

    const { initNotes, updateNote, getAllNotes } = await freshNotes();
    await initNotes();

    const before = getAllNotes();
    const originalIndex = before.findIndex((n) => n.id === 'oldest');
    expect(originalIndex).not.toBe(0);

    await updateNote('oldest', 'Oldest', 'updated content', 'oldest');

    const after = getAllNotes();
    const newIndex = after.findIndex((n) => n.id === 'oldest');
    expect(newIndex).toBe(0);
    expect(newIndex).not.toBe(originalIndex);
    expect(newIndex).not.toBe(originalIndex + 1);
  });
});

describe('search', () => {
  it('returns all notes for empty query', async () => {
    await testFS.writeNote('one', 'first note');
    await testFS.writeNote('two', 'second note');

    const { initNotes, search } = await freshNotes();
    await initNotes();

    const results = await search('');
    expect(results).toHaveLength(2);
    // Each result should have note and snippet
    expect(results[0].note).toBeDefined();
    expect(results[0].snippet).toBeNull();
  });

  it('filters for non-empty query', async () => {
    await testFS.writeNote('alpha', 'uniqueword123 in this note');
    await testFS.writeNote('beta', 'something else entirely');

    const { initNotes, search } = await freshNotes();
    await initNotes();

    const results = await search('uniqueword123');
    expect(results).toHaveLength(1);
    expect(results[0].note.id).toBe('alpha');
  });

  it('matches against note id', async () => {
    await testFS.writeNote('banana-recipe', 'This is about cooking');
    await testFS.writeNote('grocery-list', 'eggs, milk, bread');

    const { initNotes, search } = await freshNotes();
    await initNotes();

    const results = await search('banana');
    expect(results).toHaveLength(1);
    expect(results[0].note.id).toBe('banana-recipe');
  });

  it('returns empty results when index is populated but query has no matches', async () => {
    // createNote populates the search index via addToSearchIndex,
    // so the index is populated after this call
    const { initNotes, createNote, search } = await freshNotes();
    await initNotes();

    await createNote('real-note', 'this is about apples and oranges');

    // Search for something that doesn't match — should return empty,
    // NOT fall through to substring search
    const results = await search('zzzznonexistent');
    expect(results).toHaveLength(0);
  });

  it('finds existing notes by body content after startup (no creations yet)', async () => {
    // Regression: before the search-index bootstrap fix, pre-existing notes
    // were only in notesCache, not in the MiniSearch index. A new note
    // would flip isSearchIndexPopulated() to true and all pre-existing
    // notes became invisible to body-text search.
    await testFS.writeNote('pre-existing-a', 'content contains zebraword123');
    await testFS.writeNote('pre-existing-b', 'content contains whaleword456');

    const { initNotes, search, createNote } = await freshNotes();
    await initNotes();

    // Create a brand-new note — this used to make pre-existing notes unsearchable.
    await createNote('new-note', 'boring content');

    const results = await search('zebraword123');
    expect(results).toHaveLength(1);
    expect(results[0].note.id).toBe('pre-existing-a');
  });

  it('removes deleted notes from search index', async () => {
    await testFS.writeNote('will-delete', 'this has ghostword789');

    const { initNotes, deleteNote, search } = await freshNotes();
    await initNotes();

    // Sanity: findable before delete
    let results = await search('ghostword789');
    expect(results).toHaveLength(1);

    await deleteNote('will-delete');

    results = await search('ghostword789');
    expect(results).toHaveLength(0);
  });

  it('removes renamed id from search index and finds under new id', async () => {
    await testFS.writeNote('old-id', 'content has phoenixword321');

    const { initNotes, updateNote, search } = await freshNotes();
    await initNotes();

    await updateNote('new-id', 'New Id', 'content has phoenixword321', 'old-id');

    const results = await search('phoenixword321');
    expect(results).toHaveLength(1);
    expect(results[0].note.id).toBe('new-id');
  });
});

describe('folder support: path-as-ID', () => {
  it('treats nested files as path-IDs end-to-end', async () => {
    await testFS.writeNote('Specs/folder-support', '# Folder support\nbody');
    await testFS.writeNote('flat', 'flat body');

    const { initNotes, getAllNotes, getNoteById } = await freshNotes();
    await initNotes();

    const ids = getAllNotes().map((n) => n.id).sort();
    expect(ids).toEqual(['Specs/folder-support', 'flat']);

    const nested = getNoteById('Specs/folder-support');
    expect(nested).toBeDefined();
    expect(nested?.preview).toContain('Folder support');
  });

  it('moveNote rewrites wikilinks in other notes', async () => {
    await testFS.writeNote('Specs/folder-support', '# Folder support');
    await testFS.writeNote('Other/note', 'see [[Specs/folder-support]] for details');

    const { initNotes, moveNote, search, readNote } = await freshNotes();
    await initNotes();

    await moveNote('Specs/folder-support', 'Specs/folders');

    const body = await readNote('Other/note');
    expect(body).toBe('see [[Specs/folders]] for details');

    // Search index should still find the relocated note's content
    const hits = await search('Folder support');
    expect(hits.some((h) => h.note.id === 'Specs/folders')).toBe(true);
  });

  it('moveNote rewrites legacy bare-filename wikilinks when unique', async () => {
    await testFS.writeNote('Specs/folder-support', '# Folder support');
    await testFS.writeNote('Other/note', 'see [[folder-support]] for details');

    const { initNotes, moveNote, readNote } = await freshNotes();
    await initNotes();

    await moveNote('Specs/folder-support', 'Specs/folders');

    const body = await readNote('Other/note');
    expect(body).toBe('see [[Specs/folders]] for details');
  });

  it('moveNote does not rewrite ambiguous bare-filename wikilinks', async () => {
    await testFS.writeNote('A/grocery', '# A grocery');
    await testFS.writeNote('B/grocery', '# B grocery');
    await testFS.writeNote('top', 'shop [[grocery]] today');

    const { initNotes, moveNote, readNote } = await freshNotes();
    await initNotes();

    await moveNote('A/grocery', 'A/store');

    const body = await readNote('top');
    expect(body).toBe('shop [[grocery]] today');
  });

  it('moveNote suffixes the incoming file when target ID already exists', async () => {
    // Spec § Sync conflict resolution: "Move into a folder where filename
    // already exists → reuse `getUniqueNoteId` to suffix the incoming file"
    await testFS.writeNote('A/note', 'first');
    await testFS.writeNote('B/note', 'second');

    const { initNotes, moveNote, getAllNotes } = await freshNotes();
    await initNotes();

    const result = await moveNote('B/note', 'A/note');
    expect(result.id).not.toBe('A/note'); // would have collided
    expect(result.id.startsWith('A/')).toBe(true);

    const ids = getAllNotes().map((n) => n.id).sort();
    expect(ids).toContain('A/note');
    expect(ids).toContain(result.id);
  });

  it('moveNotesUnderPrefix relocates every nested note', async () => {
    await testFS.writeNote('Specs/a', 'a body');
    await testFS.writeNote('Specs/sub/b', 'b body');
    await testFS.writeNote('top', 'top body');

    const { initNotes, moveNotesUnderPrefix, getAllNotes } = await freshNotes();
    await initNotes();

    await moveNotesUnderPrefix('Specs', 'Designs');

    const ids = getAllNotes().map((n) => n.id).sort();
    expect(ids).toContain('Designs/a');
    expect(ids).toContain('Designs/sub/b');
    expect(ids).toContain('top');
    expect(ids).not.toContain('Specs/a');
    expect(ids).not.toContain('Specs/sub/b');
  });

  it('moveNotesUnderPrefix is idempotent when fs.renameFolder ran first', async () => {
    // Regression: production flow runs `fs.renameFolder` (which atomically
    // moves every contained file) BEFORE `moveNotesUnderPrefix`. The
    // earlier impl tried to `moveNote(oldId, newId)` per child and failed
    // because the source files had already been moved — leaving notesCache
    // stuck at stale IDs and breaking note-open after drag-drop.
    await testFS.writeNote('Specs/a', 'a body');
    await testFS.writeNote('Specs/sub/b', 'see [[Specs/a]]');

    const { initNotes, moveNotesUnderPrefix, getAllNotes, readNote } = await freshNotes();
    await initNotes();

    // Caller-side rename (DrawerSidebar path).
    await testFS.renameFolder('Specs', 'Designs');
    // Now reconcile in-memory state. Must not throw, must end with new IDs.
    await moveNotesUnderPrefix('Specs', 'Designs');

    const ids = getAllNotes().map((n) => n.id).sort();
    expect(ids).toEqual(['Designs/a', 'Designs/sub/b']);

    // Wikilink targeting the old ID should have been rewritten.
    const body = await readNote('Designs/sub/b');
    expect(body).toContain('[[Designs/a]]');
    expect(body).not.toContain('[[Specs/a]]');
  });
});

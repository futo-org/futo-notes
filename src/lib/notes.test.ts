import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('$lib/platform');
vi.mock('./syncState');

import { testFS } from '$lib/platform';
import { markLocalDeleteForSync, trackLocalRenameForSync } from './syncState';

const mockMarkLocalDeleteForSync = vi.mocked(markLocalDeleteForSync);
const mockTrackLocalRenameForSync = vi.mocked(trackLocalRenameForSync);

// notes.ts has module-level state (initialized, notesCache). Use resetModules to get fresh state.
async function freshNotes() {
  vi.resetModules();
  return import('./notes');
}

beforeEach(() => {
  testFS._reset();
  mockMarkLocalDeleteForSync.mockResolvedValue();
  mockTrackLocalRenameForSync.mockResolvedValue();
});

afterAll(() => {
  testFS._cleanup();
});

describe('initNotes', () => {
  it('rebuilds cache from files on disk', async () => {
    await testFS.writeNote('hello-world', '# Hello World\nThis is content');
    await testFS.writeNote('second-note', '# Second\nMore content');

    const { initNotes, getAllNotes } = await freshNotes();
    await initNotes();

    const notes = getAllNotes();
    expect(notes).toHaveLength(2);
    const ids = notes.map((n) => n.id).sort();
    expect(ids).toEqual(['hello-world', 'second-note']);
  });

  it('is idempotent', async () => {
    await testFS.writeNote('test', 'content');

    const { initNotes, getAllNotes } = await freshNotes();
    await initNotes();
    await initNotes(); // second call should be no-op

    expect(getAllNotes()).toHaveLength(1);
  });

  it('populates search index', async () => {
    await testFS.writeNote('searchable', 'unique-keyword-xyz');

    const { initNotes, search } = await freshNotes();
    await initNotes();

    const results = search('unique-keyword-xyz');
    expect(results).toHaveLength(1);
    expect(results[0].note.id).toBe('searchable');
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

  it('handles rename (deletes old, writes new, tracks in syncState)', async () => {
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

    // Should have tracked the rename
    expect(mockTrackLocalRenameForSync).toHaveBeenCalledWith('old-name', 'new-name');
  });
});

describe('deleteNote', () => {
  it('removes file, cache, and search index; tracks in syncState by default', async () => {
    await testFS.writeNote('doomed', 'goodbye');

    const { initNotes, deleteNote, getNoteById, search } = await freshNotes();
    await initNotes();
    expect(getNoteById('doomed')).toBeDefined();

    await deleteNote('doomed');

    expect(getNoteById('doomed')).toBeUndefined();
    expect(await testFS.noteExists('doomed')).toBe(false);
    expect(search('goodbye')).toHaveLength(0);
    expect(mockMarkLocalDeleteForSync).toHaveBeenCalledWith('doomed');
  });

  it('skips sync tracking when trackSyncDelete: false', async () => {
    await testFS.writeNote('synced', 'content');

    const { initNotes, deleteNote } = await freshNotes();
    await initNotes();

    await deleteNote('synced', { trackSyncDelete: false });

    expect(mockMarkLocalDeleteForSync).not.toHaveBeenCalled();
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
});

describe('search', () => {
  it('returns all notes for empty query', async () => {
    await testFS.writeNote('one', 'first note');
    await testFS.writeNote('two', 'second note');

    const { initNotes, search } = await freshNotes();
    await initNotes();

    const results = search('');
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

    const results = search('uniqueword123');
    expect(results).toHaveLength(1);
    expect(results[0].note.id).toBe('alpha');
  });

  it('returns results in relevance order, not mtime order', async () => {
    const now = Date.now();
    const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;
    // Create an older note with a strong title match
    await testFS.writeNote('banana-recipe', 'This is about cooking bananas. Banana bread is great.', sixtyDaysAgo);
    // Create a newer note that barely mentions banana
    await testFS.writeNote('grocery-list', 'eggs, milk, banana, bread', oneDayAgo);

    const { initNotes, search } = await freshNotes();
    await initNotes();

    const results = search('banana');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The note with banana in the title should rank higher despite being older
    expect(results[0].note.id).toBe('banana-recipe');
  });

  it('returns snippets with highlight segments', async () => {
    await testFS.writeNote('test-note', 'Some text before the keyword specialterm right here and more after');

    const { initNotes, search } = await freshNotes();
    await initNotes();

    const results = search('specialterm');
    expect(results).toHaveLength(1);
    expect(results[0].snippet).not.toBeNull();

    // The snippet should contain highlighted segments
    const highlighted = results[0].snippet!.filter((s) => s.highlight);
    expect(highlighted.length).toBeGreaterThan(0);
    expect(highlighted[0].text.toLowerCase()).toContain('specialterm');
  });
});

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
    expect(results[0].id).toBe('searchable');
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
  });

  it('filters for non-empty query', async () => {
    await testFS.writeNote('alpha', 'uniqueword123 in this note');
    await testFS.writeNote('beta', 'something else entirely');

    const { initNotes, search } = await freshNotes();
    await initNotes();

    const results = search('uniqueword123');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('alpha');
  });
});

describe('handleExternalFileChange', () => {
  it('add — adds new note to cache and search index', async () => {
    const { initNotes, handleExternalFileChange, getNoteById, search } = await freshNotes();
    await initNotes();

    // Write a new file after init (simulating external file drop)
    await testFS.writeNote('new-note', 'xyztestkeyword789');

    const result = await handleExternalFileChange('add', 'new-note.md');
    expect(result).toBeDefined();
    expect(result!.id).toBe('new-note');
    expect(getNoteById('new-note')).toBeDefined();
    expect(search('xyztestkeyword789')).toHaveLength(1);
  });

  it('change — updates existing note in cache', async () => {
    await testFS.writeNote('existing', 'original content');

    const { initNotes, handleExternalFileChange, getNoteById } = await freshNotes();
    await initNotes();
    expect(getNoteById('existing')!.preview).toBe('original content');

    // Overwrite file content externally
    await testFS.writeNote('existing', 'updated external content');

    await handleExternalFileChange('change', 'existing.md');
    expect(getNoteById('existing')!.preview).toBe('updated external content');
  });

  it('unlink — removes note from cache and search', async () => {
    await testFS.writeNote('doomed', 'searchable-keyword-abc');

    const { initNotes, handleExternalFileChange, getNoteById, search } = await freshNotes();
    await initNotes();
    expect(getNoteById('doomed')).toBeDefined();
    expect(search('searchable-keyword-abc')).toHaveLength(1);

    await handleExternalFileChange('unlink', 'doomed.md');
    expect(getNoteById('doomed')).toBeUndefined();
    expect(search('searchable-keyword-abc')).toHaveLength(0);
  });

  it('add — handles read failure gracefully', async () => {
    const { initNotes, handleExternalFileChange } = await freshNotes();
    await initNotes();

    // File doesn't exist on disk — should return null, not throw
    const result = await handleExternalFileChange('add', 'nonexistent.md');
    expect(result).toBeNull();
  });

  it('does not write to disk', async () => {
    await testFS.writeNote('readonly-test', 'original disk content');

    const { initNotes, handleExternalFileChange } = await freshNotes();
    await initNotes();

    // Trigger add for existing file
    await handleExternalFileChange('add', 'readonly-test.md');

    // Verify file content unchanged
    const content = await testFS.readNote('readonly-test');
    expect(content).toBe('original disk content');
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

const autoSyncMocks = vi.hoisted(() => ({
  events: [] as string[],
  pauseSyncV2: vi.fn(),
  resumeSyncV2: vi.fn(),
  waitForSyncIdleV2: vi.fn(),
}));

const e2eeMocks = vi.hoisted(() => ({
  stopLiveSync: vi.fn(),
  disconnectE2ee: vi.fn(),
}));

vi.mock('$lib/platform');
vi.mock('./autoSyncV2', () => ({
  pauseSyncV2: autoSyncMocks.pauseSyncV2,
  resumeSyncV2: autoSyncMocks.resumeSyncV2,
  waitForSyncIdleV2: autoSyncMocks.waitForSyncIdleV2,
}));
vi.mock('./syncServiceE2ee', () => ({
  stopLiveSync: e2eeMocks.stopLiveSync,
  disconnectE2ee: e2eeMocks.disconnectE2ee,
}));

import { testFS } from '$lib/platform';

// notes.svelte.ts has module-level state (initialized, notesCache). Use resetModules to get fresh state.
async function freshNotes() {
  vi.resetModules();
  return import('./notes.svelte');
}

beforeEach(() => {
  testFS._reset();
  autoSyncMocks.events = [];
  autoSyncMocks.pauseSyncV2.mockReset();
  autoSyncMocks.resumeSyncV2.mockReset();
  autoSyncMocks.waitForSyncIdleV2.mockReset();
  e2eeMocks.stopLiveSync.mockReset();
  e2eeMocks.disconnectE2ee.mockReset();
  autoSyncMocks.pauseSyncV2.mockImplementation(() => {
    autoSyncMocks.events.push('pause');
  });
  autoSyncMocks.resumeSyncV2.mockImplementation(() => {
    autoSyncMocks.events.push('resume');
  });
  autoSyncMocks.waitForSyncIdleV2.mockImplementation(async () => {
    autoSyncMocks.events.push('wait-idle');
  });
  e2eeMocks.stopLiveSync.mockImplementation(async () => {
    autoSyncMocks.events.push('stop-live');
  });
  e2eeMocks.disconnectE2ee.mockImplementation(async () => {
    autoSyncMocks.events.push('disconnect');
  });
});

afterAll(() => {
  testFS._cleanup();
});

// Warm the module-transform cache before any timed test runs (PKT-20): the
// first `import('./notes.svelte')` after `vi.resetModules()` pays the full
// module-graph transform cost, which on a loaded CI runner blows straight
// through a 5s test timeout — and vi.resetModules() only clears the runtime
// module registry, not vite's underlying transform cache, so this warmup
// import makes every later freshNotes() call in this file cheap.
// Explicit generous timeout: this hook exists specifically to absorb a
// one-time vite transform of the notes module graph that is unbounded under
// CI load (observed 5-15s+) — the default 10s hookTimeout is not enough
// margin, and would abort the whole file before any test runs.
beforeAll(async () => {
  await freshNotes();
}, 120_000);

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
  }, 15000);

  it('is idempotent', async () => {
    await testFS.writeNote('test', 'content');

    const { initNotes, getAllNotes } = await freshNotes();
    await initNotes();
    await initNotes(); // second call should be no-op

    expect(getAllNotes()).toHaveLength(1);
  });
});

describe('deleteAllNotes', () => {
  it('stops live sync and disconnects before wiping the vault', async () => {
    await testFS.writeNote('reset-me', 'body');
    const realDeleteAllContent = testFS.deleteAllContent.bind(testFS);
    const deleteAllContentSpy = vi
      .spyOn(testFS, 'deleteAllContent')
      .mockImplementation(async () => {
        autoSyncMocks.events.push('delete-all');
        await realDeleteAllContent();
      });

    try {
      const { initNotes, deleteAllNotes, getAllNotes } = await freshNotes();
      await initNotes();

      await deleteAllNotes();

      expect(getAllNotes()).toEqual([]);
      expect(e2eeMocks.stopLiveSync).toHaveBeenCalledTimes(1);
      expect(e2eeMocks.disconnectE2ee).toHaveBeenCalledTimes(1);
      expect(autoSyncMocks.events).toEqual([
        'pause',
        'stop-live',
        'wait-idle',
        'disconnect',
        'delete-all',
        'resume',
      ]);
    } finally {
      deleteAllContentSpy.mockRestore();
    }
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

  // A3: a failed create must not leave a zero-byte orphan that later collides
  // (forcing a retry onto `-2`). Create writes content atomically — a failure
  // leaves nothing behind, so retrying the same title reuses the intended id.
  it('a failed create leaves no orphan and a retry keeps the intended id', async () => {
    const { initNotes, createNote } = await freshNotes();
    await initNotes();

    const spy = vi.spyOn(testFS, 'createNote').mockRejectedValue(new Error('ENOSPC'));
    await expect(createNote('Fresh', 'body')).rejects.toThrow();
    spy.mockRestore();

    expect(await testFS.noteExists('Fresh')).toBe(false);

    const retry = await createNote('Fresh', 'body');
    expect(retry.id).toBe('Fresh');
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

  // A2: a disk-write failure during a title-rename must not commit the rename
  // with the edit stranded. The current buffer is written to the EXISTING id
  // before the rename, so a failure leaves the note recoverable at its
  // original id (a retry converges) rather than renamed to a file holding
  // stale content with the cache/session pointing at a now-missing source.
  it('a failed write during a title-rename leaves the note recoverable at the original id', async () => {
    await testFS.writeNote('old-name', 'saved body');

    const { initNotes, updateNote } = await freshNotes();
    await initNotes();

    const spy = vi.spyOn(testFS, 'writeNote').mockRejectedValue(new Error('ENOSPC'));
    await expect(updateNote('new-name', 'New Name', 'edited body', 'old-name')).rejects.toThrow();
    spy.mockRestore();

    // The rename must NOT have committed: the note is still at the original id
    // (recoverable), not moved to 'new-name' holding stale content.
    expect(await testFS.noteExists('old-name')).toBe(true);
    expect(await testFS.noteExists('new-name')).toBe(false);

    // Arbitration of the A2 severity split (Codex HIGH "permanent loss via
    // retry" vs Claude LOW "transient"): drive the EXACT retry — the next save
    // with the same original id. With write-before-rename it converges to the
    // new id carrying the edit; the pre-fix rename-first order left the retry
    // renaming a vanished source (stuck). So the edit is recoverable, but ONLY
    // because of the fix — the reported failure was real, not transient.
    const retry = await updateNote('new-name', 'New Name', 'edited body', 'old-name');
    expect(retry.id).toBe('new-name');
    expect(await testFS.readNote('new-name')).toBe('edited body');
    expect(await testFS.noteExists('old-name')).toBe(false);
  });

  // C1: PKT-4/!66 keeps a dirty draft bound to originalId when the open note is
  // deleted externally (watcher/sync). If the title is ALSO dirty, the save
  // renames from a now-missing source. Write-before-rename recreates the source
  // from the kept buffer, then renames — so the draft survives and converges to
  // the new id (the rename-first order rejected or no-op'd on the missing source
  // and stranded the draft).
  it('a rename whose source was externally deleted recreates it from the draft and converges', async () => {
    await testFS.writeNote('old', 'original');

    const { initNotes, updateNote } = await freshNotes();
    await initNotes();

    // External delete: the file is gone from disk, but the editor still holds
    // the (now dirty) draft bound to 'old'.
    await testFS.deleteNoteFile('old');
    expect(await testFS.noteExists('old')).toBe(false);

    const result = await updateNote('new', 'New', 'kept draft body', 'old');
    expect(result.id).toBe('new');
    expect(await testFS.readNote('new')).toBe('kept draft body');
    expect(await testFS.noteExists('old')).toBe(false);
  });
});

describe('deleteNote', () => {
  afterEach(() => {
    delete (testFS as { deleteNoteToTrash?: unknown }).deleteNoteToTrash;
  });

  it('removes file and cache', async () => {
    await testFS.writeNote('doomed', 'goodbye');

    const { initNotes, deleteNote, getNoteById } = await freshNotes();
    await initNotes();
    expect(getNoteById('doomed')).toBeDefined();

    await deleteNote('doomed');

    expect(getNoteById('doomed')).toBeUndefined();
    expect(await testFS.noteExists('doomed')).toBe(false);
  });

  it('routes through deleteNoteToTrash instead of the hard-delete path when the platform provides it', async () => {
    await testFS.writeNote('doomed', 'goodbye');
    const trashSpy = vi.fn(async () => {});
    testFS.deleteNoteToTrash = trashSpy;
    const hardDeleteSpy = vi.spyOn(testFS, 'deleteNoteFile');

    const { initNotes, deleteNote, getNoteById } = await freshNotes();
    await initNotes();

    await deleteNote('doomed');

    expect(trashSpy).toHaveBeenCalledWith('doomed');
    expect(hardDeleteSpy).not.toHaveBeenCalled();
    expect(getNoteById('doomed')).toBeUndefined();
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

describe('handleExternalFileChange (F18: incremental, no full rescan)', () => {
  it('updates a single changed note without re-scanning the whole vault', async () => {
    await testFS.writeNote('alpha', 'alpha original body');
    await testFS.writeNote('beta', 'beta body untouched');

    const { initNotes, handleExternalFileChange, getNoteById } = await freshNotes();
    await initNotes();

    // Mutate alpha on disk (simulating an external/sync write), then deliver
    // the watcher event. Spy on scanNotes AFTER init so we only catch the
    // change-handling path.
    await testFS.writeNote('alpha', 'alpha NEW body changed externally');
    const scanSpy = vi.spyOn(testFS, 'scanNotes');

    const updated = await handleExternalFileChange('alpha.md');

    expect(scanSpy).not.toHaveBeenCalled(); // no full rescan
    expect(updated?.id).toBe('alpha');
    expect(getNoteById('alpha')?.preview).toContain('NEW body changed');
    // Untouched note is left exactly as-is.
    expect(getNoteById('beta')?.preview).toBe('beta body untouched');
    scanSpy.mockRestore();
  });

  it('removes a deleted note incrementally (no full rescan) and drops it from search', async () => {
    await testFS.writeNote('keep', 'keepword survives');
    await testFS.writeNote('gone', 'gone has vanishword111');

    const { initNotes, handleExternalFileChange, getNoteById, search } = await freshNotes();
    await initNotes();

    // Findable before the unlink.
    expect((await search('vanishword111')).length).toBe(1);

    await testFS.deleteNoteFile('gone');
    const scanSpy = vi.spyOn(testFS, 'scanNotes');

    const result = await handleExternalFileChange('gone.md');

    expect(scanSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(getNoteById('gone')).toBeUndefined();
    expect(getNoteById('keep')).toBeDefined();
    // No longer in the search index.
    expect((await search('vanishword111')).length).toBe(0);
    scanSpy.mockRestore();
  });

  it('adds a brand-new note that appeared externally, indexing it for search', async () => {
    await testFS.writeNote('existing', 'existing body');

    const { initNotes, handleExternalFileChange, getNoteById, search } = await freshNotes();
    await initNotes();

    // A new file lands on disk (external create / sync pull).
    await testFS.writeNote('appeared', 'appeared has freshword222');
    const scanSpy = vi.spyOn(testFS, 'scanNotes');

    const added = await handleExternalFileChange('appeared.md');

    expect(scanSpy).not.toHaveBeenCalled();
    expect(added?.id).toBe('appeared');
    expect(getNoteById('appeared')).toBeDefined();
    expect((await search('freshword222')).map((r) => r.note.id)).toContain('appeared');
    scanSpy.mockRestore();
  });

  it('re-derives the canonical preview/tags shape on an external change', async () => {
    await testFS.writeNote('tagnote', 'no tags yet');

    const { initNotes, handleExternalFileChange, getNoteById } = await freshNotes();
    await initNotes();

    await testFS.writeNote('tagnote', '#alpha #beta body with tags');
    const updated = await handleExternalFileChange('tagnote.md');

    // Tags match the Rust NoteMeta shape (lowercase, no leading '#').
    expect(updated?.tags.sort()).toEqual(['alpha', 'beta']);
    expect(getNoteById('tagnote')?.tags.sort()).toEqual(['alpha', 'beta']);
  });

  it('falls back to a full rescan when the incremental read throws', async () => {
    await testFS.writeNote('safe', 'safe body');

    const { initNotes, handleExternalFileChange, getNoteById } = await freshNotes();
    await initNotes();

    // Force the incremental path to throw on the existence probe, proving the
    // fallback keeps the cache coherent rather than stranding it.
    await testFS.writeNote('crashy', 'crashy body');
    const existsSpy = vi.spyOn(testFS, 'noteExists').mockRejectedValueOnce(new Error('boom'));
    const scanSpy = vi.spyOn(testFS, 'scanNotes');

    const result = await handleExternalFileChange('crashy.md');

    expect(existsSpy).toHaveBeenCalled();
    expect(scanSpy).toHaveBeenCalled(); // fell back to full rescan
    expect(result?.id).toBe('crashy');
    expect(getNoteById('crashy')).toBeDefined();
    existsSpy.mockRestore();
    scanSpy.mockRestore();
  });
});

describe('folder support: path-as-ID', () => {
  it('treats nested files as path-IDs end-to-end', async () => {
    await testFS.writeNote('Specs/folder-support', '# Folder support\nbody');
    await testFS.writeNote('flat', 'flat body');

    const { initNotes, getAllNotes, getNoteById } = await freshNotes();
    await initNotes();

    const ids = getAllNotes()
      .map((n) => n.id)
      .sort();
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

  it('updateNote rename rewrites self-referencing wikilinks in the renamed note', async () => {
    // Spec (editor.md): rename rewrites links across all notes AND
    // self-referencing links inside the renamed note's own body.
    await testFS.writeNote('groceries', 'see [[groceries]] from last week');

    const { initNotes, updateNote, readNote } = await freshNotes();
    await initNotes();

    await updateNote('shopping', 'shopping', 'see [[groceries]] from last week', 'groceries');

    const body = await readNote('shopping');
    expect(body).toBe('see [[shopping]] from last week');
  });

  it('moveNote rewrites self-referencing wikilinks in the moved note', async () => {
    await testFS.writeNote('grocery list', 'todo: [[grocery list]] again');

    const { initNotes, moveNote, readNote } = await freshNotes();
    await initNotes();

    await moveNote('grocery list', 'Lists/grocery list');

    const body = await readNote('Lists/grocery list');
    expect(body).toBe('todo: [[Lists/grocery list]] again');
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
    // already exists → the domain's collision probe suffixes the incoming file"
    await testFS.writeNote('A/note', 'first');
    await testFS.writeNote('B/note', 'second');

    const { initNotes, moveNote, getAllNotes } = await freshNotes();
    await initNotes();

    const result = await moveNote('B/note', 'A/note');
    expect(result.id).not.toBe('A/note'); // would have collided
    expect(result.id.startsWith('A/')).toBe(true);

    const ids = getAllNotes()
      .map((n) => n.id)
      .sort();
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

    const ids = getAllNotes()
      .map((n) => n.id)
      .sort();
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

    const ids = getAllNotes()
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(['Designs/a', 'Designs/sub/b']);

    // Wikilink targeting the old ID should have been rewritten.
    const body = await readNote('Designs/sub/b');
    expect(body).toContain('[[Designs/a]]');
    expect(body).not.toContain('[[Specs/a]]');
  });
});

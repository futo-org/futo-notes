import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, type TestEnv } from '../helpers/setup.js';
import { getDb } from '../../src/db/index.js';
import { reconcile } from '../../src/sync/recovery.js';
import { contentHash } from '../../src/sync/hash.js';
import { upsertNote, getNote, getAllNotes } from '../../src/db/notes.js';
import { writeNoteFile } from '../../src/sync/files.js';
import fs from 'node:fs';
import path from 'node:path';

describe('recovery / reconcile', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('removes DB entry when file is missing from disk', () => {
    const db = getDb();
    upsertNote(db, 'u1', 'gone.md', 'oldhash', Date.now());

    reconcile(db, env.notesDir);

    expect(getNote(db, 'u1')).toBeNull();
  });

  it('updates DB hash when file content changed on disk', () => {
    const db = getDb();
    const oldHash = contentHash('old');
    writeNoteFile(env.notesDir, 'note.md', 'old');
    upsertNote(db, 'u1', 'note.md', oldHash, Date.now());

    // Simulate crash — file updated but DB not
    fs.writeFileSync(path.join(env.notesDir, 'note.md'), 'new content', 'utf8');

    reconcile(db, env.notesDir);

    const note = getNote(db, 'u1');
    expect(note).not.toBeNull();
    expect(note!.content_hash).toBe(contentHash('new content'));
  });

  it('does not auto-adopt orphaned files (avoids UUID conflicts with client sync)', () => {
    const db = getDb();
    fs.mkdirSync(env.notesDir, { recursive: true });
    fs.writeFileSync(path.join(env.notesDir, 'orphan.md'), 'orphan content', 'utf8');

    reconcile(db, env.notesDir);

    // Orphaned files should NOT be added — they'll be adopted via sync with real client UUIDs
    const allNotes = getAllNotes(db);
    expect(allNotes).toHaveLength(0);
  });

  it('handles empty notes directory', () => {
    const db = getDb();
    reconcile(db, env.notesDir);
    expect(getAllNotes(db)).toEqual([]);
  });

  it('handles non-existent notes directory', () => {
    const db = getDb();
    reconcile(db, path.join(env.tmpDir, 'nonexistent'));
    expect(getAllNotes(db)).toEqual([]);
  });
});

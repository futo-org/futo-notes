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

  it('adopts orphaned files on disk with server-generated UUIDs', () => {
    const db = getDb();
    fs.mkdirSync(env.notesDir, { recursive: true });
    fs.writeFileSync(path.join(env.notesDir, 'orphan.md'), 'orphan content', 'utf8');

    reconcile(db, env.notesDir);

    const allNotes = getAllNotes(db);
    expect(allNotes).toHaveLength(1);
    expect(allNotes[0].filename).toBe('orphan.md');
    expect(allNotes[0].content_hash).toBe(contentHash('orphan content'));
    // UUID should be a valid v4 UUID
    expect(allNotes[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{3,4}-[0-9a-f]{12}$/);
  });

  it('adopts converted .txt files via reconcile', () => {
    const db = getDb();
    fs.mkdirSync(env.notesDir, { recursive: true });
    fs.writeFileSync(path.join(env.notesDir, 'imported.txt'), 'text file content', 'utf8');

    reconcile(db, env.notesDir);

    // .txt should have been converted to .md and adopted
    const allNotes = getAllNotes(db);
    expect(allNotes).toHaveLength(1);
    expect(allNotes[0].filename).toBe('imported.md');
    expect(allNotes[0].content_hash).toBe(contentHash('text file content'));

    // Original .txt should be gone from disk
    expect(fs.existsSync(path.join(env.notesDir, 'imported.txt'))).toBe(false);
    expect(fs.existsSync(path.join(env.notesDir, 'imported.md'))).toBe(true);
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

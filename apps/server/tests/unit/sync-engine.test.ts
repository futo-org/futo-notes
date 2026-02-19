import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, type TestEnv } from '../helpers/setup.js';
import { getDb } from '../../src/db/index.js';
import { processSync } from '../../src/sync/engine.js';
import { contentHash } from '../../src/sync/hash.js';
import { upsertNote, getNote } from '../../src/db/notes.js';
import { writeNoteFile, readNoteFile } from '../../src/sync/files.js';
import { createTombstone } from '../../src/db/tombstones.js';
import type { SyncRequest } from '@futo-notes/shared';
import { statSync } from 'node:fs';
import path from 'node:path';

describe('sync engine', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('handles empty sync (no notes on either side)', () => {
    const db = getDb();
    const result = processSync(db, env.notesDir, {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });

    expect(result.update).toEqual([]);
    expect(result.delete).toEqual([]);
    expect(result.hash_updates).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('accepts a new note from the client', () => {
    const db = getDb();
    const content = '# Hello\nWorld';
    const hash = contentHash(content);

    const result = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'hello.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    expect(result.hash_updates).toEqual([{ uuid: 'u1', hash_at_last_sync: hash }]);
    expect(readNoteFile(env.notesDir, 'hello.md')).toBe(content);
  });

  it('preserves client modified_at as filesystem mtime', () => {
    const db = getDb();
    const modifiedAt = Date.parse('2020-01-02T03:04:05.000Z');
    const content = 'preserve me';
    const hash = contentHash(content);

    processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'preserve.md',
          modified_at: modifiedAt,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    const stat = statSync(path.join(env.notesDir, 'preserve.md'));
    expect(Math.abs(stat.mtimeMs - modifiedAt)).toBeLessThan(5);
  });

  it('sends server-only notes to the client', () => {
    const db = getDb();
    const content = 'server note';
    const hash = contentHash(content);
    writeNoteFile(env.notesDir, 'server.md', content);
    upsertNote(db, 's1', 'server.md', hash, Date.now());

    const result = processSync(db, env.notesDir, {
      notes: [],
      all_uuids: [],
      deleted_uuids: [],
    });

    expect(result.update).toHaveLength(1);
    expect(result.update[0].uuid).toBe('s1');
    expect(result.update[0].content).toBe(content);
  });

  it('accepts client update when server unchanged', () => {
    const db = getDb();
    const oldContent = 'old';
    const oldHash = contentHash(oldContent);
    writeNoteFile(env.notesDir, 'note.md', oldContent);
    upsertNote(db, 'u1', 'note.md', oldHash, Date.now());

    const newContent = 'new content';
    const newHash = contentHash(newContent);

    const result = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: Date.now(),
          content_hash: newHash,
          hash_at_last_sync: oldHash,
          content: newContent,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    expect(result.hash_updates).toEqual([{ uuid: 'u1', hash_at_last_sync: newHash }]);
    expect(readNoteFile(env.notesDir, 'note.md')).toBe(newContent);
  });

  it('sends server update when client unchanged', () => {
    const db = getDb();
    const origHash = contentHash('original');
    const serverContent = 'server updated';
    const serverHash = contentHash(serverContent);
    writeNoteFile(env.notesDir, 'note.md', serverContent);
    upsertNote(db, 'u1', 'note.md', serverHash, Date.now());

    const result = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: Date.now(),
          content_hash: origHash,
          hash_at_last_sync: origHash,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    expect(result.update).toHaveLength(1);
    expect(result.update[0].uuid).toBe('u1');
    expect(result.update[0].content).toBe(serverContent);
  });

  it('detects conflict when both sides changed', () => {
    const db = getDb();
    const origHash = contentHash('original');
    const serverContent = 'server version';
    const serverHash = contentHash(serverContent);
    writeNoteFile(env.notesDir, 'note.md', serverContent);
    upsertNote(db, 'u1', 'note.md', serverHash, Date.now());

    const clientContent = 'client version';
    const clientHash = contentHash(clientContent);

    const result = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: Date.now(),
          content_hash: clientHash,
          hash_at_last_sync: origHash,
          content: clientContent,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // Server version sent to client + conflict copy also sent as new note
    expect(result.update).toHaveLength(2);
    const origUpdate = result.update.find((u: any) => u.uuid === 'u1');
    expect(origUpdate?.content).toBe(serverContent);

    // Conflict copy sent as a new server-only note
    const conflictUpdate = result.update.find((u: any) => u.uuid !== 'u1');
    expect(conflictUpdate?.content).toBe(clientContent);

    // Conflict metadata reported
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].client_content).toBe(clientContent);
  });

  it('processes client deletion', () => {
    const db = getDb();
    writeNoteFile(env.notesDir, 'bye.md', 'content');
    upsertNote(db, 'd1', 'bye.md', contentHash('content'), Date.now());

    const result = processSync(db, env.notesDir, {
      notes: [],
      all_uuids: [],
      deleted_uuids: ['d1'],
    });

    expect(readNoteFile(env.notesDir, 'bye.md')).toBeNull();
    expect(result.delete).not.toContain('d1');
  });

  it('propagates server tombstone to client', () => {
    const db = getDb();
    createTombstone(db, 'dead');

    const result = processSync(db, env.notesDir, {
      notes: [],
      all_uuids: ['dead'],
      deleted_uuids: [],
    });

    expect(result.delete).toContain('dead');
  });

  it('prevents re-upload of tombstoned note', () => {
    const db = getDb();
    createTombstone(db, 'dead');

    const result = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'dead',
          filename: 'zombie.md',
          modified_at: Date.now(),
          content_hash: contentHash('brains'),
          hash_at_last_sync: '',
          content: 'brains',
        },
      ],
      all_uuids: ['dead'],
      deleted_uuids: [],
    });

    expect(result.delete).toContain('dead');
    expect(readNoteFile(env.notesDir, 'zombie.md')).toBeNull();
  });

  it('renames file on disk when client sends new filename (no content changes)', () => {
    const db = getDb();
    const content = 'grocery list';
    const hash = contentHash(content);
    writeNoteFile(env.notesDir, 'old name.md', content);
    upsertNote(db, 'u1', 'old name.md', hash, Date.now());

    const result = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'new name.md',
          modified_at: Date.now(),
          content_hash: hash,
          hash_at_last_sync: hash,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    // No updates/conflicts — just a rename
    expect(result.update).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.hash_updates).toEqual([]);

    // Old file gone, new file has same content
    expect(readNoteFile(env.notesDir, 'old name.md')).toBeNull();
    expect(readNoteFile(env.notesDir, 'new name.md')).toBe(content);

    // DB updated to new filename
    const note = getNote(db, 'u1');
    expect(note?.filename).toBe('new name.md');
  });

  it('renames file on disk when client changes content and filename', () => {
    const db = getDb();
    const oldContent = 'old stuff';
    const oldHash = contentHash(oldContent);
    writeNoteFile(env.notesDir, 'old name.md', oldContent);
    upsertNote(db, 'u1', 'old name.md', oldHash, Date.now());

    const newContent = 'new stuff';
    const newHash = contentHash(newContent);

    const result = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'new name.md',
          modified_at: Date.now(),
          content_hash: newHash,
          hash_at_last_sync: oldHash,
          content: newContent,
        },
      ],
      all_uuids: ['u1'],
      deleted_uuids: [],
    });

    expect(result.hash_updates).toEqual([{ uuid: 'u1', hash_at_last_sync: newHash }]);
    expect(result.conflicts).toEqual([]);

    // Old file gone, new file has new content
    expect(readNoteFile(env.notesDir, 'old name.md')).toBeNull();
    expect(readNoteFile(env.notesDir, 'new name.md')).toBe(newContent);

    // DB updated
    const note = getNote(db, 'u1');
    expect(note?.filename).toBe('new name.md');
    expect(note?.content_hash).toBe(newHash);
  });

  it('handles multi-note sync', () => {
    const db = getDb();
    const c1 = '# Note 1';
    const c2 = '# Note 2';

    const result = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note1.md',
          modified_at: Date.now(),
          content_hash: contentHash(c1),
          hash_at_last_sync: '',
          content: c1,
        },
        {
          uuid: 'u2',
          filename: 'note2.md',
          modified_at: Date.now(),
          content_hash: contentHash(c2),
          hash_at_last_sync: '',
          content: c2,
        },
      ],
      all_uuids: ['u1', 'u2'],
      deleted_uuids: [],
    });

    expect(result.hash_updates).toHaveLength(2);
    expect(readNoteFile(env.notesDir, 'note1.md')).toBe(c1);
    expect(readNoteFile(env.notesDir, 'note2.md')).toBe(c2);
  });
});

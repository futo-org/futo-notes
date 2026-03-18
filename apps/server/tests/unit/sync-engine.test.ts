import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, type TestEnv } from '../helpers/setup.js';
import { getDb } from '../../src/db/index.js';
import { processSync } from '../../src/sync/engine.js';
import { contentHash } from '../../src/sync/hash.js';
import { upsertNote, getNote } from '../../src/db/notes.js';
import { writeNoteFile, readNoteFile, deleteNoteFile } from '../../src/sync/files.js';
import { createTombstone, getAllTombstones, pruneTombstones } from '../../src/db/tombstones.js';

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
    const { response: result } = processSync(db, env.notesDir, {
      notes: [],
      inventory: [],
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
    const now = Date.now();

    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'hello.md',
          modified_at: now,
          content_hash: hash,
          hash_at_last_sync: '',
          content,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'hello.md', modified_at: now }],
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
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'preserve.md', modified_at: modifiedAt }],
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

    const { response: result } = processSync(db, env.notesDir, {
      notes: [],
      inventory: [],
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
    const now = Date.now();

    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: now,
          content_hash: newHash,
          hash_at_last_sync: oldHash,
          content: newContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: newHash, filename: 'note.md', modified_at: now }],
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

    const now = Date.now();
    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: now,
          content_hash: origHash,
          hash_at_last_sync: origHash,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: origHash, filename: 'note.md', modified_at: now }],
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
    const now = Date.now();

    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: now,
          content_hash: clientHash,
          hash_at_last_sync: origHash,
          content: clientContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: clientHash, filename: 'note.md', modified_at: now }],
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

    const { response: result } = processSync(db, env.notesDir, {
      notes: [],
      inventory: [],
      deleted_uuids: ['d1'],
    });

    expect(readNoteFile(env.notesDir, 'bye.md')).toBeNull();
    expect(result.delete).not.toContain('d1');
  });

  it('propagates server tombstone to client', () => {
    const db = getDb();
    createTombstone(db, 'dead');

    const { response: result } = processSync(db, env.notesDir, {
      notes: [],
      inventory: [{ uuid: 'dead', content_hash: 'dummy', filename: 'dead.md', modified_at: Date.now() }],
      deleted_uuids: [],
    });

    expect(result.delete).toContain('dead');
  });

  it('prevents re-upload of tombstoned note', () => {
    const db = getDb();
    createTombstone(db, 'dead');
    const now = Date.now();
    const zombieHash = contentHash('brains');

    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'dead',
          filename: 'zombie.md',
          modified_at: now,
          content_hash: zombieHash,
          hash_at_last_sync: '',
          content: 'brains',
        },
      ],
      inventory: [{ uuid: 'dead', content_hash: zombieHash, filename: 'zombie.md', modified_at: now }],
      deleted_uuids: [],
    });

    expect(result.delete).toContain('dead');
    expect(readNoteFile(env.notesDir, 'zombie.md')).toBeNull();
  });

  it('renames file on disk when client sends new filename (no content changes)', () => {
    const db = getDb();
    const content = 'grocery list';
    const hash = contentHash(content);
    const T0 = Date.now() - 5000;
    writeNoteFile(env.notesDir, 'old name.md', content);
    upsertNote(db, 'u1', 'old name.md', hash, T0);

    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'new name.md',
          modified_at: T0 + 3000, // client renamed → newer timestamp
          content_hash: hash,
          hash_at_last_sync: hash,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'new name.md', modified_at: T0 + 3000 }],
      deleted_uuids: [],
    });

    // No updates/conflicts — rename acknowledged via hash_updates
    expect(result.update).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.hash_updates).toEqual([{ uuid: 'u1', hash_at_last_sync: hash }]);

    // Old file gone, new file has same content
    expect(readNoteFile(env.notesDir, 'old name.md')).toBeNull();
    expect(readNoteFile(env.notesDir, 'new name.md')).toBe(content);

    // DB updated to new filename and modified_at
    const note = getNote(db, 'u1');
    expect(note?.filename).toBe('new name.md');
    expect(note?.modified_at).toBe(T0 + 3000);
  });

  it('renames file on disk when client changes content and filename', () => {
    const db = getDb();
    const oldContent = 'old stuff';
    const oldHash = contentHash(oldContent);
    writeNoteFile(env.notesDir, 'old name.md', oldContent);
    upsertNote(db, 'u1', 'old name.md', oldHash, Date.now());

    const newContent = 'new stuff';
    const newHash = contentHash(newContent);
    const now = Date.now();

    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'new name.md',
          modified_at: now,
          content_hash: newHash,
          hash_at_last_sync: oldHash,
          content: newContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: newHash, filename: 'new name.md', modified_at: now }],
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
    const h1 = contentHash(c1);
    const h2 = contentHash(c2);
    const now = Date.now();

    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note1.md',
          modified_at: now,
          content_hash: h1,
          hash_at_last_sync: '',
          content: c1,
        },
        {
          uuid: 'u2',
          filename: 'note2.md',
          modified_at: now,
          content_hash: h2,
          hash_at_last_sync: '',
          content: c2,
        },
      ],
      inventory: [
        { uuid: 'u1', content_hash: h1, filename: 'note1.md', modified_at: now },
        { uuid: 'u2', content_hash: h2, filename: 'note2.md', modified_at: now },
      ],
      deleted_uuids: [],
    });

    expect(result.hash_updates).toHaveLength(2);
    expect(readNoteFile(env.notesDir, 'note1.md')).toBe(c1);
    expect(readNoteFile(env.notesDir, 'note2.md')).toBe(c2);
  });

  it('rename does not ping-pong: stale client gets server rename instead of reverting it', () => {
    const db = getDb();
    const content = '# Shared note';
    const hash = contentHash(content);
    const T0 = Date.now() - 10000;

    // Initial state: note exists on server
    writeNoteFile(env.notesDir, 'grocery list.md', content);
    upsertNote(db, 'u1', 'grocery list.md', hash, T0);

    // Client A syncs with renamed filename (newer timestamp from rename)
    const { response: resultA } = processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1',
        filename: 'shopping list.md',
        modified_at: T0 + 5000,
        content_hash: hash,
        hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'shopping list.md', modified_at: T0 + 5000 }],
      deleted_uuids: [],
    });

    // Client A's rename should be accepted
    expect(resultA.hash_updates).toHaveLength(1);
    expect(readNoteFile(env.notesDir, 'shopping list.md')).toBe(content);
    expect(readNoteFile(env.notesDir, 'grocery list.md')).toBeNull();

    // Client B syncs with OLD filename (older timestamp — hasn't been modified)
    const { response: resultB } = processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1',
        filename: 'grocery list.md',
        modified_at: T0,
        content_hash: hash,
        hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'grocery list.md', modified_at: T0 }],
      deleted_uuids: [],
    });

    // Client B should get the server's renamed version, NOT revert it
    expect(resultB.update).toHaveLength(1);
    expect(resultB.update[0].filename).toBe('shopping list.md');
    expect(resultB.update[0].content).toBe(content);
    expect(resultB.hash_updates).toHaveLength(0);

    // Server file should still be the renamed version
    expect(readNoteFile(env.notesDir, 'shopping list.md')).toBe(content);
    expect(readNoteFile(env.notesDir, 'grocery list.md')).toBeNull();
  });

  it('rename converges to steady state after two-client sync', () => {
    const db = getDb();
    const content = '# Note';
    const hash = contentHash(content);
    const T0 = Date.now() - 10000;

    writeNoteFile(env.notesDir, 'old.md', content);
    upsertNote(db, 'u1', 'old.md', hash, T0);

    // Client A renames (newer timestamp)
    processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1', filename: 'new.md', modified_at: T0 + 5000,
        content_hash: hash, hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'new.md', modified_at: T0 + 5000 }],
      deleted_uuids: [],
    });

    // Client B syncs with old name (older timestamp) — gets update
    const { response: r2 } = processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1', filename: 'old.md', modified_at: T0,
        content_hash: hash, hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'old.md', modified_at: T0 }],
      deleted_uuids: [],
    });
    expect(r2.update).toHaveLength(1);

    // Client B syncs again after receiving the rename (now matches server)
    const { response: r3 } = processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1', filename: 'new.md', modified_at: T0 + 5000,
        content_hash: hash, hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'new.md', modified_at: T0 + 5000 }],
      deleted_uuids: [],
    });
    expect(r3.update).toHaveLength(0);
    expect(r3.hash_updates).toHaveLength(0);

    // Client A syncs again — also no changes
    const { response: r4 } = processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1', filename: 'new.md', modified_at: T0 + 5000,
        content_hash: hash, hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'new.md', modified_at: T0 + 5000 }],
      deleted_uuids: [],
    });
    expect(r4.update).toHaveLength(0);
    expect(r4.hash_updates).toHaveLength(0);
  });

  it('both clients rename: last-write-wins based on modified_at', () => {
    const db = getDb();
    const content = '# Shared';
    const hash = contentHash(content);
    const T0 = Date.now() - 10000;

    writeNoteFile(env.notesDir, 'original.md', content);
    upsertNote(db, 'u1', 'original.md', hash, T0);

    // Client A renames at T0+3s
    processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1', filename: 'name-from-A.md', modified_at: T0 + 3000,
        content_hash: hash, hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'name-from-A.md', modified_at: T0 + 3000 }],
      deleted_uuids: [],
    });

    // Client B renames at T0+5s (later) — should win
    const { response: resultB } = processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1', filename: 'name-from-B.md', modified_at: T0 + 5000,
        content_hash: hash, hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'name-from-B.md', modified_at: T0 + 5000 }],
      deleted_uuids: [],
    });

    expect(resultB.hash_updates).toHaveLength(1);
    expect(readNoteFile(env.notesDir, 'name-from-B.md')).toBe(content);
    expect(readNoteFile(env.notesDir, 'name-from-A.md')).toBeNull();

    // Client A syncs again — should get B's name
    const { response: resultA2 } = processSync(db, env.notesDir, {
      notes: [{
        uuid: 'u1', filename: 'name-from-A.md', modified_at: T0 + 3000,
        content_hash: hash, hash_at_last_sync: hash,
      }],
      inventory: [{ uuid: 'u1', content_hash: hash, filename: 'name-from-A.md', modified_at: T0 + 3000 }],
      deleted_uuids: [],
    });

    expect(resultA2.update).toHaveLength(1);
    expect(resultA2.update[0].filename).toBe('name-from-B.md');
    expect(resultA2.hash_updates).toHaveLength(0);
  });

  it('conflict resolution sends empty content when server file is missing on disk', () => {
    const db = getDb();
    const origHash = contentHash('original');
    const serverContent = 'server version';
    const serverHash = contentHash(serverContent);
    writeNoteFile(env.notesDir, 'note.md', serverContent);
    upsertNote(db, 'u1', 'note.md', serverHash, Date.now());

    // Delete the server file from disk to simulate missing file
    deleteNoteFile(env.notesDir, 'note.md');

    const clientContent = 'client version';
    const clientHash = contentHash(clientContent);
    const now = Date.now();

    const { response: result } = processSync(db, env.notesDir, {
      notes: [
        {
          uuid: 'u1',
          filename: 'note.md',
          modified_at: now,
          content_hash: clientHash,
          hash_at_last_sync: origHash,
          content: clientContent,
        },
      ],
      inventory: [{ uuid: 'u1', content_hash: clientHash, filename: 'note.md', modified_at: now }],
      deleted_uuids: [],
    });

    // Server should still send an update (with empty content) so the client gets the hash mapping
    const origUpdate = result.update.find((u: any) => u.uuid === 'u1');
    expect(origUpdate).toBeDefined();
    expect(origUpdate!.content).toBe('');
    expect(origUpdate!.content_hash).toBe(serverHash);
    expect(origUpdate!.hash_at_last_sync).toBe(serverHash);

    // Conflict metadata should still be reported
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].client_content).toBe(clientContent);
  });

  it('pruneTombstones removes entries older than maxAgeMs', () => {
    const db = getDb();

    // Create a tombstone and manually backdate its deleted_at
    createTombstone(db, 'old-uuid');
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
    db.prepare('UPDATE tombstones SET deleted_at = ? WHERE uuid = ?').run(oldDate, 'old-uuid');

    // Create a recent tombstone
    createTombstone(db, 'new-uuid');

    expect(getAllTombstones(db)).toHaveLength(2);

    // Prune with 90-day threshold
    const pruned = pruneTombstones(db);

    expect(pruned).toBe(1);
    const remaining = getAllTombstones(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].uuid).toBe('new-uuid');
  });

  it('pruneTombstones is called during sync and removes expired entries', () => {
    const db = getDb();

    // Create tombstones with backdated deleted_at
    createTombstone(db, 'expired-1');
    createTombstone(db, 'expired-2');
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE tombstones SET deleted_at = ? WHERE uuid = ?').run(oldDate, 'expired-1');
    db.prepare('UPDATE tombstones SET deleted_at = ? WHERE uuid = ?').run(oldDate, 'expired-2');

    // Create a recent tombstone
    createTombstone(db, 'recent');

    expect(getAllTombstones(db)).toHaveLength(3);

    // Run a sync — pruneTombstones should be called at the start
    processSync(db, env.notesDir, {
      notes: [],
      inventory: [],
      deleted_uuids: [],
    });

    // Expired tombstones should be gone, recent one remains
    const remaining = getAllTombstones(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].uuid).toBe('recent');
  });

  it('pruneTombstones respects custom maxAgeMs', () => {
    const db = getDb();

    createTombstone(db, 'uuid-1');
    // Backdate to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE tombstones SET deleted_at = ? WHERE uuid = ?').run(tenDaysAgo, 'uuid-1');

    createTombstone(db, 'uuid-2');

    // With 5-day threshold, both should survive (uuid-2 is fresh)
    // but uuid-1 (10 days old) should be pruned
    const pruned = pruneTombstones(db, 5 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);

    const remaining = getAllTombstones(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].uuid).toBe('uuid-2');
  });
});

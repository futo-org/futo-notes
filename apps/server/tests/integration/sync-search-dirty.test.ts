import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, type TestEnv } from '../helpers/setup.js';
import { SyncClient } from '../helpers/sync-client.js';
import { getDb } from '../../src/db/index.js';
import { getDirtyUuids } from '../../src/search/dirtyTracker.js';

/**
 * Regression tests for search dirty tracking during sync.
 *
 * Bug: handlePostSync included result.update (read-only downloads to client)
 * in changedUuids, causing markDirtyAfterSync to wipe search_index_state
 * whenever a second client synced.
 */
describe('sync search dirty tracking', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('read-only client download does not wipe search_index_state', async () => {
    const db = getDb();
    const clientA = new SyncClient(env.app, token);
    const clientB = new SyncClient(env.app, token);

    // Client A creates notes and syncs
    clientA.createNote('note1.md', '# Note 1\n\nContent one.');
    clientA.createNote('note2.md', '# Note 2\n\nContent two.');
    clientA.createNote('note3.md', '# Note 3\n\nContent three.');
    const resA = await clientA.sync();
    expect(resA.hash_updates).toHaveLength(3);

    // Simulate completed indexing: insert search_index_state for all notes
    const notes = db.prepare('SELECT uuid, content_hash FROM notes').all() as
      { uuid: string; content_hash: string }[];
    for (const note of notes) {
      db.prepare(
        'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, 2, ?, ?)',
      ).run(note.uuid, note.content_hash, Date.now());
    }

    // Verify no dirty notes
    expect(getDirtyUuids(db, 2)).toHaveLength(0);

    // Client B syncs — downloads all 3 notes (result.update has 3 entries)
    const resB = await clientB.sync();
    expect(resB.update).toHaveLength(3);

    // search_index_state should NOT have been wiped
    const stateCount = (db.prepare('SELECT COUNT(*) as c FROM search_index_state').get() as { c: number }).c;
    expect(stateCount).toBe(3);
    expect(getDirtyUuids(db, 2)).toHaveLength(0);
  });

  it('client upload correctly marks uploaded notes dirty', async () => {
    const db = getDb();
    const clientA = new SyncClient(env.app, token);

    // Client A creates and syncs a note
    const uuid = clientA.createNote('new-note.md', '# New\n\nFresh content.');
    await clientA.sync();

    // The uploaded note should appear dirty (needs indexing)
    const dirty = getDirtyUuids(db, 2);
    expect(dirty).toContain(uuid);
  });

  it('already-indexed notes stay indexed after another client downloads them', async () => {
    const db = getDb();
    const clientA = new SyncClient(env.app, token);
    const clientB = new SyncClient(env.app, token);

    // Client A uploads a note
    const uuid = clientA.createNote('stable.md', '# Stable\n\nThis note is indexed.');
    await clientA.sync();

    // Simulate indexing complete
    const note = db.prepare('SELECT content_hash FROM notes WHERE uuid = ?').get(uuid) as { content_hash: string };
    db.prepare(
      'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, 2, ?, ?)',
    ).run(uuid, note.content_hash, Date.now());
    expect(getDirtyUuids(db, 2)).toHaveLength(0);

    // Client B downloads the note
    const resB = await clientB.sync();
    expect(resB.update.length).toBeGreaterThanOrEqual(1);

    // Index state should be preserved
    expect(getDirtyUuids(db, 2)).toHaveLength(0);
  });

  it('editing a note marks it dirty again', async () => {
    const db = getDb();
    const clientA = new SyncClient(env.app, token);

    // Create and sync
    const uuid = clientA.createNote('editable.md', '# v1');
    await clientA.sync();

    // Simulate indexing
    const note = db.prepare('SELECT content_hash FROM notes WHERE uuid = ?').get(uuid) as { content_hash: string };
    db.prepare(
      'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, 2, ?, ?)',
    ).run(uuid, note.content_hash, Date.now());
    expect(getDirtyUuids(db, 2)).toHaveLength(0);

    // Edit and re-sync
    clientA.editNote(uuid, '# v2\n\nUpdated content.');
    await clientA.sync();

    // Note should be dirty again (hash changed)
    const dirty = getDirtyUuids(db, 2);
    expect(dirty).toContain(uuid);
  });
});

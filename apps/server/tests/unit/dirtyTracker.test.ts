import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../src/db/index.js';
import { createSearchTables } from '../../src/db/searchSchema.js';
import { upsertNote } from '../../src/db/notes.js';
import { markDirtyAfterSync, getDirtyUuids, removeDirtyForDeleted } from '../../src/search/dirtyTracker.js';
import { initVectorDb, insertVector, resetVectorDb } from '../../src/db/vectorDb.js';

describe('dirtyTracker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'futo-dirty-test-'));
    initDb(path.join(tmpDir, 'test.db'));
    createSearchTables(getDb());
  });

  afterEach(() => {
    resetVectorDb();
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getDirtyUuids returns notes without index state', () => {
    const db = getDb();
    upsertNote(db, 'u1', 'note1.md', 'hash1', Date.now());
    upsertNote(db, 'u2', 'note2.md', 'hash2', Date.now());

    const dirty = getDirtyUuids(db, 2);
    expect(dirty).toContain('u1');
    expect(dirty).toContain('u2');
    expect(dirty).toHaveLength(2);
  });

  it('getDirtyUuids excludes already-indexed notes with matching hash', () => {
    const db = getDb();
    upsertNote(db, 'u1', 'note1.md', 'hash1', Date.now());
    upsertNote(db, 'u2', 'note2.md', 'hash2', Date.now());

    // Mark u1 as indexed with matching hash
    db.prepare(
      'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
    ).run('u1', 2, 'hash1', Date.now());

    const dirty = getDirtyUuids(db, 2);
    expect(dirty).toEqual(['u2']);
  });

  it('getDirtyUuids returns notes with mismatched hash', () => {
    const db = getDb();
    upsertNote(db, 'u1', 'note1.md', 'hash_new', Date.now());

    // Index state has old hash
    db.prepare(
      'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
    ).run('u1', 2, 'hash_old', Date.now());

    const dirty = getDirtyUuids(db, 2);
    expect(dirty).toEqual(['u1']);
  });

  it('markDirtyAfterSync removes index state for changed UUIDs', () => {
    const db = getDb();
    upsertNote(db, 'u1', 'note1.md', 'hash1', Date.now());
    db.prepare(
      'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
    ).run('u1', 2, 'hash1', Date.now());

    // u1 was indexed, now mark it dirty
    markDirtyAfterSync(db, ['u1']);

    const dirty = getDirtyUuids(db, 2);
    expect(dirty).toEqual(['u1']);
  });

  it('markDirtyAfterSync is a no-op for empty array', () => {
    const db = getDb();
    upsertNote(db, 'u1', 'note1.md', 'hash1', Date.now());
    db.prepare(
      'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
    ).run('u1', 2, 'hash1', Date.now());

    markDirtyAfterSync(db, []);

    // u1 should still be indexed (not dirty)
    const dirty = getDirtyUuids(db, 2);
    expect(dirty).toEqual([]);
  });

  it('removeDirtyForDeleted cleans up state, chunks, and vectors', async () => {
    const db = getDb();
    await initVectorDb(db, 3);
    upsertNote(db, 'u1', 'note1.md', 'hash1', Date.now());
    db.prepare(
      'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
    ).run('u1', 2, 'hash1', Date.now());
    db.prepare(
      'INSERT INTO search_chunks (uuid, chunk_index, chunk_text, start_offset, end_offset, content_hash) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('u1', 0, 'some text', 0, 9, 'hash1');
    insertVector(db, 1, [0.1, 0.2, 0.3]);

    removeDirtyForDeleted(db, ['u1']);

    // State should be gone
    const state = db.prepare('SELECT * FROM search_index_state WHERE uuid = ?').all('u1');
    expect(state).toHaveLength(0);

    // Chunks should be gone
    const chunks = db.prepare('SELECT * FROM search_chunks WHERE uuid = ?').all('u1');
    expect(chunks).toHaveLength(0);

    // Vectors should be gone
    const vectors = db.prepare('SELECT chunk_id FROM search_vectors').all() as Array<{ chunk_id: bigint }>;
    expect(vectors).toHaveLength(0);
  });

  it('insertVector replaces a stale vector row for the same chunk id', async () => {
    const db = getDb();
    await initVectorDb(db, 3);

    insertVector(db, 1, [0.1, 0.2, 0.3]);
    insertVector(db, 1, [0.4, 0.5, 0.6]);

    const rows = db.prepare('SELECT chunk_id, embedding FROM search_vectors WHERE chunk_id = ?')
      .all(1n) as Array<{ chunk_id: bigint; embedding: Buffer }>;

    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0]?.chunk_id ?? -1)).toBe(1n);
    expect(Array.from(new Float32Array(
      rows[0].embedding.buffer,
      rows[0].embedding.byteOffset,
      3,
    ))).toSatisfy((values: number[]) => (
      Math.abs(values[0] - 0.4) < 1e-6
      && Math.abs(values[1] - 0.5) < 1e-6
      && Math.abs(values[2] - 0.6) < 1e-6
    ));
  });

  it('removeDirtyForDeleted is a no-op for empty array', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO search_index_state (uuid, level, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
    ).run('u1', 2, 'hash1', Date.now());

    removeDirtyForDeleted(db, []);

    const state = db.prepare('SELECT * FROM search_index_state WHERE uuid = ?').all('u1');
    expect(state).toHaveLength(1);
  });
});

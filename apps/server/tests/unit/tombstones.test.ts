import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTables } from '../../src/db/schema.js';
import {
  getTombstone,
  getAllTombstones,
  createTombstone,
  deleteTombstone,
  pruneTombstones,
} from '../../src/db/tombstones.js';

describe('tombstones', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'tombstone-test-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    createTables(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getTombstone returns null for non-existent uuid', () => {
    expect(getTombstone(db, 'nonexistent')).toBeNull();
  });

  it('getTombstone returns the tombstone row when it exists', () => {
    createTombstone(db, 'abc-123');
    const row = getTombstone(db, 'abc-123');
    expect(row).not.toBeNull();
    expect(row!.uuid).toBe('abc-123');
    expect(row!.deleted_at).toBeTruthy();
  });

  it('getAllTombstones returns all rows', () => {
    createTombstone(db, 'a');
    createTombstone(db, 'b');
    createTombstone(db, 'c');
    const all = getAllTombstones(db);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.uuid).sort()).toEqual(['a', 'b', 'c']);
  });

  it('createTombstone ignores duplicate inserts', () => {
    createTombstone(db, 'dup');
    createTombstone(db, 'dup');
    expect(getAllTombstones(db)).toHaveLength(1);
  });

  it('deleteTombstone returns 1 when row existed', () => {
    createTombstone(db, 'to-delete');
    expect(deleteTombstone(db, 'to-delete')).toBe(1);
    expect(getTombstone(db, 'to-delete')).toBeNull();
  });

  it('deleteTombstone returns 0 when row did not exist', () => {
    expect(deleteTombstone(db, 'nonexistent')).toBe(0);
  });

  it('pruneTombstones removes old tombstones', () => {
    // Insert a tombstone with an old date
    db.prepare("INSERT INTO tombstones (uuid, deleted_at) VALUES (?, datetime('now', '-100 days'))").run('old');
    createTombstone(db, 'recent');

    const pruned = pruneTombstones(db);
    expect(pruned).toBe(1);
    expect(getTombstone(db, 'old')).toBeNull();
    expect(getTombstone(db, 'recent')).not.toBeNull();
  });
});

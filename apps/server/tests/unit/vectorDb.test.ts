import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../src/db/index.js';
import { tableExists } from '../../src/db/utils.js';
import { initVectorDb, insertVector, searchVectors, resetVectorDb } from '../../src/db/vectorDb.js';

describe('vectorDb', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'futo-vector-db-test-'));
  });

  afterEach(() => {
    resetVectorDb();
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recreates search_vectors after the table is dropped in the same process', async () => {
    initDb(path.join(tmpDir, 'test.db'));

    await initVectorDb(getDb(), 3);
    expect(tableExists(getDb(), 'search_vectors')).toBe(true);

    getDb().exec('DROP TABLE search_vectors');
    expect(tableExists(getDb(), 'search_vectors')).toBe(false);

    await initVectorDb(getDb(), 3);
    expect(tableExists(getDb(), 'search_vectors')).toBe(true);
  });

  it('initializes search_vectors for a new DB connection in the same process', async () => {
    initDb(path.join(tmpDir, 'first.db'));
    await initVectorDb(getDb(), 3);
    expect(tableExists(getDb(), 'search_vectors')).toBe(true);

    closeDb();

    initDb(path.join(tmpDir, 'second.db'));
    await initVectorDb(getDb(), 3);
    expect(tableExists(getDb(), 'search_vectors')).toBe(true);
  });

  it('searchVectors returns nearest neighbors sorted by distance', async () => {
    initDb(path.join(tmpDir, 'search.db'));
    await initVectorDb(getDb(), 4);

    insertVector(getDb(), 1, [1, 0, 0, 0]);
    insertVector(getDb(), 2, [0, 1, 0, 0]);
    insertVector(getDb(), 3, [0.9, 0.1, 0, 0]);

    const results = searchVectors(getDb(), [1, 0, 0, 0], 3);
    expect(results).toHaveLength(3);
    expect(Number(results[0].chunk_id)).toBe(1);
    expect(results[0].distance).toBeCloseTo(0, 1);
    expect(Number(results[1].chunk_id)).toBe(3);
    expect(results[1].distance).toBeLessThan(results[2].distance);
  });

  it('searchVectors returns empty array when no vectors exist', async () => {
    initDb(path.join(tmpDir, 'empty.db'));
    await initVectorDb(getDb(), 4);

    const results = searchVectors(getDb(), [1, 0, 0, 0], 5);
    expect(results).toEqual([]);
  });
});

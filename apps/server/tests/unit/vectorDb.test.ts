import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../src/db/index.js';
import { initVectorDb, resetVectorDb } from '../../src/db/vectorDb.js';

function hasSearchVectorsTable(): boolean {
  const row = getDb().prepare(
    `SELECT 1 as found FROM sqlite_master WHERE type = 'table' AND name = 'search_vectors' LIMIT 1`,
  ).get() as { found: number } | undefined;
  return row !== undefined;
}

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
    expect(hasSearchVectorsTable()).toBe(true);

    getDb().exec('DROP TABLE search_vectors');
    expect(hasSearchVectorsTable()).toBe(false);

    await initVectorDb(getDb(), 3);
    expect(hasSearchVectorsTable()).toBe(true);
  });

  it('initializes search_vectors for a new DB connection in the same process', async () => {
    initDb(path.join(tmpDir, 'first.db'));
    await initVectorDb(getDb(), 3);
    expect(hasSearchVectorsTable()).toBe(true);

    closeDb();

    initDb(path.join(tmpDir, 'second.db'));
    await initVectorDb(getDb(), 3);
    expect(hasSearchVectorsTable()).toBe(true);
  });
});

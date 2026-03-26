import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTables, migrateSchema, SCHEMA_VERSION } from '../../src/db/schema.js';

/**
 * The original notes CREATE TABLE SQL without the is_blob column,
 * simulating a version-0 (legacy) database. This is intentionally
 * duplicated — the test ensures migration produces the same result
 * as createTables().
 */
const LEGACY_NOTES_SQL = `
  CREATE TABLE IF NOT EXISTS notes (
    uuid TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    modified_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const OTHER_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS auth (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    device_info TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tombstones (
    uuid TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('sync_version', '0');

  CREATE TABLE IF NOT EXISTS note_tags (
    uuid TEXT NOT NULL,
    tag TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (uuid, tag),
    FOREIGN KEY (uuid) REFERENCES notes(uuid) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);
`;

const CORE_TABLES = ['auth', 'sessions', 'notes', 'tombstones', 'sync_meta', 'note_tags'];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexInfo {
  name: string;
  columns: string[];
}

/** Get structural schema info for comparison (immune to ALTER TABLE SQL differences). */
function getSchemaStructure(db: Database.Database) {
  const tables: Record<string, { columns: ColumnInfo[]; indexes: IndexInfo[]; foreignKeys: unknown[] }> = {};

  for (const table of CORE_TABLES) {
    const columns = db.pragma(`table_info(${table})`) as ColumnInfo[];
    const indexList = db.pragma(`index_list(${table})`) as { name: string; origin: string }[];
    const foreignKeys = db.pragma(`foreign_key_list(${table})`) as unknown[];

    // Get column details for each index (skip auto-indexes from PRIMARY KEY)
    const indexes: IndexInfo[] = [];
    for (const idx of indexList) {
      if (idx.origin === 'c') { // only user-created indexes
        const indexInfo = db.pragma(`index_info(${idx.name})`) as { name: string }[];
        indexes.push({ name: idx.name, columns: indexInfo.map(c => c.name) });
      }
    }

    tables[table] = {
      // Sort columns by name to handle ALTER TABLE ADD COLUMN ordering differences
      columns: columns
        .map(c => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      indexes: indexes.sort((a, b) => a.name.localeCompare(b.name)),
      foreignKeys,
    };
  }

  return tables;
}

describe('schema consistency', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'schema-consistency-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrated legacy DB matches fresh DB schema', () => {
    // Create a legacy DB (version 0, no is_blob column)
    const legacyDb = new Database(path.join(tmpDir, 'legacy.db'));
    legacyDb.exec(LEGACY_NOTES_SQL);
    legacyDb.exec(OTHER_TABLES_SQL);
    migrateSchema(legacyDb);

    // Create a fresh DB via normal init path
    const freshDb = new Database(path.join(tmpDir, 'fresh.db'));
    createTables(freshDb);
    migrateSchema(freshDb);

    // Compare table structure (columns, indexes, foreign keys)
    const legacyStructure = getSchemaStructure(legacyDb);
    const freshStructure = getSchemaStructure(freshDb);
    expect(legacyStructure).toEqual(freshStructure);

    // Verify seed data
    const legacySyncVersion = legacyDb.prepare(
      "SELECT value FROM sync_meta WHERE key = 'sync_version'",
    ).get() as { value: string } | undefined;
    const freshSyncVersion = freshDb.prepare(
      "SELECT value FROM sync_meta WHERE key = 'sync_version'",
    ).get() as { value: string } | undefined;
    expect(legacySyncVersion).toEqual({ value: '0' });
    expect(freshSyncVersion).toEqual({ value: '0' });

    // Verify both stamped with current version
    const legacyVersion = legacyDb.pragma('user_version', { simple: true }) as number;
    const freshVersion = freshDb.pragma('user_version', { simple: true }) as number;
    expect(legacyVersion).toBe(SCHEMA_VERSION);
    expect(freshVersion).toBe(SCHEMA_VERSION);

    legacyDb.close();
    freshDb.close();
  });

  it('fresh DB starts at current SCHEMA_VERSION', () => {
    const db = new Database(path.join(tmpDir, 'fresh.db'));
    createTables(db);
    migrateSchema(db);

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('migrateSchema is idempotent', () => {
    const db = new Database(path.join(tmpDir, 'idempotent.db'));
    createTables(db);
    migrateSchema(db);
    migrateSchema(db); // second call should be a no-op

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(SCHEMA_VERSION);

    db.close();
  });
});

import type Database from 'better-sqlite3';

export function createTables(db: Database.Database): void {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS notes (
      uuid TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      modified_at INTEGER NOT NULL,
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
  `);
}

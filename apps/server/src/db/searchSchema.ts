import type Database from 'better-sqlite3';

export function createSearchTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_index_state (
      uuid TEXT NOT NULL,
      level INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY (uuid, level)
    );

    CREATE TABLE IF NOT EXISTS search_jobs (
      job_id TEXT PRIMARY KEY,
      level INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','interrupted','failed')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      checkpoint TEXT,
      notes_total INTEGER,
      notes_processed INTEGER DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS search_chunks (
      chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(uuid, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS search_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

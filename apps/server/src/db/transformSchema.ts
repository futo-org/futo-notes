import type Database from 'better-sqlite3';

export function createTransformTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transform_config (
      transform_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (transform_id, key)
    );

    CREATE TABLE IF NOT EXISTS transform_state (
      transform_id TEXT NOT NULL,
      uuid TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      result TEXT,
      PRIMARY KEY (transform_id, uuid)
    );

    CREATE TABLE IF NOT EXISTS transform_jobs (
      job_id TEXT PRIMARY KEY,
      transform_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','interrupted','failed')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      checkpoint TEXT,
      notes_total INTEGER,
      notes_processed INTEGER DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS transform_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transform_id TEXT NOT NULL,
      uuid TEXT NOT NULL,
      action TEXT NOT NULL,
      old_filename TEXT,
      new_filename TEXT,
      executed_at INTEGER NOT NULL
    );
  `);
}

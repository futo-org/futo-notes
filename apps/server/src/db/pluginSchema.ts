import type Database from 'better-sqlite3';

export function createPluginTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      plugin_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('manual', 'daily', 'weekly')),
      schedule_time TEXT,
      schedule_day INTEGER,
      auto_apply INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugin_state (
      plugin_id TEXT NOT NULL,
      state_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, state_key)
    );

    CREATE TABLE IF NOT EXISTS plugin_runs (
      run_id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual', 'scheduled')),
      apply_mode TEXT NOT NULL CHECK(apply_mode IN ('preview', 'auto_apply')),
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error_message TEXT,
      summary_json TEXT
    );

    CREATE TABLE IF NOT EXISTS plugin_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
      message TEXT NOT NULL,
      context_json TEXT
    );

    CREATE TABLE IF NOT EXISTS plugin_run_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('note')),
      entity_id TEXT NOT NULL,
      change_type TEXT NOT NULL CHECK(change_type IN ('rename_note')),
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL,
      status TEXT NOT NULL CHECK(status IN ('suggested', 'approved', 'rejected', 'applied', 'failed')),
      failure_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      applied_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_runs_plugin ON plugin_runs(plugin_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plugin_run_logs_run ON plugin_run_logs(run_id, timestamp ASC);
    CREATE INDEX IF NOT EXISTS idx_plugin_run_items_run ON plugin_run_items(run_id, id ASC);
    CREATE INDEX IF NOT EXISTS idx_plugin_run_items_status ON plugin_run_items(run_id, status);
  `);
}

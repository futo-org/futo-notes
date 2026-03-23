import type Database from 'better-sqlite3';
import { tableColumns, tableExists, tableSql } from './utils.js';

function ensurePluginInstallsSchema(db: Database.Database): void {
  if (tableExists(db, 'plugin_installs')) {
    const columns = new Set(tableColumns(db, 'plugin_installs'));
    const isLegacyInstallTable = !columns.has('source_kind');

    if (isLegacyInstallTable) {
      db.exec(`
        DROP TABLE IF EXISTS plugin_installs_legacy;
        ALTER TABLE plugin_installs RENAME TO plugin_installs_legacy;
      `);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_installs (
      plugin_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('local')),
      source_path TEXT NOT NULL,
      compiled_path TEXT NOT NULL,
      load_status TEXT NOT NULL CHECK(load_status IN ('ready', 'error')),
      load_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `);

  const columns = new Set(tableColumns(db, 'plugin_installs'));
  if (!columns.has('deleted_at')) {
    db.exec('ALTER TABLE plugin_installs ADD COLUMN deleted_at INTEGER;');
  }
  if (!columns.has('load_error')) {
    db.exec('ALTER TABLE plugin_installs ADD COLUMN load_error TEXT;');
  }
}

function ensurePluginRunItemsSchema(db: Database.Database): void {
  if (!tableExists(db, 'plugin_run_items')) {
    return;
  }

  const sql = tableSql(db, 'plugin_run_items') ?? '';
  if (
    sql.includes('merge_note_into_list')
    && sql.includes('replace_managed_block')
    && sql.includes('tag_note')
  ) {
    return;
  }

  db.exec(`
    DROP TABLE IF EXISTS plugin_run_items_legacy;
    ALTER TABLE plugin_run_items RENAME TO plugin_run_items_legacy;

    CREATE TABLE plugin_run_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('note')),
      entity_id TEXT NOT NULL,
      change_type TEXT NOT NULL CHECK(change_type IN ('rename_note', 'merge_note_into_list', 'replace_managed_block', 'tag_note', 'create_note')),
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

    INSERT INTO plugin_run_items (
      id, run_id, entity_type, entity_id, change_type, before_json, after_json, preview_json,
      reason, confidence, status, failure_message, created_at, updated_at, applied_at
    )
    SELECT
      id, run_id, entity_type, entity_id, change_type, before_json, after_json, preview_json,
      reason, confidence, status, failure_message, created_at, updated_at, applied_at
    FROM plugin_run_items_legacy;

    DROP TABLE plugin_run_items_legacy;

    CREATE INDEX IF NOT EXISTS idx_plugin_run_items_run ON plugin_run_items(run_id, id ASC);
    CREATE INDEX IF NOT EXISTS idx_plugin_run_items_status ON plugin_run_items(run_id, status);
  `);
}

export function createPluginTables(db: Database.Database): void {
  ensurePluginInstallsSchema(db);

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
      change_type TEXT NOT NULL CHECK(change_type IN ('rename_note', 'merge_note_into_list', 'replace_managed_block', 'tag_note', 'create_note')),
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
    CREATE INDEX IF NOT EXISTS idx_plugin_installs_active ON plugin_installs(deleted_at, updated_at DESC);
  `);

  ensurePluginRunItemsSchema(db);
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPluginTables } from '../../src/db/pluginSchema.js';
import { tableExists, tableColumns } from '../../src/db/utils.js';

describe('pluginSchema migrations', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'plugin-schema-test-'));
    db = new Database(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all plugin tables on a fresh database', () => {
    createPluginTables(db);

    expect(tableExists(db, 'plugin_installs')).toBe(true);
    expect(tableExists(db, 'plugins')).toBe(true);
    expect(tableExists(db, 'plugin_state')).toBe(true);
    expect(tableExists(db, 'plugin_runs')).toBe(true);
    expect(tableExists(db, 'plugin_run_logs')).toBe(true);
    expect(tableExists(db, 'plugin_run_items')).toBe(true);
  });

  it('migrates legacy plugin_installs table missing source_kind column', () => {
    db.exec(`
      CREATE TABLE plugin_installs (
        plugin_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        compiled_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO plugin_installs (plugin_id, path, compiled_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('test-plugin', '/path/to/plugin', '/path/to/compiled', 1000, 2000);

    createPluginTables(db);

    expect(tableExists(db, 'plugin_installs_legacy')).toBe(true);
    const cols = tableColumns(db, 'plugin_installs');
    expect(cols).toContain('source_kind');
    expect(cols).toContain('deleted_at');
    expect(cols).toContain('load_error');
  });

  it('adds deleted_at column to plugin_installs if missing', () => {
    db.exec(`
      CREATE TABLE plugin_installs (
        plugin_id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_path TEXT NOT NULL,
        compiled_path TEXT NOT NULL,
        load_status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    createPluginTables(db);

    const cols = tableColumns(db, 'plugin_installs');
    expect(cols).toContain('deleted_at');
    expect(cols).toContain('load_error');
  });

  it('migrates plugin_run_items when table exists with outdated schema', () => {
    db.exec(`
      CREATE TABLE plugin_run_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        change_type TEXT NOT NULL CHECK(change_type IN ('rename_note')),
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL,
        status TEXT NOT NULL,
        failure_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO plugin_run_items (run_id, entity_type, entity_id, change_type, before_json, after_json, preview_json, reason, confidence, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('run1', 'note', 'note1', 'rename_note', '{}', '{}', '{}', 'test', 0.9, 'suggested', 1000, 2000);

    createPluginTables(db);

    const rows = db.prepare('SELECT * FROM plugin_run_items').all() as Array<{ run_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe('run1');
  });

  it('skips plugin_run_items migration when schema already has all change types', () => {
    createPluginTables(db);
    db.prepare(`
      INSERT INTO plugin_run_items (run_id, entity_type, entity_id, change_type, before_json, after_json, preview_json, reason, confidence, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('run1', 'note', 'note1', 'rename_note', '{}', '{}', '{}', 'test', 0.9, 'suggested', 1000, 2000);

    createPluginTables(db);

    const rows = db.prepare('SELECT * FROM plugin_run_items').all() as Array<{ run_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe('run1');
  });
});

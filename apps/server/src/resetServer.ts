import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { createPluginTables } from './db/pluginSchema.js';
import { createSearchTables } from './db/searchSchema.js';
import { createTables, migrateSchema } from './db/schema.js';
import { tableExists } from './db/utils.js';
import { removeAllClients } from './events.js';
import { log } from './logger.js';

export interface ResetServerResult {
  success: true;
  notes_deleted: number;
  sessions_revoked: number;
  setup_cleared: true;
}

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function getCount(db: Database.Database, tableName: string): number {
  if (!TABLE_NAME_RE.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  if (!tableExists(db, tableName)) return 0;
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

function wipeNotesDirectory(notesPath: string): void {
  const notesDir = path.resolve(notesPath);
  fs.rmSync(notesDir, { recursive: true, force: true });
  fs.mkdirSync(notesDir, { recursive: true });
}

function wipeSearchArtifacts(databasePath: string): void {
  const artifactDir = path.join(path.dirname(path.resolve(databasePath)), 'search-artifacts');
  fs.rmSync(artifactDir, { recursive: true, force: true });
}

function wipePluginsDirectory(pluginsPath: string): void {
  fs.rmSync(path.resolve(pluginsPath), { recursive: true, force: true });
  fs.mkdirSync(path.resolve(pluginsPath), { recursive: true });
}

export async function performServerReset(
  db: Database.Database,
  config: Config,
  reason: string,
): Promise<ResetServerResult> {
  const notesBefore = getCount(db, 'notes');
  const sessionsBefore = getCount(db, 'sessions');

  log.warn(`${reason}: erasing all notes, clearing auth, and revoking every session`);

  if (config.searchEnabled) {
    try {
      const { stopSearchScheduler } = await import('./search/scheduler.js');
      stopSearchScheduler();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${reason}: failed to stop search scheduler cleanly: ${message}`);
    }
  }
  if (config.pluginsEnabled) {
    try {
      const { stopPluginScheduler } = await import('./plugins/scheduler.js');
      stopPluginScheduler();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${reason}: failed to stop plugin scheduler cleanly: ${message}`);
    }
  }

  removeAllClients();

  db.exec(`
    DROP TABLE IF EXISTS note_tags;
    DROP TABLE IF EXISTS tombstones;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS auth;
    DROP TABLE IF EXISTS sync_meta;
  `);
  createTables(db);
  migrateSchema(db);

  db.exec(`
    DROP TABLE IF EXISTS search_chunks;
    DROP TABLE IF EXISTS search_jobs;
    DROP TABLE IF EXISTS search_index_state;
    DROP TABLE IF EXISTS search_config;
  `);
  try {
    db.exec('DROP TABLE IF EXISTS search_vectors');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`${reason}: unable to drop search_vectors (continuing): ${message}`);
  }
  if (config.searchEnabled) {
    createSearchTables(db);
  }

  db.exec(`
    DROP TABLE IF EXISTS plugin_run_logs;
    DROP TABLE IF EXISTS plugin_run_items;
    DROP TABLE IF EXISTS plugin_runs;
    DROP TABLE IF EXISTS plugin_state;
    DROP TABLE IF EXISTS plugins;
    DROP TABLE IF EXISTS transform_history;
    DROP TABLE IF EXISTS transform_jobs;
    DROP TABLE IF EXISTS transform_state;
    DROP TABLE IF EXISTS transform_config;
    DROP TABLE IF EXISTS plugin_installs;
  `);
  if (config.pluginsEnabled) {
    createPluginTables(db);
  }

  wipeNotesDirectory(config.notesPath);
  wipeSearchArtifacts(config.databasePath);
  wipePluginsDirectory(config.pluginsPath);

  if (config.searchEnabled) {
    try {
      const { startSearchScheduler } = await import('./search/scheduler.js');
      startSearchScheduler(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${reason}: failed to restart search scheduler: ${message}`);
    }
  }
  if (config.pluginsEnabled) {
    try {
      const { startPluginScheduler } = await import('./plugins/scheduler.js');
      startPluginScheduler(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${reason}: failed to restart plugin scheduler: ${message}`);
    }
  }

  log.warn(`${reason} complete: server returned to fresh-install state`);
  return {
    success: true,
    notes_deleted: notesBefore,
    sessions_revoked: sessionsBefore,
    setup_cleared: true,
  };
}

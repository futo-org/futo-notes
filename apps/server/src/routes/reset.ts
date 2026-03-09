import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { authMiddleware, type AuthEnv } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { createTables } from '../db/schema.js';
import { createSearchTables } from '../db/searchSchema.js';
import { createPluginTables } from '../db/pluginSchema.js';
import { loadConfig } from '../config.js';
import { removeAllClients } from '../events.js';
import { log } from '../logger.js';

interface ResetRequest {
  confirmation?: string;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    `SELECT 1 as found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
  ).get(tableName) as { found: number } | undefined;
  return row !== undefined;
}

function getCount(db: Database.Database, tableName: string): number {
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

const reset = new Hono<AuthEnv>();

reset.post('/reset', authMiddleware, async (c) => {
  let body: ResetRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (body.confirmation !== 'DELETE') {
    return c.json({ error: 'Confirmation mismatch — send confirmation as "DELETE"' }, 400);
  }

  const db = getDb();
  const config = loadConfig();
  const notesBefore = getCount(db, 'notes');
  const sessionsBefore = getCount(db, 'sessions');

  log.warn('RESET: erasing all notes, clearing auth, and revoking every session');

  if (config.searchEnabled) {
    try {
      const { stopSearchScheduler } = await import('../search/scheduler.js');
      stopSearchScheduler();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`RESET: failed to stop search scheduler cleanly: ${message}`);
    }
  }
  if (config.pluginsEnabled) {
    try {
      const { stopPluginScheduler } = await import('../plugins/scheduler.js');
      stopPluginScheduler();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`RESET: failed to stop plugin scheduler cleanly: ${message}`);
    }
  }

  // Immediately close SSE streams so connected devices are kicked out now.
  removeAllClients();

  db.exec(`
    DROP TABLE IF EXISTS tombstones;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS auth;
  `);
  createTables(db);

  // Reset search state (best effort when vec table cannot be opened).
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
    log.warn(`RESET: unable to drop search_vectors (continuing): ${message}`);
  }
  if (config.searchEnabled) {
    createSearchTables(db);
  }
  db.exec(`
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
      const { startSearchScheduler } = await import('../search/scheduler.js');
      startSearchScheduler(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`RESET: failed to restart search scheduler: ${message}`);
    }
  }
  if (config.pluginsEnabled) {
    try {
      const { syncBuiltinPlugins } = await import('../plugins/loader.js');
      syncBuiltinPlugins(db, config);
      const { startPluginScheduler } = await import('../plugins/scheduler.js');
      startPluginScheduler(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`RESET: failed to restart plugin scheduler: ${message}`);
    }
  }

  log.warn('RESET complete: server returned to fresh-install state');
  return c.json({
    success: true,
    notes_deleted: notesBefore,
    sessions_revoked: sessionsBefore,
    setup_cleared: true,
  });
});

export default reset;

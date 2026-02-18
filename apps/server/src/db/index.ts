import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createTables } from './schema.js';

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables(db);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

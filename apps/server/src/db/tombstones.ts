import type Database from 'better-sqlite3';

export interface TombstoneRow {
  uuid: string;
  deleted_at: string;
}

export function getTombstone(db: Database.Database, uuid: string): TombstoneRow | null {
  return (
    (db.prepare('SELECT * FROM tombstones WHERE uuid = ?').get(uuid) as TombstoneRow | undefined) ??
    null
  );
}

export function getAllTombstones(db: Database.Database): TombstoneRow[] {
  return db.prepare('SELECT * FROM tombstones').all() as TombstoneRow[];
}

export function createTombstone(db: Database.Database, uuid: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO tombstones (uuid) VALUES (?)',
  ).run(uuid);
}

export function deleteTombstone(db: Database.Database, uuid: string): number {
  return db.prepare('DELETE FROM tombstones WHERE uuid = ?').run(uuid).changes;
}

/** Default max age: 90 days in milliseconds */
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Delete tombstones older than maxAgeMs (default 90 days).
 * The `deleted_at` column stores datetime('now') as an ISO string in UTC.
 * Returns the number of pruned rows.
 */
export function pruneTombstones(db: Database.Database, maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
  const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();
  return db.prepare('DELETE FROM tombstones WHERE deleted_at < ?').run(cutoffDate).changes;
}

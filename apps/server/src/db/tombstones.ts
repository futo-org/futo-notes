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

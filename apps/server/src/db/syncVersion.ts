import type Database from 'better-sqlite3';

export function getSyncVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'sync_version'").get() as
    | { value: string }
    | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function incrementSyncVersion(db: Database.Database): number {
  db.prepare(
    "UPDATE sync_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'sync_version'",
  ).run();
  return getSyncVersion(db);
}

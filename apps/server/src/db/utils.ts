import type Database from 'better-sqlite3';

export function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    `SELECT 1 as found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
  ).get(tableName) as { found: number } | undefined;
  return row !== undefined;
}

export function tableColumns(db: Database.Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function tableSql(db: Database.Database, tableName: string): string | null {
  const row = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

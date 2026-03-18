import type Database from 'better-sqlite3';

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    `SELECT 1 as found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
  ).get(tableName) as { found: number } | undefined;
  return row !== undefined;
}

export function tableColumns(db: Database.Database, tableName: string): string[] {
  if (!TABLE_NAME_RE.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
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

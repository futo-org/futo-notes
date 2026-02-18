import type Database from 'better-sqlite3';

export function createSession(db: Database.Database, tokenHash: string, deviceInfo?: string): void {
  db.prepare('INSERT INTO sessions (token_hash, device_info) VALUES (?, ?)').run(
    tokenHash,
    deviceInfo ?? null,
  );
}

export function sessionExists(db: Database.Database, tokenHash: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as { 1: number } | undefined;
  return row !== undefined;
}

export function deleteSession(db: Database.Database, tokenHash: string): number {
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes;
}

export function deleteAllSessions(db: Database.Database): number {
  return db.prepare('DELETE FROM sessions').run().changes;
}

export function deleteSessions(db: Database.Database, tokenHashes: string[]): number {
  if (tokenHashes.length === 0) return 0;
  const placeholders = tokenHashes.map(() => '?').join(',');
  return db
    .prepare(`DELETE FROM sessions WHERE token_hash IN (${placeholders})`)
    .run(...tokenHashes).changes;
}

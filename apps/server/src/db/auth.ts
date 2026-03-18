import type Database from 'better-sqlite3';

export function getPasswordHash(db: Database.Database): string | null {
  const row = db.prepare('SELECT password_hash FROM auth WHERE id = 1').get() as
    | { password_hash: string }
    | undefined;
  return row?.password_hash ?? null;
}

export function setPasswordHash(db: Database.Database, hash: string): void {
  db.prepare('INSERT INTO auth (id, password_hash) VALUES (1, ?)').run(hash);
}

export function updatePasswordHash(db: Database.Database, hash: string): void {
  db.prepare('UPDATE auth SET password_hash = ? WHERE id = 1').run(hash);
}

export function isSetupComplete(db: Database.Database): boolean {
  return getPasswordHash(db) !== null;
}

import type Database from 'better-sqlite3';

export interface NoteRow {
  uuid: string;
  filename: string;
  content_hash: string;
  modified_at: number;
  created_at: string;
  is_blob: number;
}

export function getNote(db: Database.Database, uuid: string): NoteRow | null {
  return (db.prepare('SELECT * FROM notes WHERE uuid = ?').get(uuid) as NoteRow | undefined) ?? null;
}

export function getAllNotes(db: Database.Database): NoteRow[] {
  return db.prepare('SELECT * FROM notes').all() as NoteRow[];
}

export function upsertNote(
  db: Database.Database,
  uuid: string,
  filename: string,
  contentHash: string,
  modifiedAt: number,
  isBlob?: boolean,
): void {
  db.prepare(
    `INSERT INTO notes (uuid, filename, content_hash, modified_at, is_blob)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       filename = excluded.filename,
       content_hash = excluded.content_hash,
       modified_at = excluded.modified_at,
       is_blob = excluded.is_blob`,
  ).run(uuid, filename, contentHash, modifiedAt, isBlob ? 1 : 0);
}

export function deleteNote(db: Database.Database, uuid: string): number {
  return db.prepare('DELETE FROM notes WHERE uuid = ?').run(uuid).changes;
}

export function getNoteByFilename(db: Database.Database, filename: string, excludeUuid?: string): NoteRow | null {
  if (excludeUuid) {
    return (
      (db
        .prepare('SELECT * FROM notes WHERE filename = ? AND uuid != ?')
        .get(filename, excludeUuid) as NoteRow | undefined) ?? null
    );
  }
  return (
    (db.prepare('SELECT * FROM notes WHERE filename = ?').get(filename) as NoteRow | undefined) ??
    null
  );
}

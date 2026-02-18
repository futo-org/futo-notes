import type Database from 'better-sqlite3';
import { getAllNotes, upsertNote, deleteNote } from '../db/notes.js';
import { listNoteFiles, readNoteFile } from './files.js';
import { contentHash } from './hash.js';

/**
 * Reconcile the database with actual files on disk.
 * - Updates hashes for files that changed since last DB write
 * - Removes DB entries for files that no longer exist on disk
 * - Adds DB entries for files on disk that aren't in the DB
 */
export function reconcile(db: Database.Database, notesDir: string): void {
  const dbNotes = getAllNotes(db);
  const diskFiles = new Set(listNoteFiles(notesDir));

  // Check DB entries against disk
  for (const note of dbNotes) {
    if (!diskFiles.has(note.filename)) {
      // File missing from disk — remove DB entry
      deleteNote(db, note.uuid);
      continue;
    }

    // File exists — check hash
    const content = readNoteFile(notesDir, note.filename);
    if (content !== null) {
      const hash = contentHash(content);
      if (hash !== note.content_hash) {
        upsertNote(db, note.uuid, note.filename, hash, Date.now());
      }
    }

    diskFiles.delete(note.filename);
  }

  // Remaining disk files have no DB entry — add them
  for (const filename of diskFiles) {
    const content = readNoteFile(notesDir, filename);
    if (content !== null) {
      const uuid = crypto.randomUUID();
      const hash = contentHash(content);
      upsertNote(db, uuid, filename, hash, Date.now());
    }
  }
}

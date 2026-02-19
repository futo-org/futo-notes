import type Database from 'better-sqlite3';
import { getAllNotes, upsertNote, deleteNote } from '../db/notes.js';
import { listNoteFiles, readNoteFile } from './files.js';
import { contentHash } from './hash.js';
import { log } from '../logger.js';

/**
 * Reconcile the database with actual files on disk.
 * - Updates hashes for files that changed since last DB write
 * - Removes DB entries for files that no longer exist on disk
 * - Adds DB entries for files on disk that aren't in the DB
 */
export function reconcile(db: Database.Database, notesDir: string): void {
  const dbNotes = getAllNotes(db);
  const diskFiles = new Set(listNoteFiles(notesDir));

  let removed = 0;
  let hashUpdated = 0;
  let added = 0;

  // Check DB entries against disk
  for (const note of dbNotes) {
    if (!diskFiles.has(note.filename)) {
      // File missing from disk — remove DB entry
      log.debug(`  reconcile: removing ${note.filename} (missing from disk)`);
      deleteNote(db, note.uuid);
      removed++;
      continue;
    }

    // File exists — check hash
    const content = readNoteFile(notesDir, note.filename);
    if (content !== null) {
      const hash = contentHash(content);
      if (hash !== note.content_hash) {
        log.debug(`  reconcile: hash updated for ${note.filename}`);
        upsertNote(db, note.uuid, note.filename, hash, Date.now());
        hashUpdated++;
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
      log.debug(`  reconcile: adding new file ${filename}`);
      upsertNote(db, uuid, filename, hash, Date.now());
      added++;
    }
  }

  log.info(`reconcile done: removed=${removed} hash_updated=${hashUpdated} added=${added}`);
}

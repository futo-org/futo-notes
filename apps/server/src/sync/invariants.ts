import type Database from 'better-sqlite3';
import path from 'node:path';
import type { SyncResponse } from '@futo-notes/shared';
import { isImageFilename } from '@futo-notes/shared';
import { getAllNotes, type NoteRow } from '../db/notes.js';
import { readNoteFile, readBlobFile, listNoteFiles, listImageFiles } from './files.js';
import { contentHash, binaryContentHash } from './hash.js';

export interface InvariantResult {
  passed: boolean;
  violations: string[];
}

/**
 * Check post-sync invariants against DB + disk state.
 *
 * Runs after handlePostSync() returns so the DB reflects final state
 * including tombstones and search-dirty markers from applyNoteMutationEffects.
 */
export function checkPostSyncInvariants(
  db: Database.Database,
  notesDir: string,
  _response: SyncResponse,
  versionBefore: number,
  versionAfter: number,
): InvariantResult {
  const violations: string[] = [];
  const notes = getAllNotes(db);

  checkContentHashParity(notes, notesDir, violations);
  checkOrphanedFiles(notes, notesDir, violations);
  checkBlobExtensionParity(notes, violations);
  checkDuplicateFilenames(db, violations);
  checkTombstoneNoteExclusion(db, violations);
  checkMonotonicVersion(versionBefore, versionAfter, violations);

  return { passed: violations.length === 0, violations };
}

/**
 * Invariant 1: DB content_hash matches actual file content on disk.
 * Catches the `content ?? ''` class of bug — engine writes wrong content
 * but records original hash, or vice versa.
 */
function checkContentHashParity(notes: NoteRow[], notesDir: string, violations: string[]): void {
  for (const note of notes) {
    if (note.is_blob) {
      const data = readBlobFile(notesDir, note.filename);
      if (data === null) {
        violations.push(`content-parity: blob ${note.uuid} (${note.filename}) missing from disk`);
        continue;
      }
      const diskHash = binaryContentHash(data);
      if (diskHash !== note.content_hash) {
        violations.push(
          `content-parity: blob ${note.uuid} (${note.filename}) hash mismatch — ` +
          `db=${note.content_hash.slice(0, 12)} disk=${diskHash.slice(0, 12)}`,
        );
      }
    } else {
      const content = readNoteFile(notesDir, note.filename);
      if (content === null) {
        violations.push(`content-parity: note ${note.uuid} (${note.filename}) missing from disk`);
        continue;
      }
      const diskHash = contentHash(content);
      if (diskHash !== note.content_hash) {
        violations.push(
          `content-parity: note ${note.uuid} (${note.filename}) hash mismatch — ` +
          `db=${note.content_hash.slice(0, 12)} disk=${diskHash.slice(0, 12)}`,
        );
      }
    }
  }
}

/**
 * Invariant 2: No orphaned files on disk.
 * Every .md and image file in notesDir must have a corresponding DB entry.
 */
function checkOrphanedFiles(notes: NoteRow[], notesDir: string, violations: string[]): void {
  const dbFilenames = new Set(notes.map((n) => n.filename));
  const diskMd = listNoteFiles(notesDir);
  const diskImages = listImageFiles(notesDir);

  for (const f of [...diskMd, ...diskImages]) {
    if (!dbFilenames.has(f)) {
      violations.push(`orphaned-file: ${f} exists on disk but not in DB`);
    }
  }
}

/**
 * Invariant 3: Note/blob extension parity.
 * is_blob=1 → image extension. is_blob=0 → .md extension.
 */
function checkBlobExtensionParity(notes: NoteRow[], violations: string[]): void {
  for (const note of notes) {
    const isImage = isImageFilename(note.filename);
    if (note.is_blob && !isImage) {
      violations.push(
        `blob-extension: note ${note.uuid} has is_blob=1 but filename ${note.filename} is not an image`,
      );
    }
    if (!note.is_blob && isImage) {
      violations.push(
        `blob-extension: note ${note.uuid} has is_blob=0 but filename ${note.filename} is an image`,
      );
    }
  }
}

/**
 * Invariant 4: No duplicate filenames in DB.
 */
function checkDuplicateFilenames(db: Database.Database, violations: string[]): void {
  const rows = db
    .prepare('SELECT filename, COUNT(*) as cnt FROM notes GROUP BY filename HAVING cnt > 1')
    .all() as Array<{ filename: string; cnt: number }>;
  for (const row of rows) {
    violations.push(`duplicate-filename: "${row.filename}" appears ${row.cnt} times in DB`);
  }
}

/**
 * Invariant 5: No tombstone references an active note.
 */
function checkTombstoneNoteExclusion(db: Database.Database, violations: string[]): void {
  const rows = db
    .prepare('SELECT t.uuid FROM tombstones t INNER JOIN notes n ON t.uuid = n.uuid')
    .all() as Array<{ uuid: string }>;
  for (const row of rows) {
    violations.push(`tombstone-note-overlap: uuid ${row.uuid} is both a tombstone and an active note`);
  }
}

/**
 * Invariant 6: sync_version is monotonically non-decreasing.
 */
function checkMonotonicVersion(
  versionBefore: number,
  versionAfter: number,
  violations: string[],
): void {
  if (versionAfter < versionBefore) {
    violations.push(
      `version-regression: version went from ${versionBefore} to ${versionAfter}`,
    );
  }
}

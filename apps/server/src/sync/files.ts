import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getNoteByFilename } from '../db/notes.js';

/**
 * Sanitize a client-provided filename for safe filesystem storage.
 * - Strips path traversal sequences, leading slashes, path separators
 * - Strips control characters (< 0x20) and DEL (0x7F)
 * - Replaces Windows-reserved characters with `_`
 * - Truncates to 200 chars (before .md extension)
 * - Returns `untitled.md` if result is empty or dot-only
 */
export function sanitizeFilename(raw: string): string {
  let name = raw;

  // Strip path separators and traversal
  name = name.replace(/\.\./g, '');
  name = name.replace(/[/\\]/g, '');

  // Strip control characters and DEL
  name = name.replace(/[\x00-\x1f\x7f]/g, '');

  // Replace Windows-reserved characters
  name = name.replace(/[<>:"|?*]/g, '_');

  // Ensure .md extension
  const ext = '.md';
  if (name.toLowerCase().endsWith(ext)) {
    name = name.slice(0, -ext.length);
  }

  // Trim whitespace and dots
  name = name.replace(/^[\s.]+|[\s.]+$/g, '');

  // Truncate to 200 chars
  if (name.length > 200) {
    name = name.slice(0, 200).trimEnd();
  }

  // Fallback
  if (!name) {
    name = 'untitled';
  }

  return name + ext;
}

/**
 * Resolve a safe, unique filename for a note UUID.
 * If the sanitized name collides with a different UUID in the DB, appends ` (2)`, ` (3)`, etc.
 */
export function resolveFilename(db: Database.Database, sanitized: string, uuid: string): string {
  const ext = '.md';
  const base = sanitized.slice(0, -ext.length);

  let candidate = sanitized;
  let counter = 1;
  while (getNoteByFilename(db, candidate, uuid)) {
    counter++;
    candidate = `${base} (${counter})${ext}`;
  }
  return candidate;
}

/**
 * Generate a conflict copy filename.
 * Format: `title (conflict YYYY-MM-DD).md`, with counter if needed.
 */
export function conflictFilename(
  db: Database.Database,
  originalFilename: string,
  uuid: string,
): string {
  const ext = '.md';
  const base = originalFilename.endsWith(ext)
    ? originalFilename.slice(0, -ext.length)
    : originalFilename;

  const date = new Date().toISOString().split('T')[0];
  let candidate = `${base} (conflict ${date})${ext}`;

  let counter = 1;
  while (getNoteByFilename(db, candidate, uuid)) {
    counter++;
    candidate = `${base} (conflict ${date} ${counter})${ext}`;
  }
  return candidate;
}

/** Write a note's content to disk. */
export function writeNoteFile(notesDir: string, filename: string, content: string): void {
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, filename), content, 'utf8');
}

/** Read a note's content from disk. Returns null if file doesn't exist. */
export function readNoteFile(notesDir: string, filename: string): string | null {
  try {
    return fs.readFileSync(path.join(notesDir, filename), 'utf8');
  } catch {
    return null;
  }
}

/** Delete a note file from disk. Silently ignores missing files. */
export function deleteNoteFile(notesDir: string, filename: string): void {
  try {
    fs.unlinkSync(path.join(notesDir, filename));
  } catch {
    // File may already be gone — that's fine
  }
}

/** List all .md files in the notes directory. */
export function listNoteFiles(notesDir: string): string[] {
  try {
    return fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

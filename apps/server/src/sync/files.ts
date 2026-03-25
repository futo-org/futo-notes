import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getNoteByFilename } from '../db/notes.js';
import { sanitizeTitle, isImageFilename } from '@futo-notes/shared';

/**
 * Sanitize a client-provided filename for safe filesystem storage.
 * Delegates core filename rules to shared sanitizeTitle(), then adds
 * server-specific security:
 * - Strips path traversal (..) and path separators
 * - Normalizes .md extension
 */
export function sanitizeFilename(raw: string): string {
  let name = raw;

  // Server-specific: strip path traversal and separators
  name = name.replace(/\.\./g, '');
  name = name.replace(/[/\\]/g, '');

  // Strip .md extension before passing to shared sanitizer
  const ext = '.md';
  if (name.toLowerCase().endsWith(ext)) {
    name = name.slice(0, -ext.length);
  }

  // Delegate to shared rules
  name = sanitizeTitle(name);

  // Defense-in-depth: strip any leading dots that survived sanitization
  name = name.replace(/^\.+/, '') || 'Untitled';

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

/** Write a note's content to disk and optionally set a specific mtime (ms since epoch). */
export function writeNoteFile(
  notesDir: string,
  filename: string,
  content: string,
  modifiedAtMs?: number,
): void {
  fs.mkdirSync(notesDir, { recursive: true });
  const fullPath = path.join(notesDir, filename);
  fs.writeFileSync(fullPath, content, 'utf8');

  if (typeof modifiedAtMs === 'number' && Number.isFinite(modifiedAtMs) && modifiedAtMs >= 0) {
    const ts = new Date(modifiedAtMs);
    fs.utimesSync(fullPath, ts, ts);
  }
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

/**
 * Convert any .txt files in the notes directory to .md (one-way migration).
 * If a collision exists (same name with .md already present), renames to `name (imported).md`.
 */
export function convertTxtFiles(notesDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(notesDir);
  } catch {
    return;
  }

  const mdSet = new Set(entries.filter((f) => f.endsWith('.md')).map((f) => f.toLowerCase()));

  for (const entry of entries) {
    if (!entry.endsWith('.txt')) continue;
    const base = entry.slice(0, -4); // strip .txt
    const mdName = `${base}.md`;

    let targetName: string;
    if (mdSet.has(mdName.toLowerCase())) {
      // Collision: both name.txt and name.md exist
      targetName = `${base} (imported).md`;
      // Handle unlikely double collision
      let counter = 2;
      while (mdSet.has(targetName.toLowerCase())) {
        targetName = `${base} (imported ${counter}).md`;
        counter++;
      }
    } else {
      targetName = mdName;
    }

    try {
      fs.renameSync(path.join(notesDir, entry), path.join(notesDir, targetName));
      mdSet.add(targetName.toLowerCase());
    } catch {
      // Skip files that can't be renamed (permissions, etc.)
    }
  }
}

/** List all .md files in the notes directory. Converts .txt files to .md first. */
export function listNoteFiles(notesDir: string): string[] {
  convertTxtFiles(notesDir);
  try {
    return fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

/** Write a binary blob file to disk and optionally set mtime. */
export function writeBlobFile(
  notesDir: string,
  filename: string,
  data: Buffer,
  modifiedAtMs?: number,
): void {
  fs.mkdirSync(notesDir, { recursive: true });
  const fullPath = path.join(notesDir, filename);
  fs.writeFileSync(fullPath, data);

  if (typeof modifiedAtMs === 'number' && Number.isFinite(modifiedAtMs) && modifiedAtMs >= 0) {
    const ts = new Date(modifiedAtMs);
    fs.utimesSync(fullPath, ts, ts);
  }
}

/** Read a binary blob file from disk. Returns null if file doesn't exist. */
export function readBlobFile(notesDir: string, filename: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(notesDir, filename));
  } catch {
    return null;
  }
}

/**
 * Sanitize a client-provided image filename.
 * Validates extension, strips path traversal. No title validation (machine-generated names).
 */
export function sanitizeImageFilename(raw: string): string {
  let name = raw;
  name = name.replace(/\.\./g, '');
  name = name.replace(/[/\\]/g, '');
  name = name.replace(/^\.+/, '');
  if (!name || !isImageFilename(name)) {
    throw new Error(`Invalid image filename: ${raw}`);
  }
  return name;
}

/** List all image files in the notes directory. */
export function listImageFiles(notesDir: string): string[] {
  try {
    return fs.readdirSync(notesDir).filter((f) => isImageFilename(f));
  } catch {
    return [];
  }
}

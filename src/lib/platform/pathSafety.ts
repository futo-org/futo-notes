/**
 * Path safety utilities — TypeScript port of `ensure_safe_note_id`,
 * `safe_note_path`, `safe_appdata_path`, and `note_id_from_filename`
 * from `crates/stonefruit-core/src/files.rs`.
 *
 * Character set reuses the same forbidden pattern as `@futo-notes/shared`
 * (`< > : " / \ | ? *` plus control chars 0x00-0x1F and 0x7F).
 */

// Build a non-global test regex from the same character set as shared.
// We avoid importing the global FORBIDDEN_CHARS_RE to sidestep lastIndex issues.
const CONTROL_CHARS = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('')
  + String.fromCharCode(127);
const FORBIDDEN_TEST = new RegExp(`[<>:"/\\\\|?*${CONTROL_CHARS}]`);

/**
 * Validate a note ID. Throws if the ID is unsafe.
 *
 * Rejects: empty, `.`, `..`, path separators (`/`, `\`), and
 * forbidden filesystem characters (`< > : " | ? *`, control chars).
 *
 * Allows: whitespace-only IDs (documented Rust behavior),
 * leading/trailing dots (unlike title validation).
 */
export function ensureSafeNoteId(id: string): void {
  if (id === '') {
    throw new Error('note id cannot be empty');
  }
  if (id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw new Error('invalid note id');
  }
  if (FORBIDDEN_TEST.test(id)) {
    throw new Error('invalid note id');
  }
}

/**
 * Build the full `.md` path for a note ID, after safety validation.
 * Returns `${base}/${id}.md`. Throws on invalid ID.
 */
export function safeNotePath(base: string, id: string): string {
  ensureSafeNoteId(id);
  return `${base}/${id}.md`;
}

/**
 * Build a path under `base` from a relative path, rejecting traversal.
 *
 * Rejects: absolute paths (leading `/`), `.` and `..` components, and
 * empty components (from double slashes). `.` components are rejected
 * because plugin-fs scope checks treat paths containing them as forbidden
 * on some platforms — callers that want "list everything under base"
 * should use listDirFiles() instead.
 * Returns `${base}/${relPath}`.
 */
export function safeAppdataPath(base: string, relPath: string): string {
  if (relPath.startsWith('/')) {
    throw new Error('path traversal blocked');
  }
  const components = relPath.split('/');
  for (const c of components) {
    if (c === '..' || c === '.' || c === '') {
      throw new Error('path traversal blocked');
    }
  }
  return `${base}/${relPath}`;
}

/**
 * Extract a note ID from a filename by stripping the `.md` suffix
 * (case-sensitive). Throws if the filename doesn't end with `.md`
 * or if the resulting ID is empty.
 */
export function noteIdFromFilename(filename: string): string {
  if (!filename.endsWith('.md')) {
    throw new Error('filename does not end with .md');
  }
  const id = filename.slice(0, -3);
  if (id === '') {
    throw new Error('note id cannot be empty');
  }
  return id;
}

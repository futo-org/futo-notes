/**
 * Path safety utilities — TypeScript port of `ensure_safe_note_id`,
 * `safe_note_path`, `safe_appdata_path`, and `note_id_from_filename`
 * from `crates/futo-notes-core/src/files.rs`.
 *
 * Per-component character set reuses the forbidden pattern from
 * `@futo-notes/shared` MINUS `/` (path separator) and `\` (always
 * rejected): `< > : " | ? *` plus control chars 0x00-0x1F and 0x7F.
 *
 * Note IDs may contain forward slashes as folder separators following
 * the move to path-as-ID. Each component is validated as a filename.
 */

import { MAX_FOLDER_DEPTH } from '$lib/rules';

const CONTROL_CHARS =
  Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + String.fromCharCode(127);
// Per-component forbidden pattern: same as shared minus `/` and `\` since
// `/` is a legal separator handled at the splitter and `\` is rejected at
// the top level.
const FORBIDDEN_COMPONENT_TEST = new RegExp(`[<>:"|?*${CONTROL_CHARS}]`);

function componentInvalid(component: string): boolean {
  if (component === '' || component === '.' || component === '..') {
    return true;
  }
  return FORBIDDEN_COMPONENT_TEST.test(component);
}

/**
 * Validate a note ID. Throws if the ID is unsafe.
 *
 * A note ID is the relative path from the notes root WITHOUT the `.md`
 * extension. Forward slashes are allowed between valid components.
 *
 * Rejects: empty, leading/trailing slash, `.` / `..` / empty components,
 * backslashes, excessive folder depth, and forbidden filesystem
 * characters in any component.
 */
export function ensureSafeNoteId(id: string): void {
  if (id === '') {
    throw new Error('note id cannot be empty');
  }
  if (id.includes('\\')) {
    throw new Error('invalid note id');
  }
  if (id.startsWith('/') || id.endsWith('/')) {
    throw new Error('invalid note id');
  }
  const components = id.split('/');
  if (components.length - 1 > MAX_FOLDER_DEPTH) {
    throw new Error('note id exceeds maximum folder depth');
  }
  for (const c of components) {
    if (componentInvalid(c)) {
      throw new Error('invalid note id');
    }
  }
}

/**
 * Build the full `.md` path for a note ID, after safety validation.
 * Returns `${base}/${id}.md`. The `id` may contain forward slashes
 * which become folder separators on disk.
 */
export function safeNotePath(base: string, id: string): string {
  ensureSafeNoteId(id);
  return `${base}/${id}.md`;
}

/** Return the parent directory of `safeNotePath(base, id)` — the folder
 *  the file lives in. For root-level notes this is `base` itself. */
export function noteParentDir(base: string, id: string): string {
  ensureSafeNoteId(id);
  const slash = id.lastIndexOf('/');
  if (slash === -1) return base;
  return `${base}/${id.slice(0, slash)}`;
}

/** Parent folder path of a note/folder ID. `'A/B/C'` → `'A/B'`, `'A'` → `''`. */
export function idParent(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? '' : id.slice(0, slash);
}

/** Leaf component of a note/folder ID. `'A/B/C'` → `'C'`, `'A'` → `'A'`. */
export function idLeaf(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
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
 * Extract a note ID from a filename or relative path by stripping the
 * `.md` suffix (case-sensitive). Throws if the input doesn't end with
 * `.md` or if the resulting ID is empty.
 *
 * Accepts both flat filenames (`foo.md` → `foo`) and nested paths
 * (`Specs/folder.md` → `Specs/folder`). Backslashes are normalized to
 * forward slashes.
 */
export function noteIdFromFilename(filename: string): string {
  const normalized = filename.replace(/\\/g, '/');
  if (!normalized.endsWith('.md')) {
    throw new Error('filename does not end with .md');
  }
  const id = normalized.slice(0, -3);
  if (id === '') {
    throw new Error('note id cannot be empty');
  }
  return id;
}

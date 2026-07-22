/**
 * Single source of truth for filename/title sanitization rules.
 * Used by both client and server.
 */

/**
 * The visible (non-control) characters forbidden in a title. Exported so the
 * native title-spec generator (`scripts/gen-title-spec.ts`) can derive
 * `TitleSpec.swift` / `TitleSpec.kt` from the same source this file itself
 * builds `FORBIDDEN_PATTERN` from — one definition, no drift.
 */
export const FORBIDDEN_TITLE_CHARS_VISIBLE = '<>:"/\\|?*';

const CONTROL_CHARS =
  Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('') +
  String.fromCharCode(127);
// Escape the backslash in FORBIDDEN_TITLE_CHARS_VISIBLE for use inside a
// regex character class; the other visible chars need no escaping there.
const FORBIDDEN_PATTERN = `[${FORBIDDEN_TITLE_CHARS_VISIBLE.replace(/\\/g, '\\\\')}${CONTROL_CHARS}]`;

/** Global regex for replacing forbidden characters (use with `.replace()`). */
export const FORBIDDEN_CHARS_RE = new RegExp(FORBIDDEN_PATTERN, 'g');

/** Non-global regex for testing if a string contains forbidden characters. */
const FORBIDDEN_CHARS_TEST = new RegExp(FORBIDDEN_PATTERN);

/** Human-readable list of forbidden characters for UI messages. */
export const FORBIDDEN_CHARS_DISPLAY = '< > : " / \\ | ? *';

/** Maximum title length (characters, before .md extension). */
export const MAX_TITLE_LENGTH = 200;

/** Fallback title when input is empty or all-invalid. */
export const FALLBACK_TITLE = 'Untitled';

/** Legacy replacement char retained for compatibility with existing imports. */
export const REPLACEMENT_CHAR = '-';

export type FilenameIssueKind =
  | 'forbidden_chars'
  | 'leading_dots'
  | 'trailing_dots'
  | 'too_long'
  | 'empty'
  | 'reserved_name'
  | 'case_collision'
  | 'depth_exceeded';

/**
 * Maximum folder nesting depth from the notes root. Reject create/move
 * operations that would exceed this. Matches §UI/Sidebar in the spec.
 */
export const MAX_FOLDER_DEPTH = 10;

/**
 * Windows reserved device names. Matched case-insensitively. We enforce
 * these on every platform so a vault created on macOS or Linux still
 * syncs cleanly to a Windows client without the OS blocking a write.
 */
const WINDOWS_RESERVED_NAMES = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/** True if `name` (sans extension) is a Windows-reserved device name. */
export function isWindowsReservedName(name: string): boolean {
  const stem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
  return WINDOWS_RESERVED_NAMES.has(stem.toUpperCase());
}

export interface FilenameIssue {
  kind: FilenameIssueKind;
  message: string;
}

/**
 * Canonical title sanitization. Strips filesystem-breaking characters, then
 * leading/trailing dots (Windows drops trailing dots; a leading dot makes a
 * hidden dotfile the vault scan skips) and the whitespace those dots expose,
 * then de-reserves Windows device names (CON → CON_) so the result is a legal
 * filename on EVERY platform, not just macOS/Linux. IDEMPOTENT — the sync
 * boundary reuses it to heal peer-pushed names. Does not silently truncate.
 */
export function sanitizeTitle(title: string): string {
  let result = title.replace(FORBIDDEN_CHARS_RE, '').trim();
  result = result.replace(/^\.+|\.+$/g, '').trim();
  if (!result) return FALLBACK_TITLE;
  if (isWindowsReservedName(result)) {
    const dot = result.indexOf('.');
    return dot >= 0 ? `${result.slice(0, dot)}_${result.slice(dot)}` : `${result}_`;
  }
  return result;
}

/**
 * Validate a title and return a list of specific issues found.
 * Does NOT modify the title — use sanitizeTitle() for that.
 */
export function validateTitle(title: string): FilenameIssue[] {
  const issues: FilenameIssue[] = [];

  if (!title.trim()) {
    issues.push({ kind: 'empty', message: 'Title cannot be empty' });
    return issues;
  }

  if (FORBIDDEN_CHARS_TEST.test(title)) {
    issues.push({
      kind: 'forbidden_chars',
      message: "That character can't be used in a note title",
    });
  }

  if (/^\./.test(title)) {
    issues.push({
      kind: 'leading_dots',
      message: 'Title cannot start with a dot',
    });
  }

  if (/\.$/.test(title)) {
    issues.push({
      kind: 'trailing_dots',
      message: 'Title cannot end with a dot',
    });
  }

  if (title.length > MAX_TITLE_LENGTH) {
    issues.push({
      kind: 'too_long',
      message: `Title cannot exceed ${MAX_TITLE_LENGTH} characters`,
    });
  }

  return issues;
}

/** Convenience: returns true if the title has no validation issues. */
export function isValidTitle(title: string): boolean {
  return validateTitle(title).length === 0;
}

/**
 * Validate a single folder name (one path component). Layered on top of
 * `validateTitle`: same character/length/dots rules, plus Windows-reserved
 * name rejection.
 *
 * Sibling case-collision and depth checks live separately because they
 * need context (the parent folder's existing children, the parent's
 * depth) that this single-name check does not have.
 */
export function validateFolderName(name: string): FilenameIssue[] {
  const issues = validateTitle(name);
  if (isWindowsReservedName(name)) {
    issues.push({
      kind: 'reserved_name',
      message: `"${name}" is reserved on Windows and cannot be used as a folder name`,
    });
  }
  return issues;
}

/** Convenience: returns true if the folder name has no validation issues. */
export function isValidFolderName(name: string): boolean {
  return validateFolderName(name).length === 0;
}

/**
 * Check whether a proposed folder name collides with an existing sibling.
 * Compares case-insensitively across siblings — refuses to create two
 * folders at the same level whose names differ only in case. The
 * underlying filesystem may or may not be case-sensitive; we enforce this
 * ourselves to keep sync deterministic across mixed environments.
 */
export function hasCaseInsensitiveSiblingCollision(
  name: string,
  siblings: Iterable<string>,
): boolean {
  const lower = name.toLowerCase();
  for (const sibling of siblings) {
    if (sibling.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Validate a relative folder path: each component is a valid folder name,
 * total depth doesn't exceed MAX_FOLDER_DEPTH, no `.` / `..` / empty.
 */
export function validateFolderPath(relPath: string): FilenameIssue[] {
  const issues: FilenameIssue[] = [];
  const trimmed = relPath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    issues.push({ kind: 'empty', message: 'Folder path cannot be empty' });
    return issues;
  }
  const components = trimmed.split('/');
  if (components.length > MAX_FOLDER_DEPTH) {
    issues.push({
      kind: 'depth_exceeded',
      message: `Folder depth cannot exceed ${MAX_FOLDER_DEPTH}`,
    });
  }
  for (const component of components) {
    if (component === '' || component === '.' || component === '..') {
      issues.push({
        kind: 'forbidden_chars',
        message: 'Folder path contains an invalid component',
      });
      continue;
    }
    for (const issue of validateFolderName(component)) {
      issues.push(issue);
    }
  }
  return issues;
}

/** Returns true if a relative folder path is valid. */
export function isValidFolderPath(relPath: string): boolean {
  return validateFolderPath(relPath).length === 0;
}

/**
 * Compute the folder depth of a relative path (number of folder
 * components above the leaf — a flat note has depth 0). `relPath` is
 * the relative path of the note WITHOUT the `.md` extension; the leaf
 * filename is excluded from the count.
 */
export function pathDepth(relPath: string): number {
  const trimmed = relPath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 0;
  const components = trimmed.split('/');
  // depth = number of folders above the leaf
  return Math.max(0, components.length - 1);
}

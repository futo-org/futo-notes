/**
 * Single source of truth for filename/title sanitization rules.
 * Used by both client and server.
 */

/** Global regex for replacing forbidden characters (use with `.replace()`). */
export const FORBIDDEN_CHARS_RE = /[<>:"/\\|?*\x00-\x1f\x7f]/g;

/** Non-global regex for testing if a string contains forbidden characters. */
const FORBIDDEN_CHARS_TEST = /[<>:"/\\|?*\x00-\x1f\x7f]/;

/** Human-readable list of forbidden characters for UI messages. */
export const FORBIDDEN_CHARS_DISPLAY = '< > : " / \\ | ? *';

/** Maximum title length (characters, before .md extension). */
export const MAX_TITLE_LENGTH = 200;

/** Fallback title when input is empty or all-invalid. */
export const FALLBACK_TITLE = 'Untitled';

/** Character used to replace forbidden characters. */
export const REPLACEMENT_CHAR = '-';

export type FilenameIssueKind =
  | 'forbidden_chars'
  | 'leading_dots'
  | 'trailing_dots'
  | 'too_long'
  | 'empty';

export interface FilenameIssue {
  kind: FilenameIssueKind;
  message: string;
}

/**
 * Canonical title sanitization. Applies all rules:
 * 1. Replace forbidden characters with REPLACEMENT_CHAR
 * 2. Strip leading dots (hidden files on Unix)
 * 3. Strip trailing dots (stripped by Windows NTFS)
 * 4. Truncate to MAX_TITLE_LENGTH
 * 5. Trim whitespace
 * 6. Fall back to FALLBACK_TITLE if empty
 */
export function sanitizeTitle(title: string): string {
  return (
    title
      .replace(FORBIDDEN_CHARS_RE, REPLACEMENT_CHAR)
      .replace(/^\.+/, '')
      .replace(/\.+$/, '')
      .slice(0, MAX_TITLE_LENGTH)
      .trim() || FALLBACK_TITLE
  );
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

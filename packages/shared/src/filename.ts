/**
 * Single source of truth for filename/title sanitization rules.
 * Used by both client and server.
 */

const CONTROL_CHARS = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('')
  + String.fromCharCode(127);
const FORBIDDEN_PATTERN = `[<>:"/\\\\|?*${CONTROL_CHARS}]`;

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
  | 'empty';

export interface FilenameIssue {
  kind: FilenameIssueKind;
  message: string;
}

/**
 * Canonical title sanitization.
 * Only strips filesystem-breaking characters and surrounding whitespace.
 * It does not rewrite dots or silently truncate long titles.
 */
export function sanitizeTitle(title: string): string {
  let result = title.replace(FORBIDDEN_CHARS_RE, '').trim();
  if (/^\.+$/.test(result)) result = '';
  return result || FALLBACK_TITLE;
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

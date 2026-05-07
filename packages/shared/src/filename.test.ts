import { describe, it, expect } from 'vitest';
import {
  sanitizeTitle,
  validateTitle,
  isValidTitle,
  FORBIDDEN_CHARS_RE,
  MAX_TITLE_LENGTH,
  FALLBACK_TITLE,
  isWindowsReservedName,
  validateFolderName,
  isValidFolderName,
  hasCaseInsensitiveSiblingCollision,
  validateFolderPath,
  isValidFolderPath,
  pathDepth,
  MAX_FOLDER_DEPTH,
} from './filename';

describe('sanitizeTitle', () => {
  it('passes through a normal string', () => {
    expect(sanitizeTitle('hello-world')).toBe('hello-world');
  });

  it('strips forbidden characters', () => {
    expect(sanitizeTitle('a<b>c:d')).toBe('abcd');
  });

  it('strips all Windows-reserved characters', () => {
    expect(sanitizeTitle('a<b>c:d"e|f?g*h')).toBe('abcdefgh');
  });

  it('preserves leading dots', () => {
    expect(sanitizeTitle('..hidden')).toBe('..hidden');
  });

  it('preserves trailing dots', () => {
    expect(sanitizeTitle('file..')).toBe('file..');
  });

  it('preserves interior dots', () => {
    expect(sanitizeTitle('v2.0 notes')).toBe('v2.0 notes');
    expect(sanitizeTitle('Dr. Smith')).toBe('Dr. Smith');
  });

  it('returns FALLBACK_TITLE for all-dots input', () => {
    expect(sanitizeTitle('...')).toBe(FALLBACK_TITLE);
    expect(sanitizeTitle('.')).toBe(FALLBACK_TITLE);
  });

  it('does not truncate long titles', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeTitle(long).length).toBe(300);
  });

  it('returns FALLBACK_TITLE for empty input', () => {
    expect(sanitizeTitle('')).toBe(FALLBACK_TITLE);
  });

  it('returns FALLBACK_TITLE for whitespace-only input', () => {
    expect(sanitizeTitle('   ')).toBe(FALLBACK_TITLE);
  });

  it('strips control characters', () => {
    expect(sanitizeTitle('a\x00b\x1fc')).toBe('abc');
  });

  it('strips DEL character (0x7f)', () => {
    expect(sanitizeTitle('a\x7fb')).toBe('ab');
  });

  it('trims whitespace after sanitization', () => {
    expect(sanitizeTitle('  hello  ')).toBe('hello');
  });
});

describe('validateTitle', () => {
  it('returns empty array for valid title', () => {
    expect(validateTitle('my note')).toEqual([]);
  });

  it('detects forbidden characters', () => {
    const issues = validateTitle('a<b');
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('forbidden_chars');
  });

  it('detects leading dots', () => {
    const issues = validateTitle('.hidden');
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('leading_dots');
  });

  it('detects trailing dots', () => {
    const issues = validateTitle('file.');
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('trailing_dots');
  });

  it('detects too-long titles', () => {
    const issues = validateTitle('a'.repeat(MAX_TITLE_LENGTH + 1));
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('too_long');
  });

  it('detects empty titles', () => {
    const issues = validateTitle('');
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('empty');
  });

  it('detects empty titles (whitespace-only)', () => {
    const issues = validateTitle('   ');
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('empty');
  });

  it('returns multiple issues at once', () => {
    const issues = validateTitle('.<bad>.');
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain('forbidden_chars');
    expect(kinds).toContain('leading_dots');
    expect(kinds).toContain('trailing_dots');
  });

  it('allows interior dots', () => {
    expect(validateTitle('v2.0 notes')).toEqual([]);
    expect(validateTitle('Dr. Smith')).toEqual([]);
  });

  it('detects DEL character as forbidden', () => {
    const issues = validateTitle('a\x7fb');
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('forbidden_chars');
  });
});

describe('isValidTitle', () => {
  it('returns true for valid title', () => {
    expect(isValidTitle('my note')).toBe(true);
  });

  it('returns false for invalid title', () => {
    expect(isValidTitle('.hidden')).toBe(false);
    expect(isValidTitle('a<b')).toBe(false);
    expect(isValidTitle('')).toBe(false);
  });
});

describe('isWindowsReservedName', () => {
  it('matches CON, PRN, AUX, NUL case-insensitively', () => {
    for (const name of ['CON', 'con', 'Con', 'PRN', 'prn', 'AUX', 'NUL']) {
      expect(isWindowsReservedName(name)).toBe(true);
    }
  });
  it('matches COM1-COM9, LPT1-LPT9', () => {
    for (let i = 1; i <= 9; i++) {
      expect(isWindowsReservedName(`COM${i}`)).toBe(true);
      expect(isWindowsReservedName(`lpt${i}`)).toBe(true);
    }
  });
  it('matches stem before extension (CON.md)', () => {
    expect(isWindowsReservedName('CON.md')).toBe(true);
    expect(isWindowsReservedName('lpt5.txt')).toBe(true);
  });
  it('does not match COM10 or arbitrary names', () => {
    expect(isWindowsReservedName('COM10')).toBe(false);
    expect(isWindowsReservedName('hello')).toBe(false);
    expect(isWindowsReservedName('confidential')).toBe(false);
  });
});

describe('validateFolderName', () => {
  it('accepts a normal name', () => {
    expect(validateFolderName('Specs')).toEqual([]);
    expect(isValidFolderName('Specs')).toBe(true);
  });
  it('rejects Windows-reserved names', () => {
    const issues = validateFolderName('CON');
    expect(issues.some((i) => i.kind === 'reserved_name')).toBe(true);
    expect(isValidFolderName('CON')).toBe(false);
    expect(isValidFolderName('lpt9')).toBe(false);
  });
  it('rejects leading dot', () => {
    expect(validateFolderName('.hidden').some((i) => i.kind === 'leading_dots')).toBe(true);
  });
  it('rejects forbidden characters', () => {
    expect(validateFolderName('a/b').some((i) => i.kind === 'forbidden_chars')).toBe(true);
    expect(validateFolderName('a\\b').some((i) => i.kind === 'forbidden_chars')).toBe(true);
    expect(validateFolderName('a:b').some((i) => i.kind === 'forbidden_chars')).toBe(true);
  });
  it('rejects empty', () => {
    expect(validateFolderName('').some((i) => i.kind === 'empty')).toBe(true);
  });
});

describe('hasCaseInsensitiveSiblingCollision', () => {
  it('returns true when a sibling matches case-insensitively', () => {
    expect(hasCaseInsensitiveSiblingCollision('Specs', ['specs'])).toBe(true);
    expect(hasCaseInsensitiveSiblingCollision('SPECS', ['Specs'])).toBe(true);
  });
  it('returns false when no sibling matches', () => {
    expect(hasCaseInsensitiveSiblingCollision('Specs', ['Other', 'Notes'])).toBe(false);
  });
  it('returns false on empty siblings', () => {
    expect(hasCaseInsensitiveSiblingCollision('Specs', [])).toBe(false);
  });
});

describe('validateFolderPath / isValidFolderPath / pathDepth', () => {
  it('accepts shallow paths', () => {
    expect(isValidFolderPath('Specs')).toBe(true);
    expect(isValidFolderPath('Specs/Folder')).toBe(true);
    expect(isValidFolderPath('a/b/c')).toBe(true);
  });
  it('rejects depth > MAX_FOLDER_DEPTH', () => {
    const tooDeep = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => `f${i}`).join('/');
    const issues = validateFolderPath(tooDeep);
    expect(issues.some((i) => i.kind === 'depth_exceeded')).toBe(true);
  });
  it('rejects components with reserved names', () => {
    expect(isValidFolderPath('CON/foo')).toBe(false);
    expect(isValidFolderPath('a/PRN')).toBe(false);
  });
  it('rejects empty/dot/dotdot components', () => {
    expect(isValidFolderPath('a//b')).toBe(false);
    expect(isValidFolderPath('a/./b')).toBe(false);
    expect(isValidFolderPath('a/../b')).toBe(false);
  });
  it('pathDepth counts folder components above leaf', () => {
    expect(pathDepth('foo')).toBe(0);
    expect(pathDepth('a/foo')).toBe(1);
    expect(pathDepth('a/b/c/foo')).toBe(3);
  });
});

describe('FORBIDDEN_CHARS_RE', () => {
  it('matches all expected characters', () => {
    const forbidden = '<>:"/\\|?*\x00\x1f\x7f';
    for (const char of forbidden) {
      FORBIDDEN_CHARS_RE.lastIndex = 0;
      expect(FORBIDDEN_CHARS_RE.test(char)).toBe(true);
    }
  });

  it('does not match normal characters', () => {
    FORBIDDEN_CHARS_RE.lastIndex = 0;
    expect(FORBIDDEN_CHARS_RE.test('abc')).toBe(false);
  });
});

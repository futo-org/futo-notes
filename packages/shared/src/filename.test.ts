import { describe, it, expect } from 'vitest';
import {
  sanitizeTitle,
  validateTitle,
  isValidTitle,
  FORBIDDEN_CHARS_RE,
  MAX_TITLE_LENGTH,
  FALLBACK_TITLE,
  REPLACEMENT_CHAR,
} from './filename';

describe('sanitizeTitle', () => {
  it('passes through a normal string', () => {
    expect(sanitizeTitle('hello-world')).toBe('hello-world');
  });

  it('replaces forbidden characters with REPLACEMENT_CHAR', () => {
    expect(sanitizeTitle('a<b>c:d')).toBe(`a${REPLACEMENT_CHAR}b${REPLACEMENT_CHAR}c${REPLACEMENT_CHAR}d`);
  });

  it('replaces all Windows-reserved characters', () => {
    expect(sanitizeTitle('a<b>c:d"e|f?g*h')).toBe('a-b-c-d-e-f-g-h');
  });

  it('strips leading dots', () => {
    expect(sanitizeTitle('..hidden')).toBe('hidden');
  });

  it('strips trailing dots', () => {
    expect(sanitizeTitle('file..')).toBe('file');
  });

  it('preserves interior dots', () => {
    expect(sanitizeTitle('v2.0 notes')).toBe('v2.0 notes');
    expect(sanitizeTitle('Dr. Smith')).toBe('Dr. Smith');
  });

  it('handles string that is all dots', () => {
    expect(sanitizeTitle('...')).toBe(FALLBACK_TITLE);
  });

  it('truncates to MAX_TITLE_LENGTH', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeTitle(long).length).toBe(MAX_TITLE_LENGTH);
  });

  it('returns FALLBACK_TITLE for empty input', () => {
    expect(sanitizeTitle('')).toBe(FALLBACK_TITLE);
  });

  it('returns FALLBACK_TITLE for whitespace-only input', () => {
    expect(sanitizeTitle('   ')).toBe(FALLBACK_TITLE);
  });

  it('replaces control characters', () => {
    expect(sanitizeTitle('a\x00b\x1fc')).toBe('a-b-c');
  });

  it('replaces DEL character (0x7f)', () => {
    expect(sanitizeTitle('a\x7fb')).toBe('a-b');
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
    const issues = validateTitle('a'.repeat(201));
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

import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './rules';

describe('sanitizeFilename', () => {
  it('passes through a normal string', () => {
    expect(sanitizeFilename('hello-world')).toBe('hello-world');
  });

  it('strips illegal characters', () => {
    expect(sanitizeFilename('a<b>c:d')).toBe('abcd');
  });

  it('strips leading dots (a leading dot makes a hidden dotfile the scan skips)', () => {
    expect(sanitizeFilename('..hidden')).toBe('hidden');
  });

  it('strips trailing dots (Windows silently drops them)', () => {
    expect(sanitizeFilename('file..')).toBe('file');
  });

  it('does not truncate long names', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeFilename(long).length).toBe(300);
  });

  it('returns Untitled for empty input', () => {
    expect(sanitizeFilename('')).toBe('Untitled');
  });

  it('returns Untitled for whitespace-only input', () => {
    expect(sanitizeFilename('   ')).toBe('Untitled');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('a\x00b\x1fc')).toBe('abc');
  });

  it('strips DEL character (0x7f)', () => {
    expect(sanitizeFilename('a\x7fb')).toBe('ab');
  });
});

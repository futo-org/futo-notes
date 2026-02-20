import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './utils';

describe('sanitizeFilename', () => {
  it('passes through a normal string', () => {
    expect(sanitizeFilename('hello-world')).toBe('hello-world');
  });

  it('replaces illegal characters with dashes', () => {
    expect(sanitizeFilename('a<b>c:d')).toBe('a-b-c-d');
  });

  it('strips leading dots', () => {
    expect(sanitizeFilename('..hidden')).toBe('hidden');
  });

  it('strips trailing dots', () => {
    expect(sanitizeFilename('file..')).toBe('file');
  });

  it('truncates to 200 characters', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeFilename(long).length).toBe(200);
  });

  it('returns Untitled for empty input', () => {
    expect(sanitizeFilename('')).toBe('Untitled');
  });

  it('returns Untitled for whitespace-only input', () => {
    expect(sanitizeFilename('   ')).toBe('Untitled');
  });

  it('replaces control characters', () => {
    expect(sanitizeFilename('a\x00b\x1fc')).toBe('a-b-c');
  });

  it('replaces DEL character (0x7f)', () => {
    expect(sanitizeFilename('a\x7fb')).toBe('a-b');
  });
});

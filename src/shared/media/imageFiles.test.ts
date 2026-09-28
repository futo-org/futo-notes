import { describe, expect, it } from 'vitest';
import { validateImageExtension } from './imageFiles';

describe('validateImageExtension', () => {
  it('accepts valid extensions without dot', () => {
    expect(validateImageExtension('png')).toBe('png');
    expect(validateImageExtension('jpg')).toBe('jpg');
    expect(validateImageExtension('jpeg')).toBe('jpeg');
  });

  it('accepts valid extensions with leading dot', () => {
    expect(validateImageExtension('.png')).toBe('png');
    expect(validateImageExtension('.jpg')).toBe('jpg');
  });

  it('normalizes to lowercase', () => {
    expect(validateImageExtension('JPG')).toBe('jpg');
    expect(validateImageExtension('Png')).toBe('png');
  });

  it('rejects non-image extensions', () => {
    expect(() => validateImageExtension('exe')).toThrow('disallowed image extension');
    expect(() => validateImageExtension('md')).toThrow('disallowed image extension');
    expect(() => validateImageExtension('html')).toThrow('disallowed image extension');
    expect(() => validateImageExtension('js')).toThrow('disallowed image extension');
  });

  it('rejects traversal attempts', () => {
    expect(() => validateImageExtension('../../../etc/evil')).toThrow();
    expect(() => validateImageExtension('..')).toThrow();
    expect(() => validateImageExtension('jpg/../../etc/passwd')).toThrow();
    expect(() => validateImageExtension('jpg\\..\\..\\evil')).toThrow();
  });

  it('rejects overlong extensions', () => {
    expect(() => validateImageExtension('abcdefghijk')).toThrow();
  });
});

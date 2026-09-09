import { describe, expect, it } from 'vitest';
import { createImageFilename, validateImageExtension } from './imageFiles';

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

describe('createImageFilename', () => {
  it('returns a valid filename', () => {
    const name = createImageFilename('png');
    expect(name).toMatch(/^image-\d+-[0-9a-f]{12}\.png$/);
  });

  it('handles extension with dot prefix', () => {
    const name = createImageFilename('.jpg');
    expect(name).toMatch(/\.jpg$/);
  });

  it('generates unique filenames in a batch', () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(createImageFilename('png'));
    }
    expect(names.size).toBe(20);
  });

  it('rejects invalid extensions', () => {
    expect(() => createImageFilename('exe')).toThrow();
  });
});

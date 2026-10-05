import { describe, expect, it } from 'vitest';
import { validateImageExtension } from './imageFiles';

describe('validateImageExtension', () => {
  it('accepts image extensions with or without a leading dot, normalized to lowercase', () => {
    for (const [input, expected] of [
      ['png', 'png'],
      ['jpg', 'jpg'],
      ['jpeg', 'jpeg'],
      ['.png', 'png'],
      ['.jpg', 'jpg'],
      ['JPG', 'jpg'],
      ['Png', 'png'],
    ]) {
      expect(validateImageExtension(input)).toBe(expected);
    }
  });

  it('rejects non-image extensions', () => {
    for (const extension of ['exe', 'md', 'html', 'js']) {
      expect(() => validateImageExtension(extension)).toThrow('disallowed image extension');
    }
  });

  it('rejects traversal attempts and overlong extensions', () => {
    for (const extension of [
      '../../../etc/evil',
      '..',
      'jpg/../../etc/passwd',
      'jpg\\..\\..\\evil',
      'abcdefghijk',
    ]) {
      expect(() => validateImageExtension(extension)).toThrow();
    }
  });
});

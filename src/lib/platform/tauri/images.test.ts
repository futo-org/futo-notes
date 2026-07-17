import { describe, expect, it } from 'vitest';
import { imageMimeForExtension } from './images';
import { IMAGE_EXTENSIONS } from '@futo-notes/editor';

describe('imageMimeForExtension', () => {
  const cases: Array<[string, string]> = [
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['svg', 'image/svg+xml'],
    ['bmp', 'image/bmp'],
    ['ico', 'image/x-icon'],
    ['avif', 'image/avif'],
    ['heic', 'image/heic'],
  ];

  it.each(cases)('maps %s → %s', (ext, mime) => {
    expect(imageMimeForExtension(ext)).toBe(mime);
  });

  it('serves SVG as image/svg+xml, not image/png (the rendering bug)', () => {
    expect(imageMimeForExtension('svg')).toBe('image/svg+xml');
  });

  it('is case-insensitive on the extension', () => {
    expect(imageMimeForExtension('PNG')).toBe('image/png');
    expect(imageMimeForExtension('SVG')).toBe('image/svg+xml');
  });

  it('defaults unknown extensions to image/png', () => {
    expect(imageMimeForExtension('tiff')).toBe('image/png');
    expect(imageMimeForExtension('')).toBe('image/png');
  });

  it('covers every accepted IMAGE_EXTENSIONS entry with a non-default MIME', () => {
    for (const ext of IMAGE_EXTENSIONS) {
      const mime = imageMimeForExtension(ext);
      expect(mime.startsWith('image/')).toBe(true);
      if (ext !== 'png') {
        expect(mime).not.toBe('image/png');
      }
    }
  });
});

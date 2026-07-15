import { describe, expect, it } from 'vitest';

import { IMAGE_EXTENSIONS, isImageFilename } from './images';

describe('isImageFilename', () => {
  it('accepts every supported image extension', () => {
    for (const extension of IMAGE_EXTENSIONS) {
      expect(isImageFilename(`photo.${extension}`)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isImageFilename('photo.JPG')).toBe(true);
    expect(isImageFilename('photo.Png')).toBe(true);
    expect(isImageFilename('photo.WEBP')).toBe(true);
  });

  it('rejects non-images and filenames without extensions', () => {
    expect(isImageFilename('note.md')).toBe(false);
    expect(isImageFilename('archive.zip')).toBe(false);
    expect(isImageFilename('noextension')).toBe(false);
    expect(isImageFilename('.hidden')).toBe(false);
  });

  it('accepts machine-generated image filenames', () => {
    expect(isImageFilename('1234567890-abc.jpg')).toBe(true);
    expect(isImageFilename('1742345678901-xk7.png')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { IMAGE_EXTENSIONS, imageReferenceMarkdown, isImageFilename } from './images';

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

describe('imageReferenceMarkdown', () => {
  it('writes a linkless image reference with a trailing newline', () => {
    expect(imageReferenceMarkdown('image-1712.png')).toBe('![](image-1712.png)\n');
  });

  it('leaves a filename with spaces exactly as the vault stores it', () => {
    expect(imageReferenceMarkdown('my photo.png')).toBe('![](my photo.png)\n');
  });
});

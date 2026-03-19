import { describe, it, expect } from 'vitest';
import { isImageFilename, IMAGE_EXTENSIONS } from './sync';

describe('isImageFilename', () => {
  it('returns true for valid image filenames', () => {
    expect(isImageFilename('photo.jpg')).toBe(true);
    expect(isImageFilename('photo.jpeg')).toBe(true);
    expect(isImageFilename('image.png')).toBe(true);
    expect(isImageFilename('animation.gif')).toBe(true);
    expect(isImageFilename('modern.webp')).toBe(true);
    expect(isImageFilename('vector.svg')).toBe(true);
    expect(isImageFilename('bitmap.bmp')).toBe(true);
    expect(isImageFilename('icon.ico')).toBe(true);
    expect(isImageFilename('next-gen.avif')).toBe(true);
    expect(isImageFilename('apple.heic')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isImageFilename('photo.JPG')).toBe(true);
    expect(isImageFilename('photo.Png')).toBe(true);
    expect(isImageFilename('photo.WEBP')).toBe(true);
  });

  it('returns false for non-image filenames', () => {
    expect(isImageFilename('note.md')).toBe(false);
    expect(isImageFilename('file.txt')).toBe(false);
    expect(isImageFilename('script.js')).toBe(false);
    expect(isImageFilename('style.css')).toBe(false);
    expect(isImageFilename('archive.zip')).toBe(false);
  });

  it('returns false for filenames without extensions', () => {
    expect(isImageFilename('noextension')).toBe(false);
    expect(isImageFilename('.hidden')).toBe(false);
  });

  it('handles machine-generated image filenames', () => {
    expect(isImageFilename('1234567890-abc.jpg')).toBe(true);
    expect(isImageFilename('1742345678901-xk7.png')).toBe(true);
  });
});

describe('IMAGE_EXTENSIONS', () => {
  it('contains expected extensions', () => {
    expect(IMAGE_EXTENSIONS).toContain('jpg');
    expect(IMAGE_EXTENSIONS).toContain('jpeg');
    expect(IMAGE_EXTENSIONS).toContain('png');
    expect(IMAGE_EXTENSIONS).toContain('gif');
    expect(IMAGE_EXTENSIONS).toContain('webp');
    expect(IMAGE_EXTENSIONS).toContain('svg');
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { validateImageExt, generateImageFilename, listImageFiles, deleteImage } from './images';

vi.mock('$lib/platform');

import { testFS } from '$lib/platform';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

beforeEach(() => {
  testFS._reset();
});

afterAll(() => {
  testFS._cleanup();
});

// ── validateImageExt ─────────────────────────────────────

describe('validateImageExt', () => {
  it('accepts valid extensions without dot', () => {
    expect(validateImageExt('png')).toBe('png');
    expect(validateImageExt('jpg')).toBe('jpg');
    expect(validateImageExt('jpeg')).toBe('jpeg');
  });

  it('accepts valid extensions with leading dot', () => {
    expect(validateImageExt('.png')).toBe('png');
    expect(validateImageExt('.jpg')).toBe('jpg');
  });

  it('normalizes to lowercase', () => {
    expect(validateImageExt('JPG')).toBe('jpg');
    expect(validateImageExt('Png')).toBe('png');
  });

  it('rejects non-image extensions', () => {
    expect(() => validateImageExt('exe')).toThrow('disallowed image extension');
    expect(() => validateImageExt('md')).toThrow('disallowed image extension');
    expect(() => validateImageExt('html')).toThrow('disallowed image extension');
    expect(() => validateImageExt('js')).toThrow('disallowed image extension');
  });

  it('rejects traversal attempts', () => {
    expect(() => validateImageExt('../../../etc/evil')).toThrow();
    expect(() => validateImageExt('..')).toThrow();
    expect(() => validateImageExt('jpg/../../etc/passwd')).toThrow();
    expect(() => validateImageExt('jpg\\..\\..\\evil')).toThrow();
  });

  it('rejects overlong extensions', () => {
    expect(() => validateImageExt('abcdefghijk')).toThrow();
  });
});

// ── generateImageFilename ────────────────────────────────

describe('generateImageFilename', () => {
  it('returns a valid filename', () => {
    const name = generateImageFilename('png');
    expect(name).toMatch(/^image-\d+-[0-9a-f]{12}\.png$/);
  });

  it('handles extension with dot prefix', () => {
    const name = generateImageFilename('.jpg');
    expect(name).toMatch(/\.jpg$/);
  });

  it('generates unique filenames in a batch', () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateImageFilename('png'));
    }
    expect(names.size).toBe(20);
  });

  it('rejects invalid extensions', () => {
    expect(() => generateImageFilename('exe')).toThrow();
  });
});

// ── listImageFiles ───────────────────────────────────────

describe('listImageFiles', () => {
  it('returns empty for empty directory', async () => {
    const images = await listImageFiles();
    expect(images).toEqual([]);
  });

  it('returns only image files', async () => {
    // Write a note (creates .md file)
    await testFS.writeNote('some-note', '# A note');

    // Write an image via saveImage
    const tmpImage = path.join(os.tmpdir(), 'test-photo.png');
    fs.writeFileSync(tmpImage, 'fake-png-data');
    await testFS.saveImage(tmpImage);
    fs.unlinkSync(tmpImage);

    const images = await listImageFiles();
    expect(images).toHaveLength(1);
    expect(images[0].filename).toBe('test-photo.png');
    expect(images[0].size).toBeGreaterThan(0);
  });

  it('sorts by mtime descending', async () => {
    // Create two image files with different mtimes
    const tmp1 = path.join(os.tmpdir(), 'older.png');
    const tmp2 = path.join(os.tmpdir(), 'newer.jpg');
    fs.writeFileSync(tmp1, 'data-1');
    fs.writeFileSync(tmp2, 'data-2');

    await testFS.saveImage(tmp1);
    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    await testFS.saveImage(tmp2);

    fs.unlinkSync(tmp1);
    fs.unlinkSync(tmp2);

    const images = await listImageFiles();
    expect(images).toHaveLength(2);
    expect(images[0].filename).toBe('newer.jpg');
    expect(images[1].filename).toBe('older.png');
  });
});

// ── deleteImage ──────────────────────────────────────────

describe('deleteImage', () => {
  it('deletes an existing image', async () => {
    const tmp = path.join(os.tmpdir(), 'to-delete.png');
    fs.writeFileSync(tmp, 'image-data');
    await testFS.saveImage(tmp);
    fs.unlinkSync(tmp);

    // Verify it exists
    let images = await listImageFiles();
    expect(images.some((i) => i.filename === 'to-delete.png')).toBe(true);

    // Delete it
    await deleteImage('to-delete.png');

    // Verify it's gone
    images = await listImageFiles();
    expect(images.some((i) => i.filename === 'to-delete.png')).toBe(false);
  });

  it('rejects non-image extensions', async () => {
    await expect(deleteImage('note.md')).rejects.toThrow('not an image filename');
    await expect(deleteImage('file.txt')).rejects.toThrow('not an image filename');
  });

  it('rejects traversal attempts', async () => {
    await expect(deleteImage('../etc/passwd.png')).rejects.toThrow('invalid filename');
    await expect(deleteImage('sub/image.jpg')).rejects.toThrow('invalid filename');
    await expect(deleteImage('..\\evil.png')).rejects.toThrow('invalid filename');
  });
});

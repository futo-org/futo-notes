import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { deleteImage, listImageFiles } from './imageFiles';

vi.mock('$lib/platform');

import { testFS } from '$lib/platform';
import fs from 'node:fs';
import path from 'node:path';

beforeEach(() => {
  testFS._reset();
});

afterAll(() => {
  testFS._cleanup();
});

describe('listImageFiles', () => {
  it('returns empty for empty directory', async () => {
    const images = await listImageFiles();
    expect(images).toEqual([]);
  });

  it('returns only image files', async () => {
    await testFS.writeNote('some-note', '# A note');

    fs.writeFileSync(path.join(testFS.root, 'test-photo.png'), 'fake-png-data');

    const images = await listImageFiles();
    expect(images).toHaveLength(1);
    expect(images[0].filename).toBe('test-photo.png');
    expect(images[0].size).toBeGreaterThan(0);
  });

  it('sorts by mtime descending', async () => {
    const older = path.join(testFS.root, 'older.png');
    const newer = path.join(testFS.root, 'newer.jpg');
    fs.writeFileSync(older, 'data-1');
    fs.writeFileSync(newer, 'data-2');
    fs.utimesSync(older, 1000, 1000);
    fs.utimesSync(newer, 2000, 2000);

    const images = await listImageFiles();
    expect(images).toHaveLength(2);
    expect(images[0].filename).toBe('newer.jpg');
    expect(images[1].filename).toBe('older.png');
  });
});

describe('deleteImage', () => {
  it('deletes an existing image', async () => {
    fs.writeFileSync(path.join(testFS.root, 'to-delete.png'), 'image-data');

    let images = await listImageFiles();
    expect(images.some((i) => i.filename === 'to-delete.png')).toBe(true);

    await deleteImage('to-delete.png');

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

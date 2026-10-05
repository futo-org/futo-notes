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
  it('lists only image files, newest first', async () => {
    await testFS.writeNote('some-note', '# A note');
    const older = path.join(testFS.root, 'older.png');
    const newer = path.join(testFS.root, 'newer.jpg');
    fs.writeFileSync(older, 'data-1');
    fs.writeFileSync(newer, 'data-22');
    fs.utimesSync(older, 1000, 1000);
    fs.utimesSync(newer, 2000, 2000);

    expect(await listImageFiles()).toEqual([
      { filename: 'newer.jpg', size: 7, mtime: 2_000_000 },
      { filename: 'older.png', size: 6, mtime: 1_000_000 },
    ]);
  });
});

describe('deleteImage', () => {
  it('deletes an image that lives in a folder', async () => {
    fs.mkdirSync(path.join(testFS.root, 'trip'));
    fs.writeFileSync(path.join(testFS.root, 'trip', 'beach.png'), 'image-data');

    await deleteImage('trip/beach.png');

    expect(await listImageFiles()).toEqual([]);
  });

  it('rejects non-image extensions', async () => {
    await expect(deleteImage('note.md')).rejects.toThrow('not an image filename');
    await expect(deleteImage('file.txt')).rejects.toThrow('not an image filename');
  });
});

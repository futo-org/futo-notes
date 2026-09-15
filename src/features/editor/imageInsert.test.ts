// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFS } = vi.hoisted(() => ({ getFS: vi.fn() }));
vi.mock('$lib/platform', () => ({ getFS, isTauri: false }));

import { clearVaultImageUrlCache, resolveVaultImageSrc } from '$features/images/vaultImageSrc';

import {
  createImageInserter,
  dropCarriesFiles,
  filePathFromUri,
  filePathsFromDrop,
  imageExtensionFor,
  imageFilesIn,
  imagePathsIn,
  parseUriList,
  resolveImageInserter,
} from './imageInsert';

function pngFile(name = 'photo.png', type = 'image/png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
}

/**
 * A stand-in for the `DataTransfer` on a drop event. jsdom does not implement
 * the real one, and these functions only ever read `.files` — a real browser
 * `DataTransfer` is exercised by the Playwright drop spec instead.
 */
function transferWith(...files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer;
}

/**
 * A stand-in for a `DataTransfer` carrying text data — `getData`/`types`,
 * the shape WebKitGTK's file drop (and the editor's own block drag) uses.
 * `files` defaults to empty, matching WebKitGTK, which never populates it.
 */
function transferWithData(
  data: Partial<Record<'text/uri-list' | 'text/plain' | 'text/html', string>>,
) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined) as [
    string,
    string,
  ][];
  return {
    files: [],
    types: entries.map(([type]) => type),
    getData: (type: string) => entries.find(([t]) => t === type)?.[1] ?? '',
  } as unknown as DataTransfer;
}

/** A vault FS that records what it was asked to write. */
function fakeFs(overrides: Partial<Record<string, unknown>> = {}) {
  let counter = 0;
  return {
    saveImage: vi.fn(async (source: string) => `image-from-${source.split('/').pop()}`),
    saveImageBytes: vi.fn(async (_data: ArrayBuffer, ext: string) => `image-${++counter}.${ext}`),
    getImageUrl: vi.fn(async (filename: string) => `asset://${filename}`),
    ...overrides,
  };
}

beforeEach(() => {
  clearVaultImageUrlCache();
  getFS.mockReset();
});

describe('imageFilesIn', () => {
  it('keeps files the browser typed as an image', () => {
    expect(imageFilesIn(transferWith(pngFile())).map((f) => f.name)).toEqual(['photo.png']);
  });

  it('keeps a file the browser gave no MIME type, on its extension alone', () => {
    const named = new File([new Uint8Array([1])], 'shot.PNG', { type: '' });
    expect(imageFilesIn(transferWith(named)).map((f) => f.name)).toEqual(['shot.PNG']);
  });

  it('drops a markdown file — dropping a note is not inserting a picture', () => {
    const note = new File([new Uint8Array([1])], 'notes.md', { type: 'text/markdown' });
    expect(imageFilesIn(transferWith(note))).toEqual([]);
  });

  it('keeps only the images out of a mixed drop', () => {
    const note = new File([new Uint8Array([1])], 'notes.md', { type: 'text/markdown' });
    expect(imageFilesIn(transferWith(note, pngFile())).map((f) => f.name)).toEqual(['photo.png']);
  });

  it('is empty for no transfer at all', () => {
    expect(imageFilesIn(null)).toEqual([]);
  });
});

describe('imagePathsIn', () => {
  it('keeps image paths and drops everything else', () => {
    expect(imagePathsIn(['/a/one.png', '/a/notes.md', '/a/two.JPEG', '/a/archive.zip'])).toEqual([
      '/a/one.png',
      '/a/two.JPEG',
    ]);
  });

  it('reads the extension off the file name, not off a directory that has a dot', () => {
    expect(imagePathsIn(['/home/me/photos.png/readme'])).toEqual([]);
  });

  it('handles Windows separators', () => {
    expect(imagePathsIn(['C:\\Users\\me\\Pictures\\shot.png'])).toEqual([
      'C:\\Users\\me\\Pictures\\shot.png',
    ]);
  });
});

describe('imageExtensionFor', () => {
  it('prefers the file name over the MIME type', () => {
    expect(imageExtensionFor(pngFile('shot.webp', 'image/png'))).toBe('webp');
  });

  it('falls back to the MIME type when the name carries no image extension', () => {
    expect(imageExtensionFor(new File([], 'clipboard', { type: 'image/jpeg' }))).toBe('jpg');
  });
});

describe('dropCarriesFiles', () => {
  it('is true for a drop carrying any file', () => {
    expect(dropCarriesFiles(transferWith(pngFile()))).toBe(true);
  });

  it('is false for a drop carrying only text (an internal block drag)', () => {
    expect(dropCarriesFiles(transferWith())).toBe(false);
  });

  it('is false for no transfer', () => {
    expect(dropCarriesFiles(null)).toBe(false);
  });
});

describe('parseUriList', () => {
  it('splits a CRLF-joined list, the RFC 2483 line ending', () => {
    expect(parseUriList('file:///a/one.png\r\nfile:///a/two.png\r\n')).toEqual([
      'file:///a/one.png',
      'file:///a/two.png',
    ]);
  });

  it('accepts a bare-LF list too, since not every sender uses CRLF', () => {
    expect(parseUriList('file:///a/one.png\nfile:///a/two.png')).toEqual([
      'file:///a/one.png',
      'file:///a/two.png',
    ]);
  });

  it('drops comment lines and blank lines', () => {
    expect(parseUriList('# a comment\n\nfile:///a/one.png\n# another\n')).toEqual([
      'file:///a/one.png',
    ]);
  });
});

describe('filePathFromUri', () => {
  it('decodes a plain file:// URI to a path', () => {
    expect(filePathFromUri('file:///home/justin/Downloads/photo.png')).toBe(
      '/home/justin/Downloads/photo.png',
    );
  });

  it('percent-decodes the path, so a space in the file name survives', () => {
    expect(filePathFromUri('file:///home/justin/Downloads/my%20photo.png')).toBe(
      '/home/justin/Downloads/my photo.png',
    );
  });

  it('accepts an explicit localhost authority', () => {
    expect(filePathFromUri('file://localhost/home/justin/photo.png')).toBe(
      '/home/justin/photo.png',
    );
  });

  it('rejects a non-file scheme', () => {
    expect(filePathFromUri('http://example.com/photo.png')).toBeNull();
  });

  it('rejects a file:// URI naming a different host', () => {
    expect(filePathFromUri('file://otherhost/home/justin/photo.png')).toBeNull();
  });

  it('rejects unparsable text rather than throwing', () => {
    expect(filePathFromUri('not a uri at all')).toBeNull();
  });
});

describe('filePathsFromDrop', () => {
  it('reads file:// paths out of text/uri-list', () => {
    expect(
      filePathsFromDrop(
        transferWithData({ 'text/uri-list': 'file:///home/justin/Downloads/photo.webp' }),
      ),
    ).toEqual(['/home/justin/Downloads/photo.webp']);
  });

  it('reads multiple paths, skipping comment lines, CRLF-joined', () => {
    expect(
      filePathsFromDrop(
        transferWithData({
          'text/uri-list': '# a comment\r\nfile:///a/one.png\r\nfile:///a/two.jpg\r\n',
        }),
      ),
    ).toEqual(['/a/one.png', '/a/two.jpg']);
  });

  it('percent-decodes a file name with a space in it', () => {
    expect(
      filePathsFromDrop(transferWithData({ 'text/uri-list': 'file:///a/my%20photo.png' })),
    ).toEqual(['/a/my photo.png']);
  });

  it('drops a non-file URI mixed into the list', () => {
    expect(
      filePathsFromDrop(
        transferWithData({
          'text/uri-list': 'http://example.com/photo.png\nfile:///a/one.png',
        }),
      ),
    ).toEqual(['/a/one.png']);
  });

  it('falls back to text/plain when there is no text/uri-list at all', () => {
    expect(filePathsFromDrop(transferWithData({ 'text/plain': 'file:///a/one.png' }))).toEqual([
      '/a/one.png',
    ]);
  });

  it('never treats arbitrary dropped text as a path', () => {
    expect(filePathsFromDrop(transferWithData({ 'text/plain': 'just some words' }))).toEqual([]);
  });

  it("does not claim the editor's own block drag — text/html + text/plain, no file:// URI", () => {
    // @milkdown/plugin-block's own drag always sets both together; the block's
    // visible text could itself read like a path, so the presence of
    // text/html (never sent by an external file drop) is what rules it out.
    expect(
      filePathsFromDrop(transferWithData({ 'text/html': '<p>hey</p>', 'text/plain': 'hey' })),
    ).toEqual([]);
  });

  it('does not claim a block drag even if its text happens to look like a file:// URL', () => {
    expect(
      filePathsFromDrop(
        transferWithData({
          'text/html': '<p>file:///home/justin/notes.png</p>',
          'text/plain': 'file:///home/justin/notes.png',
        }),
      ),
    ).toEqual([]);
  });

  it('is empty for no transfer at all', () => {
    expect(filePathsFromDrop(null)).toEqual([]);
  });

  it('is empty for a transfer with neither files nor path text', () => {
    expect(filePathsFromDrop(transferWithData({}))).toEqual([]);
  });
});

describe('createImageInserter — the picker', () => {
  it('saves the picked file into the vault and inserts its reference', async () => {
    const fs = fakeFs();
    const insert = vi.fn();
    const inserter = createImageInserter({
      fs: { ...fs, pickImage: vi.fn(async () => '/home/me/holiday.png') },
      insert,
    });

    expect(inserter.canPick).toBe(true);
    await inserter.pick();

    expect(fs.saveImage).toHaveBeenCalledWith('/home/me/holiday.png');
    expect(insert).toHaveBeenCalledWith('image-from-holiday.png');
  });

  it('registers the URL so the just-inserted image renders without a reload', async () => {
    const fs = fakeFs();
    const inserter = createImageInserter({
      fs: { ...fs, pickImage: vi.fn(async () => '/home/me/holiday.png') },
      insert: vi.fn(),
    });

    await inserter.pick();

    expect(resolveVaultImageSrc('image-from-holiday.png')).toBe('asset://image-from-holiday.png');
  });

  it('inserts nothing when the picker is dismissed', async () => {
    const insert = vi.fn();
    const inserter = createImageInserter({
      fs: { ...fakeFs(), pickImage: vi.fn(async () => null) },
      insert,
    });

    await inserter.pick();

    expect(insert).not.toHaveBeenCalled();
  });

  it('cannot pick on a host with no picker, and picking is a no-op', async () => {
    const fs = fakeFs();
    const insert = vi.fn();
    const inserter = createImageInserter({ fs, insert });

    expect(inserter.canPick).toBe(false);
    await inserter.pick();

    expect(fs.saveImage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('cannot pick on a host with no vault FS at all, and picking is a no-op', async () => {
    const insert = vi.fn();
    const inserter = createImageInserter({ fs: null, insert });

    expect(inserter.canPick).toBe(false);
    await inserter.pick();

    expect(insert).not.toHaveBeenCalled();
  });

  it('reports a picker failure instead of throwing at the caller', async () => {
    const reportError = vi.fn();
    const inserter = createImageInserter({
      fs: {
        ...fakeFs(),
        pickImage: vi.fn(() => Promise.reject(new Error('picker exploded'))),
      },
      insert: vi.fn(),
      reportError,
    });

    await inserter.pick();

    expect(reportError).toHaveBeenCalledWith('Image insert failed:', expect.any(Error));
  });
});

describe('createImageInserter — dropped files', () => {
  it('writes the bytes into the vault and inserts each image', async () => {
    const fs = fakeFs();
    const insert = vi.fn();
    const inserter = createImageInserter({ fs, insert });

    await inserter.insertFiles([pngFile('a.png'), pngFile('b.jpg', 'image/jpeg')]);

    expect(fs.saveImageBytes).toHaveBeenNthCalledWith(1, expect.any(ArrayBuffer), 'png');
    expect(fs.saveImageBytes).toHaveBeenNthCalledWith(2, expect.any(ArrayBuffer), 'jpg');
    expect(insert.mock.calls.map((c) => c[0])).toEqual(['image-1.png', 'image-2.jpg']);
  });

  it('inserts the images in the order they were dropped', async () => {
    const insert = vi.fn();
    const inserter = createImageInserter({ fs: fakeFs(), insert });

    await inserter.insertFiles([pngFile('a.png'), pngFile('b.png'), pngFile('c.png')]);

    expect(insert.mock.calls.map((c) => c[0])).toEqual([
      'image-1.png',
      'image-2.png',
      'image-3.png',
    ]);
  });

  it('inserts nothing for an empty list', async () => {
    const fs = fakeFs();
    await createImageInserter({ fs, insert: vi.fn() }).insertFiles([]);
    expect(fs.saveImageBytes).not.toHaveBeenCalled();
  });

  it('still inserts the reference when the URL cannot be resolved yet', async () => {
    // The file IS in the vault — only its display URL failed. Refusing to
    // insert would throw the user's image away over a render detail, and the
    // node view re-resolves itself on a later render anyway.
    const insert = vi.fn();
    const inserter = createImageInserter({
      fs: fakeFs({ getImageUrl: vi.fn(() => Promise.reject(new Error('no asset protocol'))) }),
      insert,
      reportError: vi.fn(),
    });

    await inserter.insertFiles([pngFile()]);

    expect(insert).toHaveBeenCalledWith('image-1.png');
  });

  it('keeps going after one file fails to save', async () => {
    const insert = vi.fn();
    const reportError = vi.fn();
    const saveImageBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce('image-ok.png');
    const inserter = createImageInserter({
      fs: fakeFs({ saveImageBytes }),
      insert,
      reportError,
    });

    await inserter.insertFiles([pngFile('a.png'), pngFile('b.png')]);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls.map((c) => c[0])).toEqual(['image-ok.png']);
  });

  it('does nothing on a host with no vault FS', async () => {
    const insert = vi.fn();
    await createImageInserter({ fs: null, insert }).insertFiles([pngFile()]);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('createImageInserter — dropped paths (the Tauri drag-drop event)', () => {
  it('copies each image path into the vault and inserts it', async () => {
    const fs = fakeFs();
    const insert = vi.fn();

    await createImageInserter({ fs, insert }).insertPaths(['/pics/one.png', '/pics/two.jpg']);

    expect(fs.saveImage).toHaveBeenNthCalledWith(1, '/pics/one.png');
    expect(fs.saveImage).toHaveBeenNthCalledWith(2, '/pics/two.jpg');
    expect(insert.mock.calls.map((c) => c[0])).toEqual([
      'image-from-one.png',
      'image-from-two.jpg',
    ]);
  });

  it('ignores a dropped markdown file rather than inserting it as an image', async () => {
    const fs = fakeFs();
    const insert = vi.fn();

    await createImageInserter({ fs, insert }).insertPaths(['/notes/todo.md']);

    expect(fs.saveImage).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('resolveImageInserter', () => {
  it('is pickerless on a host that cannot write image bytes (a plain browser)', () => {
    getFS.mockReturnValue({ saveImage: vi.fn(), getImageUrl: vi.fn() });
    expect(resolveImageInserter(vi.fn()).canPick).toBe(false);
  });

  it('picks through the platform FS on a host that can write image bytes', async () => {
    const pickImage = vi.fn(async () => '/home/me/x.png');
    getFS.mockReturnValue({
      saveImage: vi.fn(async () => 'image-9.png'),
      saveImageBytes: vi.fn(),
      getImageUrl: vi.fn(async () => 'asset://image-9.png'),
      pickImage,
    });
    const insert = vi.fn();

    const inserter = resolveImageInserter(insert);
    expect(inserter.canPick).toBe(true);
    await inserter.pick();

    expect(pickImage).toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith('image-9.png');
  });

  it('survives an environment with no platform FS at all', () => {
    getFS.mockImplementation(() => {
      throw new Error('Platform FS not initialized');
    });
    expect(resolveImageInserter(vi.fn()).canPick).toBe(false);
  });
});

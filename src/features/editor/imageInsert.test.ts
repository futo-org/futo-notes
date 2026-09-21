// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFS } = vi.hoisted(() => ({ getFS: vi.fn() }));
vi.mock('$lib/platform', () => ({ getFS, isTauri: false }));

import { clearVaultImageUrlCache, resolveVaultImageSrc } from '$features/images/vaultImageSrc';

import { createImageInsertTarget, type ImageInsertTarget } from './imageInsertTarget';
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
 * An insert target over ONE note that never changes — the ordinary case, where
 * the user stays put. The cases that swap the note mid-save build their own.
 */
function into(insert: (filename: string) => void): ImageInsertTarget {
  return createImageInsertTarget({ documentToken: () => 'the note', insert });
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
    saveImagePath: vi.fn(async (source: string) => `image-from-${source.split('/').pop()}`),
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
  /**
   * The exact shape captured off a real WebKitGTK drop (packaged Fedora/
   * Hyprland build, 2026-09-15): `text/uri-list` is ADVERTISED in `.types`
   * but `getData` on it returns an empty string regardless, and the dropped
   * path lives only in `text/html`, as an `<a>` with NO `href` — its text
   * content IS the `file://` URI.
   */
  it('reads the real WebKitGTK shape: text/uri-list advertised-but-empty, path in an href-less <a>', () => {
    expect(
      filePathsFromDrop(
        transferWithData({
          'text/uri-list': '',
          'text/html':
            '<html><body style="overflow-wrap: break-word;">' +
            '<a style="color:#0968da;text-decoration-style: solid;">' +
            'file:///home/justin/Downloads/Screen_Shot_2020-07-24_at_11.33.38_AM-1.webp</a>' +
            '</body></html>',
        }),
      ),
    ).toEqual(['/home/justin/Downloads/Screen_Shot_2020-07-24_at_11.33.38_AM-1.webp']);
  });

  it('reads a real text/uri-list BODY first, for an engine that actually populates it', () => {
    expect(
      filePathsFromDrop(
        transferWithData({
          'text/uri-list': 'file:///home/justin/Downloads/photo.webp',
          'text/html': '<a href="file:///home/justin/Downloads/photo.webp">photo.webp</a>',
        }),
      ),
    ).toEqual(['/home/justin/Downloads/photo.webp']);
  });

  it('reads an href when the <a> has one (other engines), not just the text', () => {
    expect(
      filePathsFromDrop(
        transferWithData({
          'text/uri-list': '',
          'text/html': '<a href="file:///home/me/photo.png">a photo</a>',
        }),
      ),
    ).toEqual(['/home/me/photo.png']);
  });

  it('reads every <a> for a multi-file drop, in order', () => {
    expect(
      filePathsFromDrop(
        transferWithData({
          'text/uri-list': '',
          'text/html': '<a href="file:///a/one.png">one.png</a><a>file:///a/two.jpg</a>',
        }),
      ),
    ).toEqual(['/a/one.png', '/a/two.jpg']);
  });

  it('percent-decodes a file name with a space in it', () => {
    expect(
      filePathsFromDrop(
        transferWithData({ 'text/uri-list': '', 'text/html': '<a>file:///a/my%20photo.png</a>' }),
      ),
    ).toEqual(['/a/my photo.png']);
  });

  it('claims nothing when the <a> text is not a file:// URI', () => {
    expect(
      filePathsFromDrop(
        transferWithData({ 'text/uri-list': '', 'text/html': '<a>not a file url</a>' }),
      ),
    ).toEqual([]);
  });

  it("does not claim the editor's own block drag — it never advertises text/uri-list", () => {
    // @milkdown/plugin-block's own drag sets text/html + text/plain together
    // and never text/uri-list — confirmed against the plugin's source. That
    // absence, not anything about the html content, is what rules it out:
    // this drag's own html/text could otherwise read like a path.
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
  it('saves the picked bytes into the vault and inserts its reference', async () => {
    const fs = fakeFs();
    const bytes = new ArrayBuffer(4);
    const insert = vi.fn();
    const inserter = createImageInserter({
      fs: { ...fs, pickImages: vi.fn(async () => [{ bytes, extension: 'png' }]) },
      insert: into(insert),
    });

    expect(inserter.canPick).toBe(true);
    await inserter.pick();

    expect(fs.saveImageBytes).toHaveBeenCalledWith(bytes, 'png');
    expect(insert).toHaveBeenCalledWith('image-1.png');
  });

  it('registers the URL so the just-inserted image renders without a reload', async () => {
    const fs = fakeFs();
    const inserter = createImageInserter({
      fs: {
        ...fs,
        pickImages: vi.fn(async () => [{ bytes: new ArrayBuffer(4), extension: 'png' }]),
      },
      insert: into(vi.fn()),
    });

    await inserter.pick();

    expect(resolveVaultImageSrc('image-1.png')).toBe('asset://image-1.png');
  });

  it('inserts nothing when the picker is dismissed', async () => {
    const insert = vi.fn();
    const inserter = createImageInserter({
      fs: { ...fakeFs(), pickImages: vi.fn(async () => []) },
      insert: into(insert),
    });

    await inserter.pick();

    expect(insert).not.toHaveBeenCalled();
  });

  it('cannot pick on a host with no picker, and picking is a no-op', async () => {
    const fs = fakeFs();
    const insert = vi.fn();
    const inserter = createImageInserter({ fs, insert: into(insert) });

    expect(inserter.canPick).toBe(false);
    await inserter.pick();

    expect(fs.saveImageBytes).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('cannot pick on a host with no vault FS at all, and picking is a no-op', async () => {
    const insert = vi.fn();
    const inserter = createImageInserter({ fs: null, insert: into(insert) });

    expect(inserter.canPick).toBe(false);
    await inserter.pick();

    expect(insert).not.toHaveBeenCalled();
  });

  it('reports a picker failure instead of throwing at the caller', async () => {
    const reportError = vi.fn();
    const inserter = createImageInserter({
      fs: {
        ...fakeFs(),
        pickImages: vi.fn(() => Promise.reject(new Error('picker exploded'))),
      },
      insert: into(vi.fn()),
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
    const inserter = createImageInserter({ fs, insert: into(insert) });

    await inserter.insertFiles([pngFile('a.png'), pngFile('b.jpg', 'image/jpeg')]);

    expect(fs.saveImageBytes).toHaveBeenNthCalledWith(1, expect.any(ArrayBuffer), 'png');
    expect(fs.saveImageBytes).toHaveBeenNthCalledWith(2, expect.any(ArrayBuffer), 'jpg');
    expect(insert.mock.calls.map((c) => c[0])).toEqual(['image-1.png', 'image-2.jpg']);
  });

  it('inserts the images in the order they were dropped', async () => {
    const insert = vi.fn();
    const inserter = createImageInserter({ fs: fakeFs(), insert: into(insert) });

    await inserter.insertFiles([pngFile('a.png'), pngFile('b.png'), pngFile('c.png')]);

    expect(insert.mock.calls.map((c) => c[0])).toEqual([
      'image-1.png',
      'image-2.png',
      'image-3.png',
    ]);
  });

  it('inserts nothing for an empty list', async () => {
    const fs = fakeFs();
    await createImageInserter({ fs, insert: into(vi.fn()) }).insertFiles([]);
    expect(fs.saveImageBytes).not.toHaveBeenCalled();
  });

  it('still inserts the reference when the URL cannot be resolved yet', async () => {
    // The file IS in the vault — only its display URL failed. Refusing to
    // insert would throw the user's image away over a render detail, and the
    // node view re-resolves itself on a later render anyway.
    const insert = vi.fn();
    const inserter = createImageInserter({
      fs: fakeFs({ getImageUrl: vi.fn(() => Promise.reject(new Error('no asset protocol'))) }),
      insert: into(insert),
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
      insert: into(insert),
      reportError,
    });

    await inserter.insertFiles([pngFile('a.png'), pngFile('b.png')]);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls.map((c) => c[0])).toEqual(['image-ok.png']);
  });

  it('does nothing on a host with no vault FS', async () => {
    const insert = vi.fn();
    await createImageInserter({ fs: null, insert: into(insert) }).insertFiles([pngFile()]);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('createImageInserter — dropped paths (the Tauri drag-drop event)', () => {
  it('copies each image path into the vault and inserts it', async () => {
    const fs = fakeFs();
    const insert = vi.fn();

    await createImageInserter({ fs, insert: into(insert) }).insertPaths([
      '/pics/one.png',
      '/pics/two.jpg',
    ]);

    expect(fs.saveImagePath).toHaveBeenNthCalledWith(1, '/pics/one.png');
    expect(fs.saveImagePath).toHaveBeenNthCalledWith(2, '/pics/two.jpg');
    expect(insert.mock.calls.map((c) => c[0])).toEqual([
      'image-from-one.png',
      'image-from-two.jpg',
    ]);
  });

  it('ignores a dropped markdown file rather than inserting it as an image', async () => {
    const fs = fakeFs();
    const insert = vi.fn();

    await createImageInserter({ fs, insert: into(insert) }).insertPaths(['/notes/todo.md']);

    expect(fs.saveImagePath).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

/*
 * P1, 2026-09-19. Saving an image is asynchronous and the editor is reused
 * across notes, so a drop or a pick started in note A used to insert
 * `![](image-…)` into whatever note was open when the save landed. The claim
 * is taken before the first save, and covers the whole batch.
 * → imageInsertTarget.ts, docs/spec/editor.md "Images"
 */
describe('createImageInserter — an image saved while the note changes', () => {
  /** A vault FS whose saves this test resolves by hand. */
  function pausedFs() {
    const saves: ((filename: string) => void)[] = [];
    const save = (filename: string) =>
      new Promise<string>((resolve) => saves.push(() => resolve(filename)));
    return {
      ...fakeFs(),
      saves,
      saveImagePath: vi.fn(() => save('image-from-drop.png')),
      saveImageBytes: vi.fn(() => save('image-from-bytes.png')),
      pickImages: vi.fn(async () => [{ bytes: new ArrayBuffer(4), extension: 'png' }]),
    };
  }

  function targetOn(note: { id: string }) {
    const insert = vi.fn();
    const discard = vi.fn(async (_filename: string) => {});
    return {
      insert,
      discard,
      target: createImageInsertTarget({ documentToken: () => note.id, insert, discard }),
    };
  }

  it('does not insert a dropped path into the note the user moved on to', async () => {
    const note = { id: 'note-a' };
    const fs = pausedFs();
    const { target, insert, discard } = targetOn(note);

    const running = createImageInserter({ fs, insert: target }).insertPaths(['/pics/one.png']);
    note.id = 'note-b';
    // `insertFiles` reads the File's bytes before it saves, so wait for the
    // save to actually be in flight rather than assuming it is.
    await vi.waitFor(() => expect(fs.saves.length).toBe(1));
    fs.saves.forEach((release) => release());
    await running;

    expect(insert).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('image-from-drop.png'));
  });

  it('does not insert dropped BYTES into the note the user moved on to', async () => {
    const note = { id: 'note-a' };
    const fs = pausedFs();
    const { target, insert, discard } = targetOn(note);

    const running = createImageInserter({ fs, insert: target }).insertFiles([pngFile()]);
    note.id = 'note-b';
    // `insertFiles` reads the File's bytes before it saves, so wait for the
    // save to actually be in flight rather than assuming it is.
    await vi.waitFor(() => expect(fs.saves.length).toBe(1));
    fs.saves.forEach((release) => release());
    await running;

    expect(insert).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('image-from-bytes.png'));
  });

  it('does not insert a picked image into the note the user moved on to', async () => {
    const note = { id: 'note-a' };
    const fs = pausedFs();
    const { target, insert, discard } = targetOn(note);

    // The claim is taken before the PICKER opens, so switching notes while
    // the dialog is up must abandon the pick too, not only a slow save.
    const running = createImageInserter({ fs, insert: target }).pick();
    note.id = 'note-b';
    await vi.waitFor(() => expect(fs.saves.length).toBe(1));
    fs.saves.forEach((release) => release());
    await running;

    expect(insert).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('image-from-bytes.png'));
  });

  it('abandons the REST of a multi-image drop when the note changes halfway', async () => {
    const note = { id: 'note-a' };
    let counter = 0;
    const fs = fakeFs({
      saveImagePath: vi.fn(async (source: string) => {
        counter += 1;
        // The note changes while the first image is being written.
        if (counter === 1) note.id = 'note-b';
        return `image-${counter}-${source.split('/').pop()}`;
      }),
    });
    const { target, insert, discard } = targetOn(note);

    await createImageInserter({ fs, insert: target }).insertPaths([
      '/pics/one.png',
      '/pics/two.png',
    ]);

    expect(insert).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(2));
  });
});

describe('resolveImageInserter', () => {
  it('is pickerless on a host that cannot write image bytes (a plain browser)', () => {
    getFS.mockReturnValue({ getImageUrl: vi.fn() });
    expect(resolveImageInserter(into(vi.fn())).canPick).toBe(false);
  });

  it('picks through the platform FS on a host that can write image bytes', async () => {
    const pickImages = vi.fn(async () => [{ bytes: new ArrayBuffer(4), extension: 'png' }]);
    getFS.mockReturnValue({
      saveImageBytes: vi.fn(async () => 'image-9.png'),
      getImageUrl: vi.fn(async () => 'asset://image-9.png'),
      pickImages,
    });
    const insert = vi.fn();

    const inserter = resolveImageInserter(into(insert));
    expect(inserter.canPick).toBe(true);
    await inserter.pick();

    expect(pickImages).toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith('image-9.png');
  });

  it('survives an environment with no platform FS at all', () => {
    getFS.mockImplementation(() => {
      throw new Error('Platform FS not initialized');
    });
    expect(resolveImageInserter(into(vi.fn())).canPick).toBe(false);
  });
});

// @vitest-environment jsdom
// Imported first: the fixture registers the `$lib/platform` mock, which only reaches modules loaded after it.
import { getFS, pngFile, into, fakeFs, useImageInsertMocks } from './__fixtures__/imageInsertMocks';
import { describe, expect, it, vi } from 'vitest';
import { resolveVaultImageSrc } from '$features/images/vaultImageSrc';
import { createImageInsertTarget } from './imageInsertTarget';
import { createImageInserter, resolveImageInserter } from './imageInsert';

useImageInsertMocks();

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

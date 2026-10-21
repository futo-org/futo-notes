// @vitest-environment jsdom
// Imported first: the fixture registers the `$lib/platform` mock, which only reaches modules loaded after it.
import {
  pngFile,
  transferWith,
  transferWithData,
  useImageInsertMocks,
} from './__fixtures__/imageInsertMocks';
import { describe, expect, it } from 'vitest';
import {
  dropCarriesFiles,
  filePathFromUri,
  filePathsFromDrop,
  imageExtensionFor,
  imageFilesIn,
  imagePathsIn,
  parseUriList,
} from './imageInsert';

useImageInsertMocks();

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

  it.each([
    ['a non-file scheme', 'http://example.com/photo.png'],
    ['a file:// URI naming a different host', 'file://otherhost/home/justin/photo.png'],
    ['unparsable text rather than throwing', 'not a uri at all'],
  ])('rejects %s', (_label, uri) => {
    expect(filePathFromUri(uri)).toBeNull();
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

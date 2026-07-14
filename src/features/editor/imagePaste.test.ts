import { describe, expect, it, vi } from 'vitest';
import { looksLikeImagePaste, pasteImageIntoView } from './imagePaste';
import { resolveImageSrc } from './liveMarkdownTransform';

describe('looksLikeImagePaste', () => {
  const cd = (types: string[], opts: { itemsLen?: number; html?: string } = {}) =>
    ({
      types,
      items: { length: opts.itemsLen ?? types.length },
      getData: (t: string) => (t === 'text/html' ? (opts.html ?? '') : ''),
    }) as never;

  it('triggers for a browser "Copy Image" that arrives as a lone text/html <img>', () => {
    expect(
      looksLikeImagePaste(
        cd(['text/html'], {
          itemsLen: 1,
          html: '<meta charset="utf-8"><img src="https://x/y.jpg">',
        }),
      ),
    ).toBe(true);
  });

  it('triggers for a screenshot copied to the clipboard (empty items)', () => {
    expect(looksLikeImagePaste(cd([], { itemsLen: 0 }))).toBe(true);
  });

  it('triggers when an image/* type is present without a file handle', () => {
    expect(looksLikeImagePaste(cd(['image/png'], { itemsLen: 1 }))).toBe(true);
  });

  it('does NOT hijack a plain-text paste', () => {
    expect(looksLikeImagePaste(cd(['text/plain'], { itemsLen: 1 }))).toBe(false);
  });

  it('does NOT hijack a rich-text paste (text/plain + text/html)', () => {
    expect(looksLikeImagePaste(cd(['text/plain', 'text/html'], { itemsLen: 2 }))).toBe(false);
  });

  it('does NOT hijack a non-image paste with no text/plain (e.g. file uri-list)', () => {
    expect(looksLikeImagePaste(cd(['text/uri-list'], { itemsLen: 1 }))).toBe(false);
  });

  it('does NOT hijack a text/html paste with no <img> (rich text without plain text)', () => {
    expect(
      looksLikeImagePaste(cd(['text/html'], { itemsLen: 1, html: '<b>bold</b> rich text' })),
    ).toBe(false);
  });

  it('does NOT hijack a text/html + text/uri-list paste with no <img>', () => {
    expect(
      looksLikeImagePaste(
        cd(['text/html', 'text/uri-list'], { itemsLen: 2, html: '<a href="file:///x">x</a>' }),
      ),
    ).toBe(false);
  });
});

describe('pasteImageIntoView', () => {
  it('saves the image, registers the URL, and inserts markdown', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    const view = {
      state: { selection: { main: { head: 4 } } },
      dispatch,
      focus,
    };
    const imageFile = {
      type: 'image/png',
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    };

    const result = await pasteImageIntoView(view as never, imageFile, {
      saveImageBytes: vi.fn().mockResolvedValue('pasted.png'),
      getImageUrl: vi.fn().mockResolvedValue('asset://pasted.png'),
    });

    expect(result).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 4, insert: '![](pasted.png)\n' },
      selection: { anchor: 20 },
    });
    expect(focus).toHaveBeenCalled();
    expect(resolveImageSrc('pasted.png')).toBe('asset://pasted.png');
  });

  it('reports failures and does not dispatch editor changes', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    const reportError = vi.fn();
    const view = {
      state: { selection: { main: { head: 0 } } },
      dispatch,
      focus,
    };
    const imageFile = {
      type: 'image/jpeg',
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    };
    const failure = new Error('disk full');

    const result = await pasteImageIntoView(
      view as never,
      imageFile,
      {
        saveImageBytes: vi.fn().mockRejectedValue(failure),
        getImageUrl: vi.fn(),
      },
      reportError,
    );

    expect(result).toBe(false);
    expect(reportError).toHaveBeenCalledWith('Image paste failed:', failure);
    expect(dispatch).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});

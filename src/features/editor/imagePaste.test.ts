// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { classifyImagePaste } from './imagePaste';

/** A DataTransfer stand-in for `classifyImagePaste` — jsdom cannot build one
 *  carrying a File, and these cases never need to. */
function clipboard(options: { types: string[]; text?: string; html?: string }): DataTransfer {
  return {
    types: options.types,
    items: { length: 0 } as unknown as DataTransferItemList,
    getData: (type: string) => {
      if (type === 'text/plain') return options.text ?? '';
      if (type === 'text/html') return options.html ?? '';
      return '';
    },
  } as unknown as DataTransfer;
}

describe('classifyImagePaste — Android content:// clipboard shape (QA #006)', () => {
  it('claims a content:// URI riding on text/plain as a hidden bitmap', () => {
    const data = clipboard({
      types: ['text/plain'],
      text: 'content://media/external/images/media/12345',
    });
    expect(classifyImagePaste(data)).toEqual({ kind: 'hiddenBitmap' });
  });

  it('tolerates surrounding whitespace the WebView sometimes adds', () => {
    const data = clipboard({ types: ['text/plain'], text: '  content://com.app/image.jpg  \n' });
    expect(classifyImagePaste(data)).toEqual({ kind: 'hiddenBitmap' });
  });

  it('leaves a real text/plain paste alone — content: must be the URI SCHEME, not just present', () => {
    const data = clipboard({
      types: ['text/plain'],
      text: 'see the content://... scheme mentioned in this sentence',
    });
    expect(classifyImagePaste(data)).toEqual({ kind: 'none' });
  });

  it('leaves an ordinary text paste alone', () => {
    const data = clipboard({ types: ['text/plain'], text: 'grocery list' });
    expect(classifyImagePaste(data)).toEqual({ kind: 'none' });
  });

  it('is case-insensitive on the scheme', () => {
    const data = clipboard({ types: ['text/plain'], text: 'CONTENT://media/external/images/1' });
    expect(classifyImagePaste(data)).toEqual({ kind: 'hiddenBitmap' });
  });
});

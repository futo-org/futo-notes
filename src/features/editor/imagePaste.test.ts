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
  it.each([
    ['a content:// URI', 'content://media/external/images/media/12345', 'hiddenBitmap'],
    ['whitespace the WebView adds', '  content://com.app/image.jpg  \n', 'hiddenBitmap'],
    ['an upper-case scheme', 'CONTENT://media/external/images/1', 'hiddenBitmap'],
    // content: must be the URI SCHEME, not just present.
    [
      'prose mentioning the scheme',
      'see the content://... scheme mentioned in this sentence',
      'none',
    ],
    ['ordinary text', 'grocery list', 'none'],
  ])('classifies %s on text/plain as %s', (_label, text, kind) => {
    expect(classifyImagePaste(clipboard({ types: ['text/plain'], text }))).toEqual({ kind });
  });
});

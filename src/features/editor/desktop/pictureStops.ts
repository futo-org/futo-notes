import { isImageAtom } from './pictureElements';

/** Where a caret at the DOM point `node`/`offset` draws when that point is beside an image's
 *  element with no text on that side (lineElements.ts `pointInLine`): at the picture's left
 *  edge before it, its right edge after it, on its row (viewport px; caret.ts stands it on the
 *  row's first line unit, where its text stands). Null for any other point. */
export function pictureStopRect(node: Node, offset: number): DOMRect | null {
  if (!(node instanceof HTMLElement)) return null;
  const after = node.childNodes[offset];
  const before = offset > 0 ? node.childNodes[offset - 1] : null;
  const image = isImageAtom(after) ? after : isImageAtom(before) ? before : null;
  if (!image) return null;
  const box = image.getBoundingClientRect();
  const x = image === after ? box.left : box.right;
  // A picture not loaded yet has no height: one pixel at its top, which is its row's.
  return new DOMRect(x, box.top, 0, Math.max(box.height, 1));
}

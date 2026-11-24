/* An image atom's picture (portable-core/images.md): the atom's element (atomElements.ts) keeps
 * the image's whole spelling as its text, drawn at no size, so the page's text, its selection
 * and the engine's display text stay one; the picture is an `<img>` after that text, in the
 * same element. The element is an inline block in its line's text, so a picture sits in the
 * row it falls on, hanging from its top, and text beside it stands on the row's first line
 * (desktopImages.css). The picture has no `src` here: pictureLoading.ts gives it one when it
 * nears the pane. */
import type { ImageDescription } from '@futo-notes/editor/wasm-payloads';
import { setDrawnAttribute } from './atomElements';

/** The class of an image atom's picture. */
export const PICTURE_CLASS = 'picture';

/** The image a picture shows, as the note spells it: what pictureLoading.ts resolves. */
export const PICTURE_SOURCE = 'data-source';

/** On an image's element whose picture will not load: it shows its label instead. */
export const MISSING_PICTURE = 'data-missing';

/** On a selected image's element: the picture is tinted (pictureSelection.ts). */
export const SELECTED_PICTURE = 'data-selected';

/** What the page puts on an image's element and its picture as it loads and selects them
 *  (pictureLoading.ts, pictureSelection.ts): not what the line draws. */
const PICTURE_STATE = ['src', MISSING_PICTURE, SELECTED_PICTURE, 'style'];

/** A copy of the line element `element` without its pictures' loading and selection, as a
 *  fresh draw of its line would be (lineDrift.ts). */
export function withoutPictureState(element: HTMLElement): HTMLElement {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const image of copy.querySelectorAll('.atom.image')) {
    for (const name of PICTURE_STATE) {
      image.removeAttribute(name);
      pictureOf(image)?.removeAttribute(name);
    }
  }
  return copy;
}

/** The picture `atomElement` (an image atom's element) draws, if it has one yet. */
export function pictureOf(atomElement: Element): HTMLImageElement | null {
  const last = atomElement.lastChild;
  return last instanceof HTMLImageElement ? last : null;
}

/** Whether `node` is an image atom's element. */
export function isImageAtom(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains('image') && !!pictureOf(node);
}

/** Give `atomElement` its picture of `image`, writing only what differs: a line redrawn for a
 *  keystroke keeps its pictures, and their loads, as they are. A missing picture's label
 *  (desktopImages.css) is its alt text, else its file's name. */
export function drawPicture(atomElement: HTMLElement, image: ImageDescription): void {
  let picture = pictureOf(atomElement);
  if (!picture) {
    picture = document.createElement('img');
    picture.className = PICTURE_CLASS;
    picture.draggable = false;
    atomElement.append(picture);
  }
  setDrawnAttribute(picture, 'alt', image.alt);
  setDrawnAttribute(picture, 'title', image.title);
  setDrawnAttribute(picture, PICTURE_SOURCE, image.destination);
  const label = image.alt || image.destination.split('/').pop() || image.destination;
  setDrawnAttribute(atomElement, 'data-label', label);
}

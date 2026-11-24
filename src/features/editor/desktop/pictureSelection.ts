import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { LineModel } from './lineModel';
import { atomElementsOf, setDrawnAttribute } from './atomElements';
import { firstBelow } from './highlight';
import { SELECTED_PICTURE } from './pictureElements';

/** Mark the image elements `range` (UTF-16 display offsets; null for none) holds, which
 *  desktopImages.css tints, as the highlight is drawn behind the text where a picture covers
 *  it: on the lines
 *  near the screen as the highlight draws them, and unmark those of `marked` (the elements
 *  marked last time) it no longer holds; returns the elements marked. A caret marks none and,
 *  with none marked before, reads nothing. */
export function markSelectedPictures(
  elements: readonly HTMLElement[],
  model: LineModel,
  range: DisplayRange | null,
  marked: readonly HTMLElement[],
): HTMLElement[] {
  const selected: HTMLElement[] = [];
  if (range && range.start !== range.end) {
    const screen = window.innerHeight;
    const first = Math.max(model.lineAt(range.start), firstBelow(elements, -screen));
    const last = Math.min(model.lineAt(range.end), firstBelow(elements, 2 * screen));
    for (let index = first; index <= last && index < elements.length; index++) {
      const line = model.lines[index];
      if (!line.atoms.some((atom) => atom.image)) continue;
      const atomElements = atomElementsOf(elements[index]);
      line.atoms.forEach((atom, position) => {
        const start = line.start + atom.start;
        const end = line.start + atom.end;
        if (atom.image && start < range.end && end > range.start) {
          selected.push(atomElements[position]);
        }
      });
    }
  }
  for (const element of marked) {
    if (!selected.includes(element)) element.removeAttribute(SELECTED_PICTURE);
  }
  for (const element of selected) setDrawnAttribute(element, SELECTED_PICTURE, '');
  return selected;
}

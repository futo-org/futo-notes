/* `doc`'s reading of a desktop editor line's images, from the page: what each picture shows
 * (`loaded`, `missing`: its label drawn instead, `pending`: nothing yet), its source as the note
 * spells it, its UTF-16 stops and its drawn box (viewport CSS px). */
import { atomElementsOf } from '$features/editor/desktop/atomElements';
import type { Line } from '$features/editor/desktop/lineModel';
import { MISSING_PICTURE, pictureOf } from '$features/editor/desktop/pictureElements';

export interface PuppetPicture {
  at: number;
  end: number;
  source: string;
  shows: 'loaded' | 'missing' | 'pending';
  box: { left: number; top: number; width: number; height: number };
}

/** The pictures of `line`, drawn in `element`; none for a line without images. */
export function puppetPicturesOf(line: Line, element: HTMLElement): PuppetPicture[] {
  if (!line.atoms.some((atom) => atom.image)) return [];
  const atomElements = atomElementsOf(element);
  const pictures: PuppetPicture[] = [];
  line.atoms.forEach((atom, index) => {
    const atomElement = atomElements[index];
    if (!atom.image || !atomElement) return;
    const picture = pictureOf(atomElement);
    const { left, top, width, height } = atomElement.getBoundingClientRect();
    const shows = atomElement.hasAttribute(MISSING_PICTURE)
      ? 'missing'
      : picture?.complete && picture.naturalWidth > 0
        ? 'loaded'
        : 'pending';
    pictures.push({
      at: line.start + atom.start,
      end: line.start + atom.end,
      source: atom.image.destination,
      shows,
      box: { left, top, width, height },
    });
  });
  return pictures;
}

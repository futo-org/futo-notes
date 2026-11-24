/* A wikilink's element (atomElements.ts): its text is the link's whole `[[target]]`, kept for
 * the caret, the selection and the engine's offsets but drawn at no size, and the engine's label
 * is drawn after it from `data-label` (desktopLinks.css), muted when the link resolves to no
 * note. */
import type { Line } from './lineModel';
import type { WikilinkAtom } from './lineLinks';
import { atomElementsOf, setDrawnAttribute } from './atomElements';

/** The class of every wikilink's element (its atom kind's). */
export const WIKILINK_CLASS = 'wikilink';

/** The class of a wikilink's element, after the atom class: `wikilink`, and `unresolved` when
 *  it names no note or several. */
export function wikilinkClass(atom: WikilinkAtom): string {
  return atom.noteId === null ? `${WIKILINK_CLASS} unresolved` : WIKILINK_CLASS;
}

/** Give the wikilink elements of a line drawn from `line` the label they show. */
export function drawWikilinkLabels(element: HTMLElement, line: Line): void {
  if (!line.atoms.some((atom) => atom.kind === 'Wikilink')) return;
  const elements = atomElementsOf(element);
  line.atoms.forEach((atom, index) => {
    if (atom.kind === 'Wikilink' && elements[index]) {
      setDrawnAttribute(elements[index], 'data-label', atom.label);
    }
  });
}

/** Where a caret at the DOM point `node`/`offset` in a wikilink's own text draws: that text is
 *  drawn at no size and gives no box, so at its element's left edge (its start, and inside
 *  it) or right edge (its end), one pixel tall at the bottom of the element's box on that row
 *  (viewport px; caret.ts stands it on the row). Null for any other point. */
export function wikilinkStopRect(node: Node, offset: number): DOMRect | null {
  const element = node.parentElement;
  if (!(node instanceof Text) || !element?.classList.contains(WIKILINK_CLASS)) return null;
  const boxes = element.getClientRects();
  if (boxes.length === 0) return null;
  const end = offset === node.length;
  const box = end ? boxes[boxes.length - 1] : boxes[0];
  return new DOMRect(end ? box.right : box.left, box.bottom - 1, 0, 1);
}

/* The elements a line draws its atoms in (lineSegments.ts): each holds the atom's one
 * character, so the page's text, its selection and the engine's display text are one, and
 * desktopEditor.css draws what the atom stands for over it. A list item's marker is drawn from
 * the line's list description: a bullet's dot, an ordered item's marker as typed, a task's
 * checkbox (a `role="checkbox"` a click toggles: pointer.ts). */
import type { ListDescription } from '@futo-notes/editor/wasm-payloads';
import { localizedText } from '$shared/localization';
import type { Line, LineAtom } from './lineModel';
import { drawPicture } from './pictureElements';
import { drawWikilinkLabels, wikilinkClass } from './wikilinkElements';

/** The class of a task's marker, its checkbox. */
export const TASK_BOX_CLASS = 'task-box';

/** The class of every atom's element. */
export const ATOM_CLASS = 'atom';

/** An atom element's classes: `atom`, then its kind (`divider`, `image`, a wikilink's:
 *  wikilinkElements.ts) or, for a list item's marker, `marker` and `bullet`, `ordered` or the
 *  task's checkbox class. */
export function atomClass(atom: LineAtom, list: ListDescription | null): string {
  if (atom.kind === 'Wikilink') return `${ATOM_CLASS} ${wikilinkClass(atom)}`;
  if (atom.kind !== 'ListMarker') return `${ATOM_CLASS} ${atom.kind.toLowerCase()}`;
  const marker = list?.checked != null ? TASK_BOX_CLASS : list?.ordered ? 'ordered' : 'bullet';
  return `${ATOM_CLASS} marker ${marker}`;
}

/** Set or remove `name` on `element`, writing nothing when it already holds `value`. */
export function setDrawnAttribute(element: Element, name: string, value: string | null): void {
  if (element.getAttribute(name) === value) return;
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** Give the atom elements of a line drawn from `line` what they draw: an ordered item's
 *  marker as typed (`data-marker`), a task's checkbox its role, name and state, an image its
 *  picture (pictureElements.ts). */
export function drawAtoms(element: HTMLElement, line: Line): void {
  if (line.atoms.length === 0) return;
  drawWikilinkLabels(element, line);
  const list = line.list;
  if (line.atoms.some((atom) => atom.image)) {
    const atomElements = atomElementsOf(element);
    line.atoms.forEach((atom, index) => atom.image && drawPicture(atomElements[index], atom.image));
  }
  for (const child of element.children) {
    if (!child.classList.contains('marker')) continue;
    const task = list?.checked != null;
    setDrawnAttribute(child, 'data-marker', list?.ordered && !task ? list.marker : null);
    setDrawnAttribute(child, 'role', task ? 'checkbox' : null);
    setDrawnAttribute(child, 'aria-label', task ? localizedText('common.actions.done') : null);
    setDrawnAttribute(child, 'aria-checked', task ? String(list!.checked) : null);
  }
}

/** The elements a line element draws its atoms in, in order: one per atom of its line, a table
 *  cell's among them. */
export function atomElementsOf(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(`.${ATOM_CLASS}`)];
}

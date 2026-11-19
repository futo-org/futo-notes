/* A code block's "add a line above" and "add a line below" labels, as !300 has them: "above" in
 * its header's spacer, so a long name squeezes it; "below" at the foot of a zone over its last
 * line's skirt and the space under the card (the gap to the next block, or two lines under a
 * block that ends the note). Both are drawn on every block, and CSS shows each only where no
 * ordinary line reaches that edge (desktopCodeBlocks.css): their presence follows the lines
 * around the block, which a redraw of the block's own lines does not see. A label's text is the
 * catalog's, in an attribute CSS draws, so it holds no text node: it is not in the note's text,
 * its offsets or a copy. A press on one is codeBlockPress.ts's, its reveal
 * codeBlockEdgeReveal.ts's. */
import { localizedText } from '$shared/localization';

const EDGE_LABEL_CLASS = 'code-edge-label';
const EDGE_BELOW_CLASS = 'code-edge-below';

/** An add-a-line label: "above" for a header, "below" for the zone under a block. */
export function buildEdgeLabel(below: boolean): HTMLElement {
  const label = document.createElement('span');
  label.className = EDGE_LABEL_CLASS;
  label.setAttribute('role', 'button');
  label.setAttribute(
    'aria-label',
    localizedText(below ? 'editor.codeBlock.addLineBelow' : 'editor.codeBlock.addLineAbove'),
  );
  return label;
}

export function isCodeEdgeBelow(node: Node | null): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains(EDGE_BELOW_CLASS);
}

/** The add-a-line label `node` is in or is, or null. */
export function codeEdgeLabelOf(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>(`.${EDGE_LABEL_CLASS}`) ?? null;
}

/** The zone below a block that `node` is in or is, or null. */
export function codeEdgeBelowOf(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>(`.${EDGE_BELOW_CLASS}`) ?? null;
}

/** The label in a header or a zone below a block. */
export function edgeLabelIn(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(`.${EDGE_LABEL_CLASS}`);
}

/** Draw the zone below its block into `element`, a code line, right after `header` (its first
 *  child, or null), while the line is its block's `last`; otherwise drop it. Returns the zone. */
export function drawEdgeBelow(
  element: HTMLElement,
  last: boolean,
  header: HTMLElement | null,
): HTMLElement | null {
  const next = header ? header.nextSibling : element.firstChild;
  const zone = isCodeEdgeBelow(next) ? next : null;
  if (!last) {
    zone?.remove();
    return null;
  }
  if (zone) return zone;
  const built = document.createElement('span');
  built.className = EDGE_BELOW_CLASS;
  built.setAttribute('contenteditable', 'false');
  built.append(buildEdgeLabel(true));
  element.insertBefore(built, next);
  return built;
}

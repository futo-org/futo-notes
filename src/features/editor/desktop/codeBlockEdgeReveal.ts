/* Which add-a-line label the pointer shows (codeBlockEdges.ts): a header's while the pointer is
 * anywhere on that header row, fields included, and the one below a block while it is in that
 * zone. Read from `mouseover`, which fires on crossing into an element, never per pixel, and
 * cleared only when the pointer leaves the editor: moving onto a label is not leaving the row
 * under it. Not `:hover`: WebKit paints none in a window in the background. */
import { codeHeaderOf } from './codeBlockChrome';
import { codeEdgeBelowOf, edgeLabelIn } from './codeBlockEdges';

const SHOWN_CLASS = 'shown';

/** The label a pointer over `target` shows, or null. */
export function edgeLabelShownAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node)) return null;
  const host = codeHeaderOf(target) ?? codeEdgeBelowOf(target);
  return host ? edgeLabelIn(host) : null;
}

/** Show the label under the pointer on the editor `dom`. Returns the listeners' removal. */
export function listenEdgeLabelReveal(dom: HTMLElement): () => void {
  let shown: HTMLElement | null = null;
  const show = (label: HTMLElement | null): void => {
    if (label === shown) return;
    shown?.classList.remove(SHOWN_CLASS);
    label?.classList.add(SHOWN_CLASS);
    shown = label;
  };
  const over = (event: Event): void => show(edgeLabelShownAt(event.target));
  const leave = (): void => show(null);
  dom.addEventListener('mouseover', over);
  dom.addEventListener('mouseleave', leave);
  return () => {
    dom.removeEventListener('mouseover', over);
    dom.removeEventListener('mouseleave', leave);
  };
}

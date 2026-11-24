/* A press on a fenced code block's chrome (portable-core/fenced-code.md). One on its "add a line
 * above" or "add a line below" label (codeBlockEdges.ts), or in the zone below it from that
 * label down, opens a line at that edge, the caret there; one in that zone above the label is
 * the last code line's, at the column pressed (hitTest.ts). One on its header row, anywhere
 * but its fields, its copy button and its label (codeBlockHeader.ts), selects the block as one
 * object, and one in the empty space below a block that ends the note opens a line after it.
 * A press in its code is any line's. */
import { codeHeaderOf } from './codeBlockChrome';
import { codeEdgeBelowOf, codeEdgeLabelOf, edgeLabelIn } from './codeBlockEdges';
import { openLineBesideBlock } from './openLineBesideBlock';
import type { EditorView } from './view';

/** Answer a press on a code block's chrome, or below a block that ends the note; false for
 *  any other press, which the pointer takes as usual. */
export function pressCodeBlock(view: EditorView, event: MouseEvent): boolean {
  const target = event.target instanceof Node ? event.target : null;
  if (pressEdge(view, target, event)) return true;
  const header = codeHeaderOf(target);
  if (header?.parentNode) {
    if (!view.hasFocus()) view.focus(false);
    view.selection.selectCodeBlock(view.offsetOf(header.parentNode, 0));
    return true;
  }
  const lines = view.displayLines();
  const end = lines[lines.length - 1];
  const elements = view.lineElements();
  if (!end?.code || event.shiftKey || !view.dom.isContentEditable) return false;
  if (event.clientY < elements[elements.length - 1].getBoundingClientRect().bottom) return false;
  if (!view.hasFocus()) view.focus(false);
  openLineBesideBlock(view, end.start);
  return true;
}

/** A press on an add-a-line label, or in the zone below a block from its label down: a line
 *  opened at that edge, the caret on it. False for any other press. */
function pressEdge(view: EditorView, target: Node | null, event: MouseEvent): boolean {
  if (event.shiftKey || !view.dom.isContentEditable) return false;
  const label = codeEdgeLabelOf(target);
  const header = codeHeaderOf(label);
  const host = header ?? codeEdgeBelowOf(target);
  const line = host?.parentElement;
  if (!host || !line) return false;
  const labelBottom = edgeLabelIn(host)?.getBoundingClientRect().bottom ?? Infinity;
  if (!label && event.clientY < labelBottom) return false;
  if (!view.hasFocus()) view.focus(false);
  openLineBesideBlock(view, view.offsetOf(line, 0), header !== null);
  return true;
}

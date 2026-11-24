/* The caret moves a fenced code block leaves to the host (portable-core/fenced-code.md). On a
 * block selected as one object an arrow puts the caret beside it: Up at the end of the line
 * above (at the note's start nowhere), Down at the start of the line below, or past a block
 * that ends the note on a line it opens there; Left at its code's start and Right at its end,
 * on an empty block as Up and Down. Down from a caret on the last row of a block that ends the
 * note opens a line after it too. */
import { openLineBesideBlock } from './openLineBesideBlock';
import type { EditorView } from './view';

function placeCaret(view: EditorView, at: number): void {
  view.selection.select(at, at, { arrival: { kind: 'landed' } });
}

/** Move off the selected block by the unshifted arrow `key`; false when no block is
 *  selected or `key` is no arrow. */
export function arrowFromSelectedBlock(view: EditorView, key: string): boolean {
  const block = view.selection.selectedBlock();
  if (!block || !key.startsWith('Arrow')) return false;
  const empty = block.start === block.end;
  const up = key === 'ArrowUp' || (empty && key === 'ArrowLeft');
  const down = key === 'ArrowDown' || (empty && key === 'ArrowRight');
  if (!up && !down) {
    placeCaret(view, key === 'ArrowLeft' ? block.start : block.end);
    return true;
  }
  const lines = view.displayLines();
  if (up) {
    const above = lines[view.lineAt(block.start) - 1];
    if (above) placeCaret(view, above.start + above.text.length);
    return true;
  }
  const below = lines[view.lineAt(block.end) + 1];
  if (below) placeCaret(view, below.start);
  else openLineBesideBlock(view, block.start);
  return true;
}

/** Down from a caret on the last row of a code block that ends the note: a line opened after
 *  the block, the caret on it. False anywhere else, where Down moves the caret. */
export function downOffNoteEndBlock(view: EditorView): boolean {
  const range = view.selection.range();
  const lines = view.displayLines();
  if (!range || range.start !== range.end || view.lineAt(range.start) !== lines.length - 1) {
    return false;
  }
  if (!lines[lines.length - 1].code) return false;
  const stop = view.hitTest.verticalStop(range.start, view.selection.rowEnd(), true, null);
  if (!stop.pastNote) return false;
  openLineBesideBlock(view, range.start);
  return true;
}

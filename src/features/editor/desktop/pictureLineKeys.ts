/* Up and Down off a selection held in a line of pictures alone: the caret goes beside that
 * line, as off a code block selected as one object (codeBlockKeys.ts), not up or down from the
 * selection's edge as in text. */
import { isPictureLine } from './blockNeighbours';
import type { EditorView } from './view';

/** Move off the selected pictures by the unshifted arrow `key`: Up to the end of the line
 *  above, Down to the start of the line below; with no line there, to the selection's start or
 *  end. False for any other key or selection. */
export function arrowFromSelectedPictures(view: EditorView, key: string): boolean {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;
  const range = view.selection.sync();
  if (!range || range.start === range.end) return false;
  const lines = view.displayLines();
  const index = view.lineAt(range.start);
  const line = lines[index];
  if (range.end > line.start + line.text.length || !isPictureLine(line)) return false;
  const up = key === 'ArrowUp';
  const beside = lines[index + (up ? -1 : 1)];
  const edge = up ? range.start : range.end;
  const stop = up ? beside && beside.start + beside.text.length : beside?.start;
  const at = stop ?? edge;
  view.selection.select(at, at, { arrival: { kind: 'landed' } });
  view.followCaret();
  return true;
}

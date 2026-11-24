import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { EditorView } from './view';

/** Backspace with the caret right after an image, or forward Delete right before one, selects
 *  the image, and the next press deletes it (docs/spec/editor/desktop/images.md): true when it
 *  selected one. A caret, as UTF-16 display `selection`, anywhere else is left to the engine. */
export function selectImageBesideCaret(
  view: EditorView,
  selection: DisplayRange,
  forward: boolean,
): boolean {
  if (selection.start !== selection.end) return false;
  const line = view.displayLines()[view.lineAt(selection.start)];
  const at = selection.start - line.start;
  const image = line.atoms.find((atom) => atom.image && (forward ? atom.start : atom.end) === at);
  if (!image) return false;
  view.selection.select(line.start + image.start, line.start + image.end);
  return true;
}

/* A wikilink is one unit (Mason, 2026-11-17, "for now"): the caret never stands inside it,
 * Left and Right step over it (keys.ts), and a selection the user makes takes it whole. The
 * engine deletes it whole (Backspace after it, Delete before it, a range that cuts it:
 * portable-core/wikilinks.md); it shows the whole `[[target]]` as display text and has no
 * `resolve_selection` yet, so the page keeps the caret out. A wikilink being typed is not one
 * yet (typedWikilink.ts). */
import type { Affinity, DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { SelectionEnds } from './codeBlockSelection';
import { atomElementsOf } from './atomElements';
import type { LineModel } from './lineModel';
import { wikilinkAround } from './lineLinks';

/** The wikilink UTF-16 display `offset` is strictly inside, as a display range. */
function wikilinkHolding(model: LineModel, offset: number): DisplayRange | null {
  const line = model.lines[model.lineAt(offset)];
  const atom = wikilinkAround(line, offset - line.start);
  return atom ? { start: line.start + atom.start, end: line.start + atom.end } : null;
}

/** Where an end of a selection moved to `offset` from `previous` (UTF-16) stands: out of a
 *  wikilink on the side it was going, or, going nowhere, on its nearer side. */
function outside(model: LineModel, offset: number, previous: DisplayRange): number {
  const link = wikilinkHolding(model, offset);
  if (!link) return offset;
  if (offset > previous.end) return link.end;
  if (offset < previous.start) return link.start;
  return offset - link.start < link.end - offset ? link.start : link.end;
}

/** A selection the user made from `previous` (both UTF-16 display), each end out of any
 *  wikilink it fell inside: a word motion or a vertical move lands on the far side of one in
 *  its direction. */
export function fitSelectionToWikilinks(
  model: LineModel,
  ends: SelectionEnds,
  previous: DisplayRange,
): SelectionEnds {
  const anchor = outside(model, ends.anchor, previous);
  const focus = outside(model, ends.focus, previous);
  return anchor === ends.anchor && focus === ends.focus ? ends : { anchor, focus };
}

/** Which half of a wikilink's `element` viewport `x` on the line row `row` is on, by its box on
 *  that row (the label wraps), the first rows counting as before the middle and the last as
 *  after; null off its boxes. A box is found by its row, not its height: the element's own
 *  text is drawn at no size, so its boxes are as flat as that text. */
export function wikilinkSideAt(
  element: Element | undefined,
  x: number,
  row: { top: number; bottom: number },
): Affinity | null {
  const boxes = [...(element?.getClientRects() ?? [])];
  const index = boxes.findIndex((box) => {
    const middle = (box.top + box.bottom) / 2;
    return x >= box.left && x < box.right && middle >= row.top && middle < row.bottom;
  });
  if (index < 0) return null;
  const box = boxes[index];
  const middle = boxes.length === 1 ? (box.left + box.right) / 2 : null;
  if (middle !== null) return x < middle ? 'Backward' : 'Forward';
  return index < boxes.length / 2 ? 'Backward' : 'Forward';
}

/** The viewport x a caret at UTF-16 `offset` draws at when a wikilink starts or ends there:
 *  the label's left or right edge (`element` is the line's element). Its text is drawn at no
 *  size before the label, so the text's own point there is not where the label ends. */
export function wikilinkCaretX(
  model: LineModel,
  element: HTMLElement,
  offset: number,
): number | null {
  const line = model.lines[model.lineAt(offset)];
  const at = offset - line.start;
  let index = -1;
  let ends = false;
  line.atoms.forEach((atom, position) => {
    if (atom.kind !== 'Wikilink') return;
    if (atom.end === at) [index, ends] = [position, true];
    else if (atom.start === at && index < 0) index = position;
  });
  if (index < 0) return null;
  const boxes = atomElementsOf(element)[index]?.getClientRects();
  if (!boxes?.length) return null;
  return ends ? boxes[boxes.length - 1].right : boxes[0].left;
}

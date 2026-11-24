/* Which side of a format's edge the caret is on. There one offset is two places, and the
 * engine's affinity says which: the formats the next character typed takes are that side's
 * (portable-core/interpretation-and-input.md). The engine's selection holds it; the page
 * chooses it only where it puts the caret (`affinity`, by how the caret came there) and
 * reads the engine's answer back (selection.ts `affinity`). Only at inline code's edge do the
 * two sides look apart: Left and Right stop on each (`step`), and the caret draws inside the
 * code's box when it would type code, else outside it (`place`), as the flag says. */
import type { Affinity, DisplayRange } from '@futo-notes/editor/wasm-payloads';
import { caretViewportRect } from './caret';
import { desktopEditorDebug } from './debugToggles.svelte';
import { arrivalAffinity, codeEdge, type CaretArrival } from './formats';
import type { EditorView } from './view';
import { wikilinkCaretX } from './wikilinkUnit';

/** How a native move (the browser's Left and Right, AppKit's Ctrl+F and Ctrl+A) went from
 *  `previous` to a caret at `at`: past the characters on the way, or nowhere. */
function nativeArrival(previous: DisplayRange, at: number): CaretArrival {
  if (at >= previous.end && at > previous.start) return { kind: 'passed', forward: true };
  if (at <= previous.start && at < previous.end) return { kind: 'passed', forward: false };
  return { kind: 'landed' };
}

export class EditorCaretSide {
  constructor(private readonly view: EditorView) {}

  /** The engine's affinity for a selection from UTF-16 `start` to `end`, come from `previous`
   *  by `arrival` (formats.ts `arrivalAffinity`), a native move's read from where it went. A
   *  selection has no side: the text before it, at the note's start the text after it. */
  affinity(
    start: number,
    end: number,
    previous: DisplayRange,
    arrival: CaretArrival | undefined,
  ): Affinity {
    const model = this.view.lineModel();
    if (start !== end || !model) return start === 0 ? 'Forward' : 'Backward';
    const line = model.lines[model.lineAt(start)];
    const came = arrival ?? nativeArrival(previous, start);
    return arrivalAffinity(line, start - line.start, came, desktopEditorDebug.formatEdge);
  }

  /** Left (`forward` false) or Right at inline code's edge: from the side the key points away
   *  from, the caret takes the other side at the same offset, passing no character. False
   *  where the key moves on instead. */
  step(forward: boolean): boolean {
    const view = this.view;
    const range = view.selection.sync();
    const edge = range && range.start === range.end ? this.codeEdgeAt(range.start) : null;
    const side = forward ? 'Forward' : 'Backward';
    if (!range || !edge || view.selection.affinity() === side) return false;
    view.selection.select(range.start, range.start, { arrival: { kind: 'stepped', side } });
    return true;
  }

  /** Where a caret at UTF-16 `offset` stands (with `rowEnd`, at the end of the row above): its
   *  DOM point and, for the engine's caret at inline code's edge that would not type code, the
   *  viewport x of the code box's edge it draws at. Either way it stands in the code's text,
   *  so a soft wrap at the edge puts it on the code's row. */
  place(offset: number, rowEnd = false): { point: [Node, number]; edge: number | null } {
    const range = this.view.selection.range();
    const caret = range?.start === offset && range.end === offset;
    const edge = caret ? this.codeEdgeAt(offset) : null;
    const point = this.view.pointAt(offset, rowEnd || !!edge?.codeBefore);
    const model = this.view.lineModel();
    const element = model && this.view.lineElements()[model.lineAt(offset)];
    const wikilinkX = caret && element ? wikilinkCaretX(model, element, offset) : null;
    if (wikilinkX !== null) return { point, edge: wikilinkX };
    if (!edge || this.inside()) return { point, edge: null };
    return { point, edge: this.boxEdge(offset, edge.codeBefore) };
  }

  /** Where a caret at UTF-16 `offset` draws (viewport px), as `place` stands it: null on an
   *  empty line, which draws no glyph box. */
  clientRect(offset: number, rowEnd = false): DOMRect | null {
    const { point, edge } = this.place(offset, rowEnd);
    const rect = caretViewportRect(...point, rowEnd);
    return rect && edge !== null ? new DOMRect(edge, rect.top, 0, rect.height) : rect;
  }

  /** The side of UTF-16 `offset` a press at viewport `x` is on: at inline code's edge, the
   *  code's side on its box (padding included) and the other side off it; elsewhere the side
   *  of the character under the pointer. */
  pressedSide(offset: number, x: number): Affinity {
    const edge = this.codeEdgeAt(offset);
    const boundary = edge
      ? this.boxEdge(offset, edge.codeBefore)
      : caretViewportRect(...this.view.pointAt(offset))?.left;
    return boundary !== undefined && x < boundary ? 'Backward' : 'Forward';
  }

  private codeEdgeAt(offset: number): { codeBefore: boolean } | null {
    const model = this.view.lineModel();
    if (!model) return null;
    const line = model.lines[model.lineAt(offset)];
    return codeEdge(line, offset - line.start);
  }

  /** Whether the caret would type code, a format toggled at it included. */
  private inside(): boolean {
    return this.view.currentEngine()?.activeFormats().includes('Code') ?? false;
  }

  /** The viewport x of the outer edge of the code box that ends (`codeBefore`) or starts at
   *  UTF-16 `offset`: a line that starts or ends in code has no text beyond its box to stand
   *  in, so the caret outside it is placed by the box. */
  private boxEdge(offset: number, codeBefore: boolean): number {
    const [code] = this.view.pointAt(offset, codeBefore);
    const boxes = code.parentElement!.getClientRects();
    return codeBefore ? boxes[boxes.length - 1].right : boxes[0].left;
  }
}

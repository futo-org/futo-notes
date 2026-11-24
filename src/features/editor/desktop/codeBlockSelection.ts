/* How a selection meets fenced code blocks: one the user anchors in a block's code stays in
 * that code, one made from below starts past the line break after a block, and how it draws
 * (desktopCodeBlocks.css). A block the engine takes whole, the one selected as an object or
 * one an ordinary selection reaches into or out of
 * (portable-core/fenced-code.md: delete, cut, copy and typing take it whole there), fills its
 * card, header and line numbers included. A selection inside one block's code stays in the
 * code's column: off the gutter and its rule, inside the card's right padding. */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { Line, LineModel } from './lineModel';
import { isCodeHeader } from './codeBlockChrome';
import type { Band } from './highlight';

/** A code block as display lines: its first and last line's indices, its code's UTF-16
 *  range, and where the line after it starts (Infinity at the note's end). */
export interface CodeBlockLines {
  first: number;
  last: number;
  range: DisplayRange;
  below: number;
}

/** A selection's anchor and focus, UTF-16 display offsets. */
export interface SelectionEnds {
  anchor: number;
  focus: number;
}

/** The selection the user made from `ends`, fitted to the code blocks around it. One anchored
 *  in a block's code stays in that code, its focus pinned to the code's first or last position,
 *  so it never reaches the prose, the header or the next block, and the engine never takes the
 *  block whole for it. An anchor on the code's edge whose focus runs out past that edge selects
 *  nothing. An empty block has no code to anchor in, and the whole note (Select All, whose
 *  anchor is the note's start) is not anchored in a block that opens the note. One made from
 *  below whose focus stops at the end of a block's code holds only the line break after the
 *  block, which reaches no part of it (!300): it starts past that break instead, a caret when
 *  the break was all it held. */
export function fitSelectionToCodeBlocks(model: LineModel, ends: SelectionEnds): SelectionEnds {
  const { anchor, focus } = ends;
  const index = model.lineAt(anchor);
  const wholeNote = Math.min(anchor, focus) === 0 && Math.max(anchor, focus) === model.length;
  if (wholeNote) return ends;
  if (model.lines[index].code) {
    const code = codeBlockLinesAt(model.lines, index).range;
    if (code.start !== code.end) {
      return { anchor, focus: Math.min(Math.max(focus, code.start), code.end) };
    }
  }
  return startPastBlockEnd(model, ends);
}

/** `ends` from below with its focus moved past the line break after a non-empty block whose
 *  code ends at the focus. */
function startPastBlockEnd(model: LineModel, ends: SelectionEnds): SelectionEnds {
  const { anchor, focus } = ends;
  if (focus >= anchor) return ends;
  const index = model.lineAt(focus);
  const line = model.lines[index];
  if (!line.code?.last || focus !== line.start + line.text.length) return ends;
  const block = codeBlockLinesAt(model.lines, index);
  if (block.range.start === block.range.end) return ends;
  return { anchor, focus: block.below };
}

/** The block holding code line `index` of `lines`. */
export function codeBlockLinesAt(lines: readonly Line[], index: number): CodeBlockLines {
  let first = index;
  while (first > 0 && !lines[first].code?.first) first--;
  let last = index;
  while (last < lines.length - 1 && !lines[last].code?.last) last++;
  const end = lines[last];
  return {
    first,
    last,
    range: { start: lines[first].start, end: end.start + end.text.length },
    below: lines[last + 1]?.start ?? Infinity,
  };
}

/** Whether the engine takes `block` whole for an ordinary selection `range`: one that reaches
 *  into its code from before it, or out of it past its code's end (it then holds the line
 *  break that stands for the closing fence). One inside its code, or that only meets its edge,
 *  stays out.
 *  An empty block is taken by a selection that starts before or on it and runs past it, or at
 *  the note's end reaches it. The page's reading of the engine's `block_reach`, which no
 *  session method reports. A selection out of the code is one made from the line after it,
 *  or one the engine restores (Undo): one the user anchors in the code stays there
 *  (`fitSelectionToCodeBlocks`). */
export function isBlockTakenWhole(
  range: DisplayRange,
  block: CodeBlockLines,
  noteLength: number,
): boolean {
  const { start, end } = range;
  const code = block.range;
  if (start === end) return false;
  if (code.start === code.end) {
    return start <= code.start && (end > code.start || end === noteLength);
  }
  return (start < code.start && end > code.start) || (start < code.end && end > code.end);
}

/** Whether every line UTF-16 `range` touches is code: the format toolbar does not show
 *  there. */
export function isWithinCode(model: LineModel, range: DisplayRange): boolean {
  const last = model.lineAt(range.end);
  for (let index = model.lineAt(range.start); index <= last; index++) {
    if (!model.lines[index].code) return false;
  }
  return true;
}

/** The card of `block`, from its header's top to its last line's bottom, relative to
 *  `base`. */
export function cardBand(
  elements: readonly HTMLElement[],
  block: CodeBlockLines,
  base: DOMRect,
): Band {
  const first = elements[block.first];
  const header = isCodeHeader(first.firstChild) ? first.firstChild : first;
  const top = header.getBoundingClientRect().top;
  const box = first.getBoundingClientRect();
  const bottom = elements[block.last].getBoundingClientRect().bottom;
  return {
    left: box.left - base.left,
    top: top - base.top,
    width: box.width,
    height: bottom - top,
    rounded: {
      shape: 'code-card',
      topLeft: false,
      topRight: false,
      bottomRight: false,
      bottomLeft: false,
    },
  };
}

/** A code line's code column, viewport px: inside its gutter and its right padding. */
export function codeColumnOf(element: HTMLElement, box: DOMRect): [left: number, right: number] {
  const style = getComputedStyle(element);
  return [box.left + parseFloat(style.paddingLeft), box.right - parseFloat(style.paddingRight)];
}

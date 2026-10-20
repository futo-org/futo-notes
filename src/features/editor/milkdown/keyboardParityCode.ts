import { type Command, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { blockFormatAtPos } from './blockCommands';

/**
 * QA #011 — Tab/Shift-Tab inside a fenced code block.
 *
 * A COLLAPSED caret INDENTS relative to ITSELF (two spaces right at the
 * caret, wherever it sits) but OUTDENTS relative to its LINE (up to two
 * spaces stripped from the line's own start, the same as a real code
 * editor's Shift-Tab) — see the `empty` branch below for why those can't
 * share one rule. A non-collapsed selection indents/outdents every LINE it
 * touches at that line's own start (a same-line selection gets the identical
 * per-line treatment as a multi-line one).
 *
 * Requires BOTH ends of the selection to resolve into the SAME code block —
 * a selection reaching past the fence is left alone, same as every other
 * block command's fence rule.
 */
function tabInCodeBlock(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  outdent: boolean,
): boolean {
  const { $from, $to, empty } = state.selection;
  if (blockFormatAtPos($from).kind !== 'code' || blockFormatAtPos($to).kind !== 'code') {
    return false;
  }
  const start = $from.start($from.depth);
  if ($to.start($to.depth) !== start) return false;
  const codeNode = $from.node($from.depth);
  const text = codeNode.textContent;
  const tr = state.tr;

  // A collapsed caret INDENTING inserts two spaces right AT the caret,
  // wherever it sits in the line — a literal Tab character, not "indent this
  // line". A collapsed caret OUTDENTING falls through to the per-line
  // handling below instead: Shift-Tab dedents the CURRENT line from its own
  // start (same as every other code editor), regardless of the caret's
  // column — the line's leading whitespace is not necessarily "immediately
  // before the caret" (Home puts the caret BEFORE it, at true column 0).
  if (empty && !outdent) {
    tr.insertText('  ', $from.pos);
    dispatch?.(tr.scrollIntoView());
    return true;
  }

  // Every line the selection overlaps, in doc order, computed once against
  // the ORIGINAL text — the edits below are applied last-line-first so an
  // earlier (smaller) line's start position is never invalidated by an edit
  // made at a later (larger) one.
  const lines: { start: number; end: number }[] = [];
  let offset = start;
  for (const line of text.split('\n')) {
    lines.push({ start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  const touched = lines.filter((line) => line.start <= $to.pos && line.end >= $from.pos);
  if (touched.length === 0) return false;

  let changed = false;
  for (const line of [...touched].reverse()) {
    if (outdent) {
      const rel = line.start - start;
      const ahead = text.slice(rel, rel + 2);
      const strip = ahead.startsWith('  ') ? 2 : ahead.startsWith(' ') ? 1 : 0;
      if (strip > 0) {
        tr.delete(line.start, line.start + strip);
        changed = true;
      }
    } else {
      tr.insertText('  ', line.start);
      changed = true;
    }
  }
  if (!changed) return false;
  dispatch?.(tr.scrollIntoView());
  return true;
}

/** Command wrappers for the `handleKeyDown` wiring below. */
export const indentCodeBlockOnTab: Command = (state, dispatch) =>
  tabInCodeBlock(state, dispatch, false);
export const outdentCodeBlockOnShiftTab: Command = (state, dispatch) =>
  tabInCodeBlock(state, dispatch, true);

/*
 * Keyboard parity with the CodeMirror editor's interactive elements
 * (docs/spec/editor.md "Interactive elements", issue #108):
 *
 * - Enter in a table cell moves the caret down to the same column of the row
 *   below; only on the LAST row — where there is no row below — does it
 *   append a new one and move into that instead (QA lane 7, 2026-09:
 *   "Enter will create new row" no matter where the caret was, the previous
 *   behavior here, was the reported bug). The grip menu
 *   (`table/tableGrips.ts`) is the deliberate replacement for adding a row
 *   anywhere but the end, since the native shells have no right-click cell
 *   context menu. The gfm preset instead bound bare Enter to `exitTable`,
 *   which dropped a stray empty paragraph after the table.
 * - Tab at the very last cell appends a row (mirroring the CodeMirror
 *   `tableCellNavigation` wrap-around) instead of falling through to the
 *   browser's default Tab, which moved focus out of the editor and silently
 *   swallowed whatever was typed next.
 * - Tab/Shift-Tab inside a CODE BLOCK insert/remove two spaces of indentation
 *   (QA #011) instead of falling through to the browser — the preset binds
 *   Tab only inside lists (`sinkListItemCommand`) and tables, so a fence got
 *   nothing and Tab moved focus out of the editor (to the block's own ⋮ menu),
 *   silently swallowing whatever was typed next. Escape THEN Tab is the
 *   documented way out of that trap for a keyboard-only user: Escape arms a
 *   one-shot flag that makes the very next Tab fall through to the browser
 *   instead of inserting spaces, exactly as if this module were not here;
 *   typing any other key disarms it. Blockquotes and tables are a deliberate
 *   NON-claim — Tab stays ordinary focus navigation there (only a code fence
 *   traps it today), so this is the only new Tab claimant.
 * - Splitting a checked task item starts the new item UNCHECKED, the same as
 *   the CodeMirror `listContinuation` rule — ProseMirror's `splitListItem`
 *   otherwise clones the `checked: true` attr onto the new item.
 *
 * QA #004 (Backspace at the start of a nested list item keeps its
 * indentation rather than merging everything into the top-level item) needed
 * NO new code here: the preset's own `liftFirstListItemCommand`
 * (`joinBackward`) already produces exactly that — `list_item` is
 * `defining: true` in the schema, so `joinBackward`'s generic lift keeps a
 * nested item's content inside its enclosing item instead of merging past it.
 * Verified end-to-end against the real bundle for the plain case, a second
 * Backspace, a top-level item, and both a following- and a preceding-sibling
 * nested item; pinned in `tests/editor-embed-milkdown-interactive.spec.ts`.
 *
 * Wired as the ProseMirror `handleKeyDown` DIRECT view prop (via
 * `editorViewOptionsCtx` in MilkdownEditor.svelte) rather than a keymap
 * plugin, for the same reason `handlePaste` is: direct props are consulted
 * before every plugin keymap, so this wins deterministically over the preset's
 * own Enter/Tab bindings without depending on plugin registration order.
 * Everything it does not explicitly claim falls through untouched —
 * Shift-Enter hard breaks outside a table (inside one, `insertLineBreakInTableCell`
 * claims it — see that command's own doc), Mod-Enter's `exitTable`,
 * Tab/Shift-Tab cell and list navigation, Backspace everywhere, and the
 * list-split Enter for plain and unchecked items.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { splitListItem } from '@milkdown/kit/prose/schema-list';
import {
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import {
  addRow,
  CellSelection,
  isInTable,
  selectedRect,
  TableMap,
  type TableRect,
} from '@milkdown/kit/prose/tables';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { blockFormatAtPos, changeBlockIndent } from './blockCommands';
import { enclosingListItem } from './caretContext';

/**
 * The cell rect of a cursor/text selection inside one table cell, or null for
 * anything this module should leave alone (not in a table, or a
 * prosemirror-tables CellSelection spanning whole cells).
 */
function cursorCellRect(state: EditorState): TableRect | null {
  if (!isInTable(state)) return null;
  if (state.selection instanceof CellSelection) return null;
  return selectedRect(state);
}

/** Add a row at `rowIndex` and put the caret in its `column`-th cell. */
function addRowWithCaret(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  rect: TableRect,
  rowIndex: number,
  column: number,
): boolean {
  if (!dispatch) return true;
  const tr = addRow(state.tr, rect, rowIndex);
  // The row landed inside the table, so the table's own position is unmoved;
  // re-read the node to get a map that includes the new row.
  const table = tr.doc.nodeAt(rect.tableStart - 1) as ProseNode;
  const map = TableMap.get(table);
  const cellPos = rect.tableStart + map.positionAt(rowIndex, column, table);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1), 1));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Move into `(rowIndex, column)` of the SAME table, without changing the
 * document — the not-last-row half of {@link insertTableRowBelow}. `rect` is
 * still valid to read from directly since nothing has mapped it: no
 * transaction has touched the doc yet.
 *
 * Selects the WHOLE cell content rather than dropping a bare caret, matching
 * `goToNextCell`'s own convention (Tab already does this — "goToNextCell
 * selects the cell, typing replaces", tests/editor-embed-milkdown-interactive.spec.ts).
 * A bare caret would have to pick a side of any existing text to land on,
 * which Tab does not have to choose and Enter should not disagree with it
 * over.
 */
function moveCaretToCell(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  rect: TableRect,
  rowIndex: number,
  column: number,
): boolean {
  if (!dispatch) return true;
  const cellPos = rect.tableStart + rect.map.positionAt(rowIndex, column, rect.table);
  const cellNode = state.doc.nodeAt(cellPos);
  if (!cellNode) return false;
  const $cell = state.doc.resolve(cellPos);
  const $afterCell = state.doc.resolve(cellPos + cellNode.nodeSize);
  const tr = state.tr.setSelection(TextSelection.between($cell, $afterCell));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Enter in a table cell: move the caret down to the same column of the row
 * below — GFM cells are single-line, so Enter must never insert a line break
 * inside one, and this always fully handles the key (never falls through to
 * a default paragraph split). Only on the LAST row, where there is no row
 * below, does this insert one and move into it instead — the only case that
 * still creates a row. A header cell is never the last row (the schema
 * requires at least one body row), so Enter there always lands in the first
 * body row rather than inserting a second header.
 */
export const insertTableRowBelow: Command = (state, dispatch) => {
  const rect = cursorCellRect(state);
  if (!rect) return false;
  if (rect.top >= rect.map.height - 1) {
    return addRowWithCaret(state, dispatch, rect, rect.top + 1, rect.left);
  }
  return moveCaretToCell(state, dispatch, rect, rect.top + 1, rect.left);
};

/**
 * Shift+Enter in a table cell: insert a real line break IN the cell, instead
 * of falling through to the preset's own hardbreak handling — which the
 * preset's `hardbreakFilterPlugin` REJECTS outright inside a table (ctx
 * `hardbreakFilterNodes` defaults to `["table", "code_block"]`,
 * `@milkdown/preset-commonmark`'s `hardbreak-filter-plugin.ts`), so the key
 * silently did nothing at all and the very next keystroke landed right where
 * the caret already was: `r1a`, Shift+Enter, `second` saved as `r1asecond`,
 * fusing the two halves with no separator whatsoever. The filter only
 * inspects transactions carrying the `hardbreak` meta the preset's own
 * `insertHardbreakCommand` sets before dispatch, so building the transaction
 * directly here — and never setting that meta — sails past it undetected.
 * `table/tableLineBreak.ts` owns the two markdown round-trip halves this
 * needs on top (a GFM table cell is one line and cannot hold a literal
 * newline, so the break has to serialize as `<br>` and parse back the same
 * way).
 */
export const insertLineBreakInTableCell: Command = (state, dispatch) => {
  const rect = cursorCellRect(state);
  if (!rect) return false;
  const hardbreak = state.schema.nodes.hardbreak;
  if (!hardbreak) return false;
  if (!dispatch) return true;
  dispatch(state.tr.replaceSelectionWith(hardbreak.create()).scrollIntoView());
  return true;
};

/**
 * Tab in the very LAST cell: append a row and put the caret in its first
 * cell — the wrap-around the preset's `goToNextCell` has nowhere to go for.
 * Anywhere else it declines, leaving Tab to the preset's cell navigation.
 */
export const appendTableRowFromLastCell: Command = (state, dispatch) => {
  const rect = cursorCellRect(state);
  if (!rect) return false;
  const { map } = rect;
  if (rect.top !== map.height - 1 || rect.left !== map.width - 1) return false;
  return addRowWithCaret(state, dispatch, rect, map.height, 0);
};

/**
 * Enter in a CHECKED task item: split with the new item unchecked. An
 * unchecked or non-task item declines — the default split already clones
 * `checked: false` / `null` correctly.
 */
export const splitCheckedTaskItem: Command = (state, dispatch) => {
  const item = enclosingListItem(state.selection);
  if (!item || item.node.attrs.checked !== true) return false;
  return splitListItem(item.node.type, { ...item.node.attrs, checked: false })(state, dispatch);
};

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

/** Command wrappers for direct unit-testing and the `handleKeyDown` wiring below. */
export const indentCodeBlockOnTab: Command = (state, dispatch) =>
  tabInCodeBlock(state, dispatch, false);
export const outdentCodeBlockOnShiftTab: Command = (state, dispatch) =>
  tabInCodeBlock(state, dispatch, true);

/**
 * One-shot "let the next Tab escape the editor" flag, per view — the
 * accessibility hatch QA #011 requires: claiming Tab inside a fence traps a
 * keyboard-only user who has no other way to leave the editor, so Escape
 * arms this, and the very next Tab (whether or not it would otherwise have
 * been claimed) is let through to the browser's default focus-move instead.
 * Any other key disarms it, so the arm only ever survives exactly one
 * intervening Escape-then-Tab pair. A `WeakMap` keyed by view rather than one
 * module-level boolean, because more than one Milkdown editor can be mounted
 * at once (e.g. a preview pane) and Escape in one must not arm Tab in another.
 */
const tabEscapeArmed = new WeakMap<ProseView, boolean>();

/**
 * The `handleKeyDown` direct view prop. Returns true only when one of the
 * parity commands above actually handled the key.
 */
export function handleParityKeyDown(view: ProseView, event: KeyboardEvent): boolean {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;

  if (event.key === 'Escape') {
    tabEscapeArmed.set(view, true);
    return false;
  }
  const armed = tabEscapeArmed.get(view) === true;
  if (event.key !== 'Tab') tabEscapeArmed.delete(view);

  if (event.key === 'Enter' && !event.shiftKey) {
    return (
      insertTableRowBelow(view.state, view.dispatch) ||
      splitCheckedTaskItem(view.state, view.dispatch)
    );
  }
  if (event.key === 'Enter' && event.shiftKey) {
    return insertLineBreakInTableCell(view.state, view.dispatch);
  }
  if (event.key === 'Tab') {
    tabEscapeArmed.delete(view);
    // The escape hatch overrides the code-fence claim below — it exists
    // precisely so a keyboard-only user can never be trapped in one.
    if (armed) return false;
    if (!event.shiftKey && appendTableRowFromLastCell(view.state, view.dispatch)) return true;
    return event.shiftKey
      ? outdentCodeBlockOnShiftTab(view.state, view.dispatch)
      : indentCodeBlockOnTab(view.state, view.dispatch);
  }
  return false;
}

/*
 * Desktop keyboard shortcuts for Indent/Outdent — the standard editor
 * convention (Mod+] / Mod+[), and independent of the Tab decision above: Tab
 * stays plain focus navigation everywhere but a code fence, this claims two
 * keys Tab never touched. Wired from its own `handleKeyDown` slot in
 * MilkdownEditor.svelte (composed ahead of `handleParityKeyDown`, which bails
 * out on any modifier key and so never sees these), not from inside
 * `handleParityKeyDown` above.
 */

/** Whether `event` is the Indent/Outdent chord — Cmd or Ctrl, no other modifier, `]`/`[`. */
function isIndentShortcut(event: KeyboardEvent): 1 | -1 | null {
  if (event.shiftKey || event.altKey) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.key === ']') return 1;
  if (event.key === '[') return -1;
  return null;
}

/**
 * The `handleKeyDown` direct view prop for Mod+]/Mod+[. Declines (returns
 * false) for any other key, or when the caret is not in a container
 * `changeBlockIndent` can act on — same containers the `cursorContext` bridge
 * message and the desktop selection toolbar report (blockCommands.ts
 * `inIndentableContainer`).
 */
export function handleIndentShortcut(view: ProseView, event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  const direction = isIndentShortcut(event);
  if (direction === null) return false;
  return changeBlockIndent(direction)(view.state, view.dispatch);
}

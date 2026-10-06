/*
 * Shift+Enter inside a GFM table cell (docs/spec/editor.md "Tables";
 * reported as `r1a`, Shift+Enter, `second` saving as `r1asecond` with no
 * separator at all).
 *
 * ROOT CAUSE — this is not a serialization bug, it never reaches the
 * serializer. `@milkdown/preset-commonmark`'s `hardbreakFilterPlugin`
 * (`src/plugin/hardbreak-filter-plugin.ts`) REJECTS any transaction that
 * would insert a hardbreak node inside a `table` (or `code_block`) ancestor —
 * the ctx slice `hardbreakFilterNodes` defaults to exactly
 * `["table", "code_block"]`. The filter is keyed on the `hardbreak`
 * transaction meta the preset's own `insertHardbreakCommand` sets before
 * dispatch, and `filterTransaction` runs before the transaction is ever
 * applied, so Shift+Enter's hardbreak insert vanishes with NO document change
 * at all: the caret never moves, and the very next keystroke lands exactly
 * where it already was, fusing the text on either side. Confirmed against a
 * real `Editor` (not inferred from reading the plugin alone): dispatching the
 * exact same transaction WITHOUT the `hardbreak` meta is not filtered and
 * lands a real `hardbreak` node in the table cell's paragraph.
 *
 * THE FIX has two halves that both have to hold, since a GFM table cell is
 * one line of markdown and cannot contain a literal newline:
 *
 * 1. Save — the serializer writes a line break inside a table cell as `<br>`
 *    (docs/spec/editor.md "Markdown house style"), the standard, and only
 *    legal, way to spell one inside a single-line GFM table cell.
 * 2. Load — {@link restoreTableCellLineBreaks}. A `<br>` beside other content
 *    inside a table cell parses back through remark as an inert mdast `html`
 *    node — `packages/editor/src/milkdown-compat/emptyLine.ts`'s
 *    `fixEmptyLinePlaceholders` deliberately keeps it exactly that way, since
 *    that function owns a DIFFERENT bug (an empty-paragraph filler
 *    placeholder, not a real line break) and correctly leaves an inline
 *    `<br>` with siblings alone. Left alone, the node reaches the ProseMirror
 *    document as the `html` schema's inert atom, rendering as the LITERAL
 *    TEXT "<br>" rather than a visual break. This module's `$remark` plugin
 *    turns that `html` node back into a real mdast `break` node so
 *    `hardbreakSchema`'s own `parseMarkdown` builds a real hardbreak —
 *    deliberately skipped when the `<br>` is the cell's ONLY child, since
 *    that shape is indistinguishable from an older build's empty-paragraph
 *    filler placeholder and `fixEmptyLinePlaceholders` already owns turning
 *    that into a genuinely empty cell; leaving it alone here means the two
 *    `$remark` plugins never have to agree on registration order.
 *
 * The command that actually inserts the break lives in `../keyboardParity.ts`
 * (`insertLineBreakInTableCell`) — it never sets the `hardbreak` transaction
 * meta, so `hardbreakFilterPlugin` never sees a reason to reject it.
 *
 * The load half is bundled into `tableGrips.ts`'s exported plugin array
 * (mounted with the feature's one `.use(tableGrips)` in editorPlugins.ts)
 * rather than adding a second `.use()` call there.
 */
import { $remark } from '@milkdown/kit/utils';
import type { MdastNode } from '@futo-notes/editor/milkdown-compat';

/** Depth-first walk over the slice of mdast this module reads/writes — a
 * five-line local copy of `packages/editor/src/milkdown-compat/mdast.ts`'s
 * `walk`, which that package does not export (only its `MdastNode` type
 * does). */
function walk(node: MdastNode, visit: (node: MdastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * The literal spellings a hardbreak node's `toMarkdown` can emit for a plain
 * (non-inline) break — copied from `emptyLine.ts`'s own `BR_PLACEHOLDERS` for
 * the same reason that module keeps it: these are the only shapes `<br>`
 * round-trips through remark as.
 */
const BREAK_TAGS = new Set(['<br />', '<br>', '<br >', '<br/>']);

function isBreakTag(node: MdastNode): boolean {
  return node.type === 'html' && BREAK_TAGS.has((node.value ?? '').trim());
}

/**
 * Turns an inline `<br>` beside other content inside a table cell back into a
 * real mdast `break` node. See the module doc for why a lone `<br>` (the
 * cell's only child) is deliberately left as-is.
 */
export function restoreTableCellLineBreaks(tree: MdastNode): void {
  walk(tree, (node) => {
    if (node.type !== 'tableCell' || !node.children || node.children.length < 2) return;
    node.children = node.children.map((child): MdastNode =>
      isBreakTag(child) ? { type: 'break' } : child,
    );
  });
}

/** The load half, as a `$remark` plugin. */
export const tableCellLineBreakRemark = $remark(
  'remark-futo-table-cell-linebreak',
  () => () => (tree: MdastNode) => {
    restoreTableCellLineBreaks(tree);
  },
);

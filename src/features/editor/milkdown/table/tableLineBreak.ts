/*
 * Shift+Enter inside a GFM table cell (docs/spec/editor.md "Tables" Gap;
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
 * 1. Save — {@link tableCellLineBreakSerializer}. `mdast-util-gfm-table`
 *    marks `\n`/`\r` "unsafe" inside a `tableCell` construct, and
 *    `mdast-util-to-markdown`'s default `hardBreak` handler
 *    (`lib/handle/break.js`) reacts to that by writing a bare space — or
 *    nothing at all when the preceding character is already whitespace —
 *    instead of a real break. That IS the `r1a`+Shift+Enter+`second`
 *    fusion, if the break had reached the document unfiltered but still hit
 *    the default serializer. `<br>` is the standard, and only legal, way to
 *    spell a line break inside a single-line GFM table cell, so this
 *    installs a `break` node handler that writes it literally whenever the
 *    serializer is inside a `tableCell` construct, and reproduces the plain
 *    `\` + newline spelling everywhere else (see that function's own doc for
 *    why this can't wrap the library's real default instead).
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
 * Both halves here are bundled into `tableGrips.ts`'s exported plugin array
 * (mounted with the feature's one `.use(tableGrips)` in MilkdownEditor.svelte)
 * rather than adding a second `.use()` call there.
 */
import { $remark } from '@milkdown/kit/utils';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
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

/** The load half: mounted as one `$remark` plugin alongside the save half
 * below. */
export const tableCellLineBreakRemark = $remark(
  'remark-futo-table-cell-linebreak',
  () => () => (tree: MdastNode) => {
    restoreTableCellLineBreaks(tree);
  },
);

/**
 * The save half: installs a `break`-node handler into the serializer that
 * writes literal `<br>` whenever the current construct stack is inside a
 * `tableCell`, and otherwise reproduces the plain hard break spelling
 * (`\` + newline) unchanged.
 *
 * UNLIKE `MilkdownEditor.svelte`'s own `remarkStringifyOptionsCtx` update for
 * the tag-escaping fix, this cannot WRAP an existing handler — Milkdown's
 * core only pre-registers `text`/`strong`/`emphasis` into
 * `remarkStringifyOptionsCtx`'s default `handlers` map
 * (`@milkdown/core`'s own `remark-handlers.ts`); `break` reaches
 * `mdast-util-to-markdown` purely as ITS OWN built-in default
 * (`defaultHandlers.break`, `mdast-util-to-markdown/lib/handle/break.js`),
 * which is not exposed anywhere this module could import — that package is
 * only a devDependency of `@futo-notes/editor` (types for tests), and
 * importing its runtime code here would be exactly the phantom-dependency
 * problem `stringifyHandlers.ts` documents avoiding. So the non-table branch
 * below reproduces upstream's own fallback line (`'\\\n'`) directly — the one
 * unsafe-`\n` registration in this app's whole remark pipeline is
 * `mdast-util-gfm-table`'s `tableCell` entry, so this is not a partial
 * reimplementation of a general rule, it is upstream's ONE other case.
 */
export const tableCellLineBreakSerializer: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (options) => ({
    ...options,
    handlers: {
      ...options.handlers,
      break: (_node, _parent, state) => (state.stack.includes('tableCell') ? '<br>' : '\\\n'),
    },
  }));
  return () => {};
};

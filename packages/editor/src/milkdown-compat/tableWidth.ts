import { $remark } from '@milkdown/kit/utils';

import type { MdastNode } from './mdast';
import { walk } from './mdast';

/**
 * Every row of a table as wide as its widest row, padded at the END.
 *
 * GFM lets a body row hold more cells than the header (the excess is ignored
 * when rendering) or fewer (the rest render empty). ProseMirror's table model
 * needs a rectangle, and `prosemirror-tables`' `fixTables` — which the gfm
 * preset runs over every table it loads — squares a ragged one up by inserting
 * the missing cells at the START of each short row above the wide one. Their
 * cells then sat one column right of where they were written, and the next
 * save put every value in those rows under the wrong header (RC-42): a single
 * trailing `| |` on the last row was enough.
 *
 * Padding in the tree instead, before ProseMirror sees it, leaves `fixTables`
 * nothing to do. Short rows gain empty cells after their last one and the
 * header gains empty columns (alignment unset), so every value stays under the
 * column it was written in and nothing is dropped (Q13 option 13A). The first
 * save writes the widened table once; it is a fixed point after that.
 */
export function padTableRows(tree: MdastNode): void {
  walk(tree, (node) => {
    if (node.type !== 'table' || !node.children) return;
    const width = Math.max(0, ...node.children.map((row) => row.children?.length ?? 0));
    for (const row of node.children) {
      const cells = (row.children ??= []);
      while (cells.length < width) cells.push({ type: 'tableCell', children: [] });
    }
    const align = ((node as { align?: (string | null)[] | null }).align ??= []);
    while (align.length < width) align.push(null);
  });
}

/** {@link padTableRows} as a remark transformer (part of `gfmWithCompat()`). */
export const remarkPadTableRowsPlugin = $remark('futo-pad-table-rows', () => () => padTableRows);

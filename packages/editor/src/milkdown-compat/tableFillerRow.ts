import { nodesCtx } from '@milkdown/kit/core';
import type { Node as ProseNode, TagParseRule } from '@milkdown/kit/prose/model';
import type { Transaction } from '@milkdown/kit/prose/state';
import { ReplaceStep } from '@milkdown/kit/prose/transform';
import type { NodeSchema } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';

/**
 * A table with no body row keeps none through an edit.
 *
 * The gfm schema needs a body row (`table_header_row table_row+`), so a
 * header-only table (`| a | b |\n| - | - |`) reads with a row of no cells.
 * prosemirror-tables' `fixTables` fills that row with empty cells the first
 * time a transaction touches the table (the load's own `replaceAll` does), and
 * from then on it was a row like any the author wrote: the first edit anywhere
 * in the table saved it as `|  |  |`.
 *
 * So the row `fixTables` fills from nothing is marked (`table_row.filler`), and
 * the serializer does not write a filler row while every cell in it is empty
 * (`packages/editor/src/markdown/normalize.ts`). The editor still shows it, and
 * typing into it makes it a written row. A row the author wrote, empty or
 * not, and a row the editor adds (Enter, Tab, a grip) are never filler.
 */
const FILLER_ATTR = 'filler';
const FILLER_DOM_ATTR = 'data-filler';

/**
 * Whether `row` is the schema's filler as no file holds it, so a save does not
 * write it: a table row with no cells, or a marked filler row whose cells are
 * all empty (one empty paragraph each). The serializer states the same rule
 * over the document's JSON (`isUnwrittenRow`, ../markdown/normalize.ts).
 */
export function isUnwrittenFillerRow(row: ProseNode): boolean {
  if (row.type.spec.tableRole !== 'row') return false;
  if (row.childCount === 0) return true;
  if (row.attrs[FILLER_ATTR] !== true) return false;
  let empty = true;
  row.forEach((cell) => {
    cell.forEach((block) => {
      if (block.type.name !== 'paragraph' || block.childCount > 0) empty = false;
    });
  });
  return empty;
}

/**
 * A body row with no cells, filled with `cells` and marked as the filler, as
 * `fixTables` fills and `markRowsFilledFromNothing` marks it on load. For a
 * table that has not reached a transaction yet: a pasted one.
 */
export function asFillerRow(row: ProseNode, cells: readonly ProseNode[]): ProseNode {
  return row.type.create({ ...row.attrs, [FILLER_ATTR]: true }, cells, row.marks);
}

/**
 * `tr` (`fixTables`' repair) with every table row it filled from nothing
 * marked as the filler. Read off the steps: an insertion into a row that had
 * no cells just before it.
 */
export function markRowsFilledFromNothing(tr: Transaction): Transaction {
  const rows: number[] = [];
  tr.steps.forEach((step, index) => {
    if (!(step instanceof ReplaceStep)) return;
    if (step.from !== step.to) return;
    const $at = tr.docs[index]?.resolve(step.from);
    if (!$at || $at.depth === 0) return;
    const row = $at.parent;
    if (row.type.spec.tableRole !== 'row' || row.childCount !== 0) return;
    rows.push(tr.mapping.slice(index + 1).map($at.before()));
  });
  for (const pos of rows) {
    const row = tr.doc.nodeAt(pos);
    if (!row || row.childCount === 0 || row.attrs[FILLER_ATTR] === true) continue;
    tr.setNodeMarkup(pos, undefined, { ...row.attrs, [FILLER_ATTR]: true });
  }
  return tr;
}

/**
 * The preset's `table_row` with the `filler` attribute, kept through the DOM
 * so a copy and paste of the table inside the editor keeps it too. Part of
 * `gfmWithCompat()`, after the preset.
 */
export const tableFillerRowSchema = $node('table_row', (ctx) => {
  const registered = ctx.get(nodesCtx).find(([name]) => name === 'table_row');
  if (!registered) {
    throw new Error(
      "milkdown-compat: no 'table_row' node registered before the filler-row override. " +
        'It must come after the gfm preset in gfmWithCompat().',
    );
  }
  const upstream: NodeSchema = registered[1];
  const { toDOM } = upstream;
  if (!toDOM || !upstream.parseDOM) {
    throw new Error("milkdown-compat: 'table_row' no longer has parseDOM/toDOM to wrap.");
  }
  const parseDOM = (upstream.parseDOM as readonly TagParseRule[]).map((rule): TagParseRule => ({
    ...rule,
    getAttrs: (dom: HTMLElement) => {
      const attrs = rule.getAttrs ? rule.getAttrs(dom) : (rule.attrs ?? {});
      if (!attrs) return attrs;
      return { ...attrs, [FILLER_ATTR]: dom.hasAttribute(FILLER_DOM_ATTR) };
    },
  }));
  return {
    ...upstream,
    attrs: { ...upstream.attrs, [FILLER_ATTR]: { default: false } },
    parseDOM,
    toDOM: (node: ProseNode) => {
      const spec = toDOM(node);
      if (node.attrs[FILLER_ATTR] !== true || !Array.isArray(spec)) return spec;
      // Upstream's is `['tr', 0]`; an attrs object, if it ever has one, is the second entry.
      const [tag, ...rest] = spec as unknown[];
      const own = typeof rest[0] === 'object' && rest[0] !== null && !Array.isArray(rest[0]);
      const attrs = own ? (rest.shift() as object) : {};
      return [tag, { ...attrs, [FILLER_DOM_ATTR]: '' }, ...rest] as unknown as ReturnType<
        typeof toDOM
      >;
    },
  };
});

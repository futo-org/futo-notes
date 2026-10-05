import { nodesCtx } from '@milkdown/kit/core';
import type { Node as ProseNode, TagParseRule } from '@milkdown/kit/prose/model';
import type { NodeSchema } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';

/**
 * A table cell's "no alignment" survives a trip through the DOM.
 *
 * `@milkdown/preset-gfm` gives every cell an `alignment` attribute that is
 * `null` for a `| --- |` column, but spells it to the DOM as
 * `text-align: ${value || 'left'}` and reads it back as
 * `style.textAlign || 'left'`. Every paste goes through the DOM — a plain-text
 * paste too, which Milkdown's clipboard plugin parses as markdown, serializes
 * to DOM and parses back — so a pasted table came out `| :- |` while opening
 * the same table and editing it wrote `| -- |` (RC-59): one table, two
 * spellings, and an alignment nobody chose.
 *
 * The cell's DOM keeps the same `text-align: left` it always had (a header
 * cell is centred by default, so dropping the style would move it), and a
 * cell with no alignment is marked `data-align-unset`. On the way back in that
 * mark — or no inline `text-align` at all, which is what a table copied from
 * another app has — reads as `null`. An explicit `left`, `center` or `right`
 * reads as before.
 */
const UNSET_ATTR = 'data-align-unset';

function withUnsetAlignmentThroughDom(id: string) {
  return $node(id, (ctx) => {
    const registered = ctx.get(nodesCtx).find(([name]) => name === id);
    if (!registered) {
      throw new Error(
        `milkdown-compat: no '${id}' node registered before the alignment override. ` +
          'It must come after the gfm preset in gfmWithCompat().',
      );
    }
    const upstream: NodeSchema = registered[1];
    const { toDOM } = upstream;
    if (!toDOM || !upstream.parseDOM) {
      throw new Error(`milkdown-compat: '${id}' no longer has parseDOM/toDOM to wrap.`);
    }
    const parseDOM = (upstream.parseDOM as readonly TagParseRule[]).map((rule): TagParseRule => ({
      ...rule,
      getAttrs: (dom: HTMLElement) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : (rule.attrs ?? {});
        if (!attrs) return attrs;
        const unset = dom.hasAttribute(UNSET_ATTR) || !dom.style.textAlign;
        return unset ? { ...attrs, alignment: null } : attrs;
      },
    }));
    return {
      ...upstream,
      parseDOM,
      toDOM: (node: ProseNode) => {
        const spec = toDOM(node);
        if (node.attrs.alignment != null || !Array.isArray(spec)) return spec;
        const [tag, attrs, ...rest] = spec as unknown[];
        return [tag, { ...(attrs as object), [UNSET_ATTR]: '' }, ...rest] as unknown as ReturnType<
          typeof toDOM
        >;
      },
    };
  });
}

/** Both cell kinds; part of `gfmWithCompat()`, after the preset. */
export const tableAlignmentSchemas = [
  withUnsetAlignmentThroughDom('table_header'),
  withUnsetAlignmentThroughDom('table_cell'),
];

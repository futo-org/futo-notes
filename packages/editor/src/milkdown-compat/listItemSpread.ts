import { nodesCtx } from '@milkdown/kit/core';
import type { NodeSchema } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';

const LIST_ITEM_NODE = 'list_item';

/**
 * A list item made by typing is TIGHT, like one read from a tight file (RC-102).
 *
 * `@milkdown/preset-commonmark` gives `list_item` a `spread` attribute that
 * defaults to `true`, and the markdown parser always sets it from the source —
 * so a note read from disk carries the truth, but an item made by the editor
 * (`- ` typed, Enter, the toolbar) carries the default. `spread` on an item
 * decides only how ITS OWN children are separated: a lone paragraph shows
 * nothing, but the moment Tab gives the item a nested list, remark writes a
 * blank line between the item's text and the list —
 * `- item b\n\n  - nested c` — where the same list opened from a tight file and
 * edited stayed `- item b\n  - nested c`. One list, two spellings, and the
 * loose one is a different document to any other Markdown renderer (the item
 * text becomes a `<p>`).
 *
 * The blank lines BETWEEN items are the list's `spread`, whose default is
 * already `false`, so this changes only what an item the editor creates says
 * about its own children. Parsed and pasted items keep the value they were read
 * with (`parseMarkdown` and `parseDOM` both set it explicitly).
 *
 * Same override shape as `./tableAlignment`: `$node` upserts `nodesCtx` by id,
 * so this must come after the gfm preset, which extends `list_item` for task
 * items, and everything but the attribute's default is read back and passed on.
 */
export const tightListItemSchema = $node(LIST_ITEM_NODE, (ctx) => {
  const registered = ctx.get(nodesCtx).find(([id]) => id === LIST_ITEM_NODE);
  if (!registered) {
    throw new Error(
      `milkdown-compat: no '${LIST_ITEM_NODE}' node registered before the tight-item override. ` +
        'It must come after the gfm preset in gfmWithCompat().',
    );
  }
  const upstream: NodeSchema = registered[1];
  const spread = upstream.attrs?.spread;
  if (!spread || spread.default !== true) {
    throw new Error(
      `milkdown-compat: '${LIST_ITEM_NODE}' no longer has a spread attribute defaulting to true — ` +
        'the upstream default this override exists for has changed; delete or update it.',
    );
  }
  return { ...upstream, attrs: { ...upstream.attrs, spread: { ...spread, default: false } } };
});

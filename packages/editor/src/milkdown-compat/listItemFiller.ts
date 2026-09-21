import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { nodesCtx, schemaCtx, SchemaReady } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeSchema, SerializerState } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';

const PARAGRAPH_NODE = 'paragraph';

/** Stamped on the runner this module installs, so the guard can recognise it. */
const FILLER_AWARE = Symbol('milkdown-compat:filler-aware-paragraph-runner');

/**
 * Whether `paragraph`, about to be serialized, is the paragraph ProseMirror
 * ADDED to the front of a list item rather than one the note had.
 *
 * The preset's `list_item` content expression is `paragraph block*`, so when
 * markdown gives an item whose only content is a block — `* > quote`,
 * `* # heading`, `* ` over an indented nested list, 299 notes of the 31k-note
 * census — `createAndFill` puts an empty paragraph in front of it to satisfy
 * the schema. No blank line in the file corresponds to it, and `./emptyLine`
 * deliberately restores none inside a container, so on the way back out it has
 * to go: written as an empty paragraph it becomes a bare `*` line over an
 * indented block, which remark reads back as a paragraph holding a literal `*`
 * and escapes to `\*` on the next save (60 census notes went unstable this way
 * before this fix; under upstream it was the `* <br />` the census called
 * `bullet_br_injected`).
 *
 * "First child of the list item being built" is exactly "the open mdast node is
 * a `listItem` with nothing in it yet". A genuinely empty item — the paragraph
 * is its ONLY child — is caught by the same test and is fine: a `listItem` with
 * no children and one holding an empty paragraph both serialize as a bare `*`.
 */
function isListItemFiller(state: SerializerState, paragraph: ProseNode): boolean {
  if (paragraph.content.size !== 0) return false;
  const parent = state.top();
  return parent?.type === 'listItem' && (parent.children?.length ?? 0) === 0;
}

/**
 * The preset's `paragraph` node with one change to its serializer: a paragraph
 * that {@link isListItemFiller} recognises is not written at all.
 *
 * Why the paragraph and not the list item: the gfm preset re-registers
 * `list_item` (task-list `checked`) AFTER this preset and calls the commonmark
 * runner it captured at import time, so an override of `list_item` here is
 * silently replaced the moment `gfm` is `.use()`d. Nothing re-registers
 * `paragraph`, and {@link paragraphFillerGuard} makes sure that stays true.
 *
 * Same override shape as `frontmatter.ts`'s doc override: `$node` upserts
 * `nodesCtx` by id, so this must be ordered after the commonmark preset in
 * `commonmarkWithCompat()`, and everything but the `toMarkdown` runner is read
 * back off the registered entry and passed through — upstream's own runner is
 * called for every paragraph that is not the filler.
 */
export const paragraphWithoutFillerSchema = $node(PARAGRAPH_NODE, (ctx) => {
  const registered = ctx.get(nodesCtx).find(([id]) => id === PARAGRAPH_NODE);
  if (!registered) {
    throw new Error(
      `milkdown-compat: no '${PARAGRAPH_NODE}' node registered before the filler override. ` +
        'It must come after the commonmark preset in commonmarkWithCompat().',
    );
  }
  const upstream: NodeSchema = registered[1];
  const upstreamToMarkdown = upstream.toMarkdown;
  const runner = (state: SerializerState, node: ProseNode, ...rest: unknown[]): void => {
    if (isListItemFiller(state, node)) {
      // A genuinely empty item would otherwise close with `children` still
      // undefined, and mdast-util-to-markdown's list-item handlers (the gfm
      // task-list one included) read `node.children[0]` unguarded.
      const parent = state.top();
      if (parent) parent.children ??= [];
      return;
    }
    // Upstream's runner is `(state, node)`; spread so any later parameter is
    // passed through unchanged.
    (upstreamToMarkdown.runner as (...args: unknown[]) => void)(state, node, ...rest);
  };
  Object.defineProperty(runner, FILLER_AWARE, { value: true });
  return { ...upstream, toMarkdown: { ...upstreamToMarkdown, runner } };
});

/**
 * Fails editor creation if some later plugin replaced the paragraph node's
 * serializer — which is how the `list_item` version of this fix died silently.
 * Loud beats a `\*` appearing in a user's note on the second save.
 */
export const paragraphFillerGuard: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(SchemaReady);
  const spec = ctx.get(schemaCtx).nodes[PARAGRAPH_NODE]?.spec as
    { toMarkdown?: { runner?: object } } | undefined;
  const runner = spec?.toMarkdown?.runner as Record<symbol, unknown> | undefined;
  if (runner?.[FILLER_AWARE] !== true) {
    throw new Error(
      `milkdown-compat: the '${PARAGRAPH_NODE}' serializer is not the filler-aware one — ` +
        'a plugin registered after commonmarkWithCompat() replaced it. ' +
        'Re-order so this preset comes after that plugin, or teach that plugin to wrap the runner.',
    );
  }
};

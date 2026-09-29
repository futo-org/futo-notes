import { nodesCtx } from '@milkdown/kit/core';
import { Fragment } from '@milkdown/kit/prose/model';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeSchema, SerializerState } from '@milkdown/kit/transformer';
import { $node } from '@milkdown/kit/utils';

/**
 * The document's trailing empty paragraphs are not written.
 *
 * `@milkdown/plugin-trailing` parks an empty paragraph after a document whose
 * last block is not a paragraph or heading — a list, quote, table, fence, rule
 * or task — so the caret has somewhere to go below it. The serializer wrote
 * that paragraph like any other, as one more blank line, so the first real edit
 * of every such note ended its file in `\n\n` (RC-22). The spec says a trailing
 * empty paragraph is dropped on save, and a load never produces one: blank
 * lines at the end of a file read back as nothing (`./emptyLine`). Writing them
 * therefore changed the bytes and nothing else.
 *
 * So the doc's serializer skips every empty paragraph at the END of the
 * document — the parked one, one the author made by pressing Enter at the end,
 * and the body paragraph `frontmatter? block+` requires under front matter
 * alone. Empty paragraphs anywhere else are the author's blank lines and are
 * written as before. `blockSerializer.ts` applies the same rule to its units, so
 * the app's cached serialization stays byte-identical to this one.
 */
export function withoutTrailingEmptyParagraphs(nodes: readonly ProseNode[]): ProseNode[] {
  let end = nodes.length;
  while (end > 0 && isEmptyParagraph(nodes[end - 1] as ProseNode)) end -= 1;
  return end === nodes.length ? [...nodes] : nodes.slice(0, end);
}

/**
 * Does `doc` end in more empty paragraphs than a fresh parse of its own
 * serialization would leave?
 *
 * A load parks exactly one empty paragraph after a document whose last block is
 * not a paragraph or heading (the `trailing` plugin) — or, for a document with
 * no such block at all, keeps the single one `block+` requires — and none after
 * a document ending in a paragraph or heading. Enter at the end stacks more, and
 * {@link withoutTrailingEmptyParagraphs} makes those serialize to the same bytes
 * as the document without them. So "same bytes" no longer means "same document":
 * a host `setContent` whose text equals the serialization must still be applied
 * when this is true, or the previous note's blank paragraphs stay on screen
 * under the next note's text (RC-22 regression, F-2).
 */
export function hasSurplusTrailingEmptyParagraphs(doc: ProseNode): boolean {
  const children: ProseNode[] = [];
  doc.forEach((child) => children.push(child));
  const kept = withoutTrailingEmptyParagraphs(children);
  const trailing = children.length - kept.length;
  const last = kept[kept.length - 1];
  // Mirrors @milkdown/plugin-trailing's default `shouldAppend`.
  const parked =
    last === undefined || (last.type.name !== 'paragraph' && last.type.name !== 'heading');
  return trailing > (parked ? 1 : 0);
}

function isEmptyParagraph(node: ProseNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

const DOC_NODE = 'doc';

/**
 * The registered `doc` node with its serializer running on
 * {@link withoutTrailingEmptyParagraphs}.
 *
 * Registered by the same id, AFTER `./frontmatter`'s doc override, and it
 * reads that registration back, so the narrowed content expression and
 * upstream's own runner are both inherited rather than forked.
 */
export const trailingParagraphDocSchema = $node(DOC_NODE, (ctx) => {
  const registered = ctx.get(nodesCtx).find(([id]) => id === DOC_NODE);
  if (!registered) {
    throw new Error(
      `milkdown-compat: no '${DOC_NODE}' node registered before the trailing-paragraph ` +
        'override. It must come after the commonmark preset in commonmarkWithCompat().',
    );
  }
  const upstream: NodeSchema = registered[1];
  const upstreamToMarkdown = upstream.toMarkdown;
  const runner = (state: SerializerState, node: ProseNode, ...rest: unknown[]): void => {
    const children: ProseNode[] = [];
    node.forEach((child) => children.push(child));
    const kept = withoutTrailingEmptyParagraphs(children);
    const written = kept.length === children.length ? node : node.copy(Fragment.fromArray(kept));
    (upstreamToMarkdown.runner as (...args: unknown[]) => void)(state, written, ...rest);
    // A document of nothing but empty paragraphs leaves the root with no child
    // at all, and mdast-util-to-markdown's root handler reads `children`
    // unguarded. Empty is the right answer: it writes ''.
    const root = state.top();
    if (root) root.children ??= [];
  };
  return { ...upstream, toMarkdown: { ...upstreamToMarkdown, runner } };
});

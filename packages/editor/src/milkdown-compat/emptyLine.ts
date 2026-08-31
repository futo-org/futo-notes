import { $remark } from '@milkdown/kit/utils';

import type { MdastNode } from './mdast';
import { walk } from './mdast';

/**
 * The exact placeholder spellings `@milkdown/preset-commonmark`'s paragraph
 * serializer can emit for an empty paragraph, and therefore the only ones its
 * parse-side counterpart may consume. Copied verbatim from the upstream plugin.
 */
const BR_PLACEHOLDERS = new Set(['<br />', '<br>', '<br >', '<br/>']);

/**
 * Parents whose direct children are block (flow) content. An `html` node
 * sitting directly in one of these is a *block* HTML node, which is the shape
 * Milkdown's empty-paragraph placeholder comes back as after a round trip.
 */
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/**
 * Parents whose content is inline, but which Milkdown fills with the same
 * placeholder when they would otherwise be empty (both hold a `paragraph`'s
 * worth of content). A lone `<br />` here is the placeholder; a `<br>` with
 * text on either side is the author's line break.
 */
const INLINE_PLACEHOLDER_PARENTS = new Set(['paragraph', 'tableCell']);

/**
 * Fixed copy of upstream's `visitEmptyLine`.
 *
 * Upstream (`@milkdown/preset-commonmark@7.22.1`,
 * `src/plugin/remark-preserve-empty-line.ts`) deletes *every* `html` node whose
 * trimmed value is one of {@link BR_PLACEHOLDERS}, with no check on where the
 * node sits. That is correct for the placeholder the paragraph serializer emits
 * for an empty paragraph, and silent data loss for an inline `<br>` — the
 * standard way to write a multi-line GFM table cell, and a common manual line
 * break in prose. The tag is deleted with no replacement, fusing the words on
 * either side. 61 notes in the 31k-note corpus census hit this.
 *
 * This copy deletes the node only where the placeholder can actually occur:
 * in block position, or as the sole content of a paragraph/table cell. An
 * inline `<br>` with siblings survives into the document as the inert `html`
 * atom node the schema already renders as literal text.
 *
 * Unknown parent types default to *keeping* the node: leaving a stray literal
 * `<br />` visible is cosmetic, deleting an author's line break is not.
 */
export function fixEmptyLinePlaceholders(tree: MdastNode): void {
  walk(tree, (node, parent) => {
    if (node.type !== 'html') return;
    if (!BR_PLACEHOLDERS.has((node.value ?? '').trim())) return;
    if (!parent?.children) return;

    const index = parent.children.indexOf(node);
    if (index === -1) return;

    const isPlaceholder =
      FLOW_PARENTS.has(parent.type) ||
      (INLINE_PLACEHOLDER_PARENTS.has(parent.type) && parent.children.length === 1);
    if (isPlaceholder) {
      parent.children.splice(index, 1);
      return;
    }

    hoistOverLineBreaks(parent, index);
  });
}

/**
 * Move a kept inline `<br>` in front of any line breaks that immediately
 * precede it.
 *
 * remark's serializer cannot write an eol directly before inline HTML: on the
 * next parse that HTML could start an HTML *block*, so it replaces the eol with
 * a space (mdast-util-to-markdown, deliberately — syntax-tree/
 * mdast-util-to-markdown#15). The break that eol represented is then gone. For
 * a hard break it is worse than gone: its `\` is stranded mid-line, where it is
 * a literal backslash rather than a line break, so `a  \n<br/>b` comes back as
 * `a\ <br/>b` — one line break short and one visible backslash up.
 *
 * Two adjacent line-break markers commute, so putting the tag first sidesteps
 * it entirely: `a<br/>\\\nb` keeps both breaks, adds nothing, and is stable
 * across reloads. Upstream deletes the `<br>` instead, which is why this only
 * starts to matter once the tag is being preserved — 10 notes of the 31k-note
 * census, and the only regressions the compat set introduced before this.
 */
function hoistOverLineBreaks(parent: MdastNode, index: number): void {
  const children = parent.children;
  if (!children) return;
  let target = index;
  while (target > 0 && children[target - 1]?.type === 'break') target -= 1;
  if (target === index) return;
  const [node] = children.splice(index, 1);
  if (node) children.splice(target, 0, node);
}

/**
 * The serializer state fields the empty-cell-aware html handler reads. A type
 * parameter-free structural interface for the same reason
 * `stringifyHandlers.ts` uses one: the real state type lives in
 * `mdast-util-to-markdown`, which this package must not import directly.
 */
export interface HasConstructStack {
  stack: string[];
}

/**
 * A remark-stringify `html` handler that serializes an EMPTY table cell as
 * empty instead of as the `<br />` empty-paragraph placeholder.
 *
 * The paragraph serializer that emits the placeholder is context-blind: it
 * marks every empty paragraph, including the one a ProseMirror `table_cell`
 * wraps its content in. A blank line genuinely needs the placeholder — markdown
 * cannot represent an empty paragraph between paragraphs — but an empty cell
 * is representable as `|  |`, which is what the CodeMirror editor writes and
 * what authors write by hand. Without this handler, any note holding an empty
 * cell had it rewritten to `| <br /> |` by the first unrelated keystroke.
 *
 * The parse side already treats a lone `<br />` in a cell as the placeholder
 * ({@link fixEmptyLinePlaceholders}), so both spellings load as an empty cell
 * and this only changes which of them the save writes. Everything else — the
 * kept inline `<br>` beside content, block placeholders that ARE blank lines,
 * arbitrary html — serializes exactly as the stock handler (`node.value`),
 * `peek` included.
 */
export function htmlWithoutEmptyCellPlaceholder(): (<
  Node extends { value?: string },
  Parent extends { type: string; children?: readonly unknown[] } | undefined,
  State extends HasConstructStack,
>(
  node: Node,
  parent: Parent,
  state: State,
) => string) & { peek(): string } {
  const handler = <
    Node extends { value?: string },
    Parent extends { type: string; children?: readonly unknown[] } | undefined,
    State extends HasConstructStack,
  >(
    node: Node,
    parent: Parent,
    state: State,
  ): string => {
    const value = node.value ?? '';
    const isSolePlaceholder =
      BR_PLACEHOLDERS.has(value.trim()) &&
      parent?.type === 'paragraph' &&
      parent.children?.length === 1;
    // 'tableCell' is the construct mdast-util-gfm-table enters around each
    // cell — the same idiom that library uses internally for in-cell checks.
    if (isSolePlaceholder && state.stack.includes('tableCell')) return '';
    return value;
  };
  handler.peek = () => '<';
  return handler;
}

/**
 * Drop-in replacement for upstream's `remarkPreserveEmptyLinePlugin`.
 *
 * The id string is deliberately identical: `node/paragraph.ts`'s `toMarkdown`
 * only emits the `<br />` placeholder when `ctx.get('remark-preserve-empty-line')`
 * resolves, and `Ctx#get` looks a string up by slice *name*. Registering under
 * any other name would silently turn the serializer half off and start dropping
 * blank lines the author typed.
 */
export const remarkFixedPreserveEmptyLinePlugin = $remark(
  'remark-preserve-empty-line',
  () => () => fixEmptyLinePlaceholders,
);

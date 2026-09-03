import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { $remark } from '@milkdown/kit/utils';

import type { MdastNode } from './mdast';
import { walk } from './mdast';

/**
 * Blank lines are the ONLY way this editor spells an empty paragraph.
 *
 * Markdown has no syntax for an empty paragraph: any run of blank lines between
 * two blocks reads back as one block boundary. `@milkdown/preset-commonmark`
 * papers over that by writing a literal `<br />` on its own line for every
 * non-final empty paragraph (`node/paragraph.ts` `toMarkdown`, gated on a ctx
 * slice named `remark-preserve-empty-line`) and deleting those tags again on
 * load (`remarkPreserveEmptyLinePlugin`). The tag is HTML in a notes file the
 * user reads with other tools, and it appeared in a real note the first time
 * the author pressed Enter twice.
 *
 * This module replaces that scheme with the encoding the plain-text editor
 * always produced and every markdown renderer already tolerates: EXTRA blank
 * lines. Both halves live here so the rule has exactly one definition.
 *
 *   - Load ({@link restoreBlankLineParagraphs}): `N` blank lines between two
 *     sibling blocks become `N - 1` empty paragraphs; `N` blank lines before
 *     the first block of the DOCUMENT become `N` empty paragraphs. Blank lines
 *     at the very end of the document produce nothing, exactly as before — a
 *     trailing empty paragraph is dropped on save today and stays dropped.
 *   - Save ({@link blankLineJoin}): an empty paragraph serializes as nothing,
 *     and the block join AFTER an empty paragraph is a single newline instead
 *     of a blank line. So `a`, empty, `b` writes `a\n\n\nb`, which loads back
 *     as `a`, empty, `b` — stable from the second round trip on.
 *
 * The placeholder tags an older build already wrote are still consumed
 * ({@link fixEmptyLinePlaceholders}), each as ONE empty paragraph, so a legacy
 * note opens looking the same and is rewritten to blank lines on its first real
 * edit (ADR-0002 normalize-once). An author's inline `<br>` beside text — the
 * only legal way to break a line inside a GFM table cell — is untouched, which
 * is the data-loss half of the upstream bug this module originally forked for
 * (61 notes of the 31k-note census).
 */

/**
 * The exact placeholder spellings `@milkdown/preset-commonmark`'s paragraph
 * serializer can emit for an empty paragraph, and therefore the only ones the
 * parse side may consume. Copied verbatim from the upstream plugin.
 */
const BR_PLACEHOLDERS = new Set(['<br />', '<br>', '<br >', '<br/>']);

/**
 * Parents whose direct children are block (flow) content. An `html` node
 * sitting directly in one of these is a *block* HTML node, which is the shape
 * Milkdown's empty-paragraph placeholder comes back as after a round trip —
 * and these are the parents blank-line gaps are counted in.
 */
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/**
 * Parents whose content is inline, but which Milkdown filled with the same
 * placeholder when they would otherwise be empty (both hold a `paragraph`'s
 * worth of content). A lone `<br />` here is the placeholder; a `<br>` with
 * text on either side is the author's line break.
 */
const INLINE_PLACEHOLDER_PARENTS = new Set(['paragraph', 'tableCell']);

const emptyParagraph = (): MdastNode => ({ type: 'paragraph', children: [] });

/**
 * Whether `node` is the empty paragraph this module reads and writes — no
 * children at all. (A paragraph holding only an empty text node is not one:
 * remark never produces that, and the serializer would write it as a blank
 * line too, but the join must not collapse a paragraph that carries content.)
 */
function isEmptyParagraph(node: { type: string; children?: readonly unknown[] }): boolean {
  return node.type === 'paragraph' && (node.children?.length ?? 0) === 0;
}

/**
 * Turns the blank lines remark's parser threw away back into empty paragraphs.
 *
 * remark records where every block starts and ends, so the number of blank
 * lines between two siblings is `right.start.line - left.end.line - 1`, and
 * only one of those is the block boundary itself. Whitespace-only lines count
 * as blank, as CommonMark says. The count is taken from the ORIGINAL siblings
 * before anything is inserted, and a legacy `<br />` block counts as a sibling
 * here — so `a\n\n<br />\n\nb` has two one-line gaps (nothing to add) and the
 * tag becomes the one empty paragraph in {@link fixEmptyLinePlaceholders}.
 *
 * Leading blank lines are restored for the document only. Inside a blockquote
 * or a list item the "gap" before the first child is that container's own
 * marker line (`>` alone, `-` alone), not a paragraph the author typed, and
 * today's behavior — collapse it — is kept. Trailing blank lines are never
 * restored: see the module comment.
 *
 * Nodes without positions (a tree built by hand, or by another transformer)
 * are left alone — there is nothing to count.
 */
export function restoreBlankLineParagraphs(tree: MdastNode): void {
  walk(tree, (node) => {
    if (!FLOW_PARENTS.has(node.type)) return;
    const children = node.children;
    if (!children || children.length === 0) return;

    const gaps: number[] = new Array<number>(children.length + 1).fill(0);
    if (node.type === 'root') {
      const first = children[0]?.position;
      if (first) gaps[0] = Math.max(0, first.start.line - 1);
    }
    for (let i = 0; i + 1 < children.length; i += 1) {
      const left = children[i]?.position;
      const right = children[i + 1]?.position;
      if (!left || !right) continue;
      gaps[i + 1] = Math.max(0, right.start.line - left.end.line - 2);
    }

    if (gaps.every((gap) => gap === 0)) return;
    const restored: MdastNode[] = [];
    for (let i = 0; i < children.length; i += 1) {
      for (let k = 0; k < (gaps[i] ?? 0); k += 1) restored.push(emptyParagraph());
      restored.push(children[i] as MdastNode);
    }
    node.children = restored;
  });
}

/**
 * Fixed copy of upstream's `visitEmptyLine`, and now the legacy reader.
 *
 * Upstream (`@milkdown/preset-commonmark@7.22.1`,
 * `src/plugin/remark-preserve-empty-line.ts`) deletes *every* `html` node whose
 * trimmed value is one of {@link BR_PLACEHOLDERS}, with no check on where the
 * node sits. That is right for the placeholder its paragraph serializer emitted
 * for an empty paragraph, and silent data loss for an inline `<br>` — the
 * standard way to write a multi-line GFM table cell, and a common manual line
 * break in prose. The tag is deleted with no replacement, fusing the words on
 * either side. 61 notes in the 31k-note corpus census hit this.
 *
 * This copy touches the node only where the placeholder can actually occur. In
 * block position it becomes the empty paragraph it stood for — this editor no
 * longer writes the tag, so this is how a note saved by an older build keeps
 * its gaps until its first real edit re-spells them as blank lines. As the sole
 * content of a paragraph or table cell it is deleted, which leaves exactly the
 * empty paragraph or cell it stood for. An inline `<br>` with siblings survives
 * into the document as the inert `html` atom node the schema already renders as
 * literal text.
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

    if (FLOW_PARENTS.has(parent.type)) {
      parent.children.splice(index, 1, emptyParagraph());
      return;
    }
    if (INLINE_PLACEHOLDER_PARENTS.has(parent.type) && parent.children.length === 1) {
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

/** The serializer state fields {@link blankLineJoin} reads and writes. */
export interface HasBulletLastUsed {
  bulletLastUsed?: string | undefined;
}

/**
 * The bullet of the list that preceded a run of empty paragraphs, per
 * serialization. `containerFlow` clears `state.bulletLastUsed` after every
 * non-list child — an empty paragraph included — and the `list` handler reads
 * it to pick the OTHER marker for a list that directly follows a list. Two
 * lists with an empty paragraph between them therefore both got `*`, and
 * `* a\n\n\n* b` reads back as ONE spaced list: the gap the author typed
 * merged two lists into one (two census notes). Keyed weakly on the state so a
 * serialization can never see a stale value from an earlier one.
 */
const bulletBeforeEmptyParagraphs = new WeakMap<object, string | undefined>();

/**
 * The `join` rule that writes an empty paragraph as one extra blank line.
 *
 * `mdast-util-to-markdown` joins sibling blocks with `1 + join()` newlines and
 * consults user joins before its defaults; `0` therefore means "a single
 * newline". An empty paragraph serializes to the empty string, so with the
 * default blank line on BOTH sides `a`, empty, `b` would come out as
 * `a\n\n\n\nb` — three blank lines, which read back as TWO empty paragraphs
 * and grew by one on every save. A single newline after the empty paragraph
 * makes it `a\n\n\nb`: two blank lines, one empty paragraph, fixed point.
 *
 * The one pair the blank line alone cannot separate is list, empty, list: two
 * lists with the same marker and any number of blank lines between them are
 * one list to CommonMark. remark already alternates markers for ADJACENT lists
 * (`*` then `-`, `.` then `)`), so this carries the first list's marker across
 * the empty paragraphs ({@link bulletBeforeEmptyParagraphs}) and the second
 * list alternates as if adjacent — `* a\n\n\n- b` is two lists with a gap.
 *
 * Every other pair falls through to the library's own rules (`undefined`).
 * Structurally typed for the same reason `stringifyHandlers.ts` is: the real
 * `Join`/`State` types live in `mdast-util-to-markdown`, which this package
 * must not import directly.
 */
export function blankLineJoin(
  left: { type: string; children?: readonly unknown[] },
  right?: { type: string; children?: readonly unknown[] },
  _parent?: unknown,
  state?: HasBulletLastUsed,
): 0 | undefined {
  const rightIsEmpty = right !== undefined && isEmptyParagraph(right);
  if (state && left.type === 'list' && rightIsEmpty) {
    bulletBeforeEmptyParagraphs.set(state, state.bulletLastUsed);
  }
  if (isEmptyParagraph(left)) {
    if (state && right?.type === 'list' && bulletBeforeEmptyParagraphs.has(state)) {
      state.bulletLastUsed = bulletBeforeEmptyParagraphs.get(state);
    }
    return 0;
  }
  // A real block between two lists separates them on its own.
  if (state && !rightIsEmpty) bulletBeforeEmptyParagraphs.delete(state);
  return undefined;
}

/**
 * The load half, as a remark transformer.
 *
 * The id is deliberately NOT `remark-preserve-empty-line`: `node/paragraph.ts`'s
 * `toMarkdown` looks that slice up by *name* and, when it resolves, writes the
 * `<br />` placeholder for every non-final empty paragraph. With no slice of
 * that name registered, an empty paragraph serializes as an empty paragraph,
 * which is what {@link blankLineJoin} then spells as a blank line. Registering
 * any plugin under the old name brings the tag back.
 *
 * Gaps are restored BEFORE placeholders are converted, so a legacy tag counts
 * as the block it stood for while its neighbours' gaps are measured.
 */
export const remarkBlankLineParagraphsPlugin = $remark(
  'remark-futo-blank-line-paragraphs',
  () => () => (tree: MdastNode) => {
    restoreBlankLineParagraphs(tree);
    fixEmptyLinePlaceholders(tree);
  },
);

/**
 * The save half: installs {@link blankLineJoin} into the serializer options.
 *
 * Done in the plugin's PREPARE phase (the outer function), not its run phase.
 * Milkdown's `Init` plugin reads `remarkStringifyOptionsCtx` exactly once, right
 * after the editor's `.config()` callbacks (`ConfigReady`), to build the remark
 * processor; a run-phase update racing that read on the same timer would lose.
 * Internal plugins are prepared before any `.use()`d plugin, so the slice is
 * injected by the time this runs, and a `.config()` that spreads `...options`
 * keeps the join. It lives in the preset rather than in the app's `.config()`
 * so the census harness — which builds its editor from `commonmarkWithCompat()`
 * alone — serializes exactly as the app does.
 */
export const blankLineJoinPlugin: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (options) => ({
    ...options,
    join: [...(options.join ?? []), blankLineJoin],
  }));
  return () => {};
};

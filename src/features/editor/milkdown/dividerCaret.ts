/*
 * The caret after a horizontal rule ("hr") is created — the shared repair for
 * QA-013 (the `/divider` slash item landing two lines below the cursor) and
 * QA-018 (typing `---`/`___ `/`*** ` scroll-jumping the editor).
 *
 * PRODUCT OWNER'S RULING (QA-013): inserting a divider must leave the caret in
 * a single empty paragraph immediately BELOW the rule — no leading blank
 * line, no trailing blank line beyond that one paragraph, ready to type. Both
 * the slash item and typing `---` end at the SAME state; there is only ever
 * one divider code path, not two.
 *
 * Both entry points ultimately go through `@milkdown/preset-commonmark`'s hr
 * machinery (`insertHrCommand` for the slash item, its input rule for typing),
 * and neither reliably lands there on its own:
 *
 *   - The input rule's `tr.replaceWith(...)` leaves a NodeSelection ON THE HR
 *     ITSELF whenever nothing usable already follows it (an empty doc, or the
 *     end of a paragraph after pressing Enter). A NodeSelection on a block
 *     atom is what a browser's native "scroll selection into view" reacts to
 *     — measured as QA-018's "editor scrolls up": the rule renders where the
 *     caret already was, but the selection is now the hr, not a text caret,
 *     and centering "the hr" nudges the viewport just enough to be
 *     noticeable.
 *   - `insertHrCommand` (the slash item) can leave an extra blank line before
 *     QA-010's fix, or a selection that is technically a paragraph but not
 *     necessarily the empty one immediately after the hr, depending on what
 *     was in the block the rule was typed into.
 *
 * Rather than re-derive each preset command's own internal position math (and
 * re-litigate it on every `@milkdown/kit` bump that changes exactly how far a
 * selection shifts), this plugin watches every transaction for an `hr` node
 * that did not exist a moment ago and normalizes its surroundings once, after
 * the fact, in an appended transaction — one fix shared by both entry points,
 * applied uniformly to every way an `hr` can land in the document (a future
 * third path — paste, an undo/redo edge, whatever — gets the same treatment
 * automatically, with no new call site to remember).
 *
 * Order matters for exactly one thing: `.use()`d AFTER `@milkdown/plugin-trailing`
 * in `MilkdownEditor.svelte`, so that by the time this plugin's
 * `appendTransaction` runs, a trailing empty paragraph `trailing` already
 * added is visible in `newState` and is reused rather than duplicated —
 * `EditorState.applyTransaction` resolves all plugins' `appendTransaction`s in
 * one pass, each seeing every prior plugin's follow-up already merged in.
 *
 * Deliberately does NOT call `.scrollIntoView()`: QA-018's complaint is the
 * viewport moving on its own, and the fix for a NodeSelection nudging the
 * browser's native scroll is to stop producing a NodeSelection at all, not to
 * add a second explicit scroll on top of it.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Mapping } from '@milkdown/kit/prose/transform';
import { $prose } from '@milkdown/kit/utils';

/** Every `hr` node's position in `doc` (the position right before the node). */
function hrPositions(doc: ProseNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'hr') positions.push(pos);
  });
  return positions;
}

/**
 * The one new `hr` position `transactions` introduced, or null if none — or
 * if more than one appeared, which a single keystroke or command never does,
 * so it is treated as "not this plugin's shape to fix" rather than guessed at.
 */
function newlyCreatedDivider(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
): number | null {
  if (!transactions.some((tr) => tr.docChanged)) return null;

  const mapping = new Mapping();
  for (const tr of transactions) mapping.appendMapping(tr.mapping);

  const stillThere = new Set(hrPositions(oldState.doc).map((pos) => mapping.map(pos, 1)));
  const created = hrPositions(newState.doc).filter((pos) => !stillThere.has(pos));
  return created.length === 1 ? created[0] : null;
}

/**
 * The follow-up transaction that puts the caret in a single empty paragraph
 * right after the hr at `pos` — reusing one already there (the `trailing`
 * plugin's, or the preset command's own) rather than adding a second.
 */
function normalizeAfterDivider(state: EditorState, pos: number): Transaction | null {
  const { doc, schema } = state;
  const hrNode = doc.nodeAt(pos);
  if (!hrNode || hrNode.type.name !== 'hr') return null;

  const $hr = doc.resolve(pos);
  const container = $hr.parent;
  const hrIndex = $hr.index();
  const next = container.maybeChild(hrIndex + 1);
  const afterHr = pos + hrNode.nodeSize;

  const paragraphType = schema.nodes.paragraph;
  let tr = state.tr;
  if (next && next.type === paragraphType && next.content.size === 0) {
    // Already exactly right — nothing to insert.
  } else {
    // Only insert if the container's content model actually allows a
    // paragraph here (it does for every container this schema nests an hr
    // in — doc, blockquote, list item — but a hand-off from an upstream
    // command that put the hr somewhere this app has no fixture for should
    // leave the selection alone rather than throw).
    if (!container.contentMatchAt(hrIndex + 1).matchType(paragraphType)) return null;
    tr = tr.insert(afterHr, paragraphType.create());
  }

  return tr.setSelection(TextSelection.create(tr.doc, afterHr + 1));
}

/** The Milkdown wrapper — see the header comment for placement in `.use()`. */
export const dividerCaretFix = $prose(
  () =>
    new Plugin({
      key: new PluginKey('FUTO_DIVIDER_CARET'),
      appendTransaction: (transactions, oldState, newState) => {
        const pos = newlyCreatedDivider(transactions, oldState, newState);
        if (pos === null) return null;
        return normalizeAfterDivider(newState, pos);
      },
    }),
);

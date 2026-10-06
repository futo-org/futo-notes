/*
 * What moving a block with the ⠿ handle does to the user's selection: carries
 * it along.
 *
 * The handle never SELECTS anything. It used to: @milkdown/plugin-block
 * dispatched a NodeSelection over the hovered block on mousedown on the handle,
 * ProseMirror hands a NodeSelection over a text block to the browser as a native
 * range over its text, and nothing ever gave the user's own selection back — so
 * a click, a drop back where the block started, and a drag released outside the
 * note all left the whole block painted as selected text (reported: "sometimes
 * when I use it, text or other items get selected"). The handle's drag is now
 * pointer-driven (`handleBlockDrag.ts`), which cancels that mousedown, so the
 * selection is simply never touched — until the block moves, where this puts the
 * user's selection on the move transaction: travelling with the block when it
 * was inside it.
 *
 * → tests/editor-embed-milkdown.spec.ts "USING THE ⠿ HANDLE NEVER SELECTS ANYTHING"
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Selection, TextSelection, type Transaction } from '@milkdown/kit/prose/state';

/** The user's document and selection at the moment the handle was pressed. */
export interface PressSelection {
  doc: ProseNode;
  selection: Selection;
}

/**
 * Puts the pressed selection onto `tr`, the transaction that moves the node at
 * `from..to` (in the pressed document) so it starts at `movedTo` (in `tr.doc`).
 */
export function carrySelectionThroughMove(
  tr: Transaction,
  press: PressSelection,
  moved: { from: number; to: number; movedTo: number },
): void {
  // Something else edited the note mid-drag, so the remembered positions no
  // longer describe it: just don't leave the moved block selected.
  if (press.doc !== tr.before) {
    tr.setSelection(Selection.near(tr.selection.$to, -1));
    return;
  }
  const map = (pos: number): number =>
    pos > moved.from && pos < moved.to ? moved.movedTo + (pos - moved.from) : tr.mapping.map(pos);
  const { anchor, head } = press.selection;
  const $head = tr.doc.resolve(map(head));
  tr.setSelection(
    press.selection instanceof TextSelection
      ? TextSelection.between(tr.doc.resolve(map(anchor)), $head)
      : Selection.near($head),
  );
}

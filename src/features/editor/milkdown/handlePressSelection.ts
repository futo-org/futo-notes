/*
 * What pressing the ⠿ handle does to the user's selection: nothing.
 *
 * @milkdown/plugin-block dispatches a NodeSelection over the hovered block on
 * mousedown on the handle. The drag needs it (it is what `view.dragging`
 * carries, and what blockDropIndicator.ts reads to know which block is
 * moving), but the plugin never gives the previous selection back.
 * ProseMirror hands a NodeSelection over a text block to the browser as a
 * native range over its text, so a click that did not drag, a drop back where
 * the block started, and a drag released outside the note all left the whole
 * block painted as selected text. Reported: "sometimes when I use it, text or
 * other items get selected".
 *
 * So the selection the user had is remembered on the press, BEFORE the plugin
 * replaces it, and handed back once the press is over:
 *
 *  - the block moved: carried through the move transaction, travelling with
 *    the block when it was inside it (`carryPressSelectionThroughMove`);
 *  - nothing changed: restored exactly (`settleSelectionAfterHandlePress`);
 *  - the document changed some other way, e.g. ProseMirror's own drop:
 *    collapsed, so nothing is left selected.
 *
 * → tests/editor-embed-milkdown.spec.ts "USING THE ⠿ HANDLE NEVER SELECTS ANYTHING"
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Selection, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

interface Press {
  doc: ProseNode;
  selection: Selection;
  /** The move transaction already placed the selection. */
  carried: boolean;
}

const presses = new WeakMap<ProseView, Press>();

/** On mousedown on the handle, before plugin-block's own listener runs. */
export function rememberSelectionBeforeHandlePress(view: ProseView): void {
  presses.set(view, { doc: view.state.doc, selection: view.state.selection, carried: false });
}

/**
 * Puts the remembered selection onto `tr`, the transaction that moves the node
 * at `from..to` (in the pressed document) so it starts at `movedTo` (in
 * `tr.doc`). Does nothing when no handle press is outstanding, which is every
 * long-press drag.
 */
export function carryPressSelectionThroughMove(
  view: ProseView,
  tr: Transaction,
  moved: { from: number; to: number; movedTo: number },
): void {
  const press = presses.get(view);
  if (!press || press.carried) return;
  press.carried = true;
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

/**
 * Once the press is over — a click, or a drag that has ended — gives back
 * whatever the move above did not already, and refocuses the editor. Safe to
 * call more than once.
 *
 * THE FOCUS IS NOT OPTIONAL. The handle is a plain div, so the press's default
 * action blurs the editor straight after plugin-block focused it, and a
 * ProseMirror view without focus does not write its selection to the DOM: the
 * native range over the pressed block stays exactly where it is, painted,
 * whatever the state's selection says. Focusing writes it.
 */
export function settleSelectionAfterHandlePress(view: ProseView): void {
  const press = presses.get(view);
  if (!press) return;
  presses.delete(view);
  const { state } = view;
  if (press.carried) {
    // Placed by the move.
  } else if (state.doc === press.doc) {
    if (!state.selection.eq(press.selection)) {
      view.dispatch(state.tr.setSelection(press.selection));
    }
  } else if (!state.selection.empty) {
    view.dispatch(state.tr.setSelection(Selection.near(state.selection.$to, -1)));
  }
  view.focus();
}

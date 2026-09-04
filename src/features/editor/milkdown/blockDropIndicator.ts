/*
 * The desktop ⠿ gutter handle's drop indicator, and the drop it commits.
 *
 * WHY THIS EXISTS INSTEAD OF `@milkdown/kit/plugin/cursor`'s. That plugin's
 * indicator half wraps `prosemirror-drop-indicator`, whose `getTargetsByView`
 * pushes TWO targets for every block node — `[pos, its top edge]` and
 * `[pos + nodeSize, its bottom edge]` — recursing into every non-textblock
 * container, and then picks whichever LINE the pointer is nearest. Block A's
 * bottom edge and block B's top edge are the same document position drawn at
 * two different y values, so every gap between top-level siblings offered two
 * visually distinct places to drop that meant exactly the same thing, and the
 * container recursion added "inside" slots on top. That is the desktop half of
 * the same complaint the long-press path had (MR !276); the mobile half was
 * fixed by collapsing `TopLevelTarget` onto `pos` in `blockDragGeometry.ts`.
 *
 * `createDropIndicatorPlugin` cannot be configured out of it: its only hooks
 * are `onShow`/`onHide`/`onDrag`, and `onDrag` is a per-target PREDICATE — it
 * can reject a target but cannot change the line a target is drawn at, so both
 * of the gap's two entries survive any filter and still resolve to two y
 * values. So the indicator half of `cursor` is replaced here rather than
 * configured, and `gapCursorPlugin` is still mounted from `cursor` directly.
 *
 * What this draws instead: ONE line per top-level gap, at the geometry
 * `blockDragGeometry.ts` resolves — the SAME resolver the native shells'
 * long-press drag uses, so the two paths cannot disagree about where a block
 * may land or where the line sits. The commit goes through `blockMove.ts`,
 * which is also shared, so the position that was indicated is the position that
 * is committed.
 *
 * SCOPE: this claims the ⠿ handle's own drag and nothing else. A drag whose
 * selection is not a single top-level node (an OS file drop carrying an image,
 * a text selection dragged inside the note) draws no line and is refused by
 * `handleDrop`, so the component's file-drop handler and ProseMirror's own
 * default drop behaviour both still run exactly as before.
 */
import { $prose } from '@milkdown/kit/utils';
import { NodeSelection, Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { targetAtPointerY, type TopLevelTarget } from './blockDragGeometry';
import { moveTopLevelBlock } from './blockMove';

/** Kept from `@milkdown/plugin-cursor`'s own contract so the component's
 * existing `:global(.milkdown-drop-indicator)` paint still applies. */
const INDICATOR_CLASS = 'milkdown-drop-indicator';
const VISIBLE_CLASS = 'milkdown-drop-indicator--visible';

export const blockDropIndicatorKey = new PluginKey('FUTO_BLOCK_DROP_INDICATOR');

/**
 * The ⠿ handle's drag, or null for any other drag.
 *
 * @milkdown/plugin-block dispatches a `NodeSelection` over the whole top-level
 * block at mousedown and sets `view.dragging` at dragstart, so both are already
 * true by the first `dragover`. `move` is passed straight through from
 * ProseMirror on the drop path; on the `dragover` path it is read off
 * `view.dragging`, which prosemirror-view only clears in the `finally` AFTER
 * `handleDrop` has run.
 */
function blockDragSelection(view: ProseView, move: boolean): NodeSelection | null {
  if (!move) return null;
  const selection = view.state.selection;
  if (!(selection instanceof NodeSelection)) return null;
  // Only TOP-LEVEL blocks reorder, on this gesture and on the long press.
  if (view.state.doc.resolve(selection.from).depth !== 0) return null;
  return selection;
}

/** Owns the indicator element and the drag listeners for one editor view. */
class BlockDropIndicatorView {
  private readonly view: ProseView;
  private readonly doc: Document;
  private el: HTMLElement | null = null;

  constructor(view: ProseView) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
    // Bound on view.dom rather than the document: this path only ever runs on
    // desktop, where the drag is the browser's own HTML5 drag and every event
    // that matters is dispatched at the editor.
    //
    // `dragenter` IS NOT OPTIONAL HERE, and listening only for `dragover` is
    // the bug it looks like a redundancy. When a drag moves onto a different
    // element the engine fires `dragleave` on the old target and `dragenter` on
    // the new one, and only issues `dragover` for a subsequent event over the
    // SAME target. So a `dragover`-only indicator does not move when the
    // pointer crosses from one block to the next — precisely the moment the
    // line has to move — and only catches up on the next event that happens to
    // stay put. Measured in Chromium: a pointer stepped through three blocks
    // produced three `dragleave`s and a single `dragover`, on the last one.
    view.dom.addEventListener('dragenter', this.onDragPoint);
    view.dom.addEventListener('dragover', this.onDragPoint);
    view.dom.addEventListener('dragleave', this.onDragLeave);
    view.dom.addEventListener('dragend', this.hide);
    view.dom.addEventListener('drop', this.hide);
  }

  destroy(): void {
    const dom = this.view.dom;
    dom.removeEventListener('dragenter', this.onDragPoint);
    dom.removeEventListener('dragover', this.onDragPoint);
    dom.removeEventListener('dragleave', this.onDragLeave);
    dom.removeEventListener('dragend', this.hide);
    dom.removeEventListener('drop', this.hide);
    this.el?.remove();
    this.el = null;
  }

  /** `dragenter` and `dragover` carry the same pointer coordinates and are
   * handled identically; between them they cover every position the drag
   * reports. */
  private onDragPoint = (event: DragEvent): void => {
    if (!blockDragSelection(this.view, this.view.dragging?.move ?? false)) {
      this.hide();
      return;
    }
    const target = targetAtPointerY(this.view, event.clientY);
    if (!target) {
      this.hide();
      return;
    }
    this.show(target);
  };

  /**
   * A `dragleave` fires for EVERY crossing between the editor's own child
   * elements — one per block the pointer passes — so hiding on it outright
   * makes the line strobe, and hiding on a short timer makes it a race the
   * following `dragenter` has to win. Ask where the pointer actually is
   * instead: only a pointer that has genuinely left the editor box clears the
   * line, which is a synchronous answer with no timer to lose.
   */
  private onDragLeave = (event: DragEvent): void => {
    const rect = this.view.dom.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inside) this.hide();
  };

  private ensureEl(): HTMLElement {
    if (!this.el) {
      const el = this.doc.createElement('div');
      el.className = INDICATOR_CLASS;
      el.setAttribute('aria-hidden', 'true');
      // OUTSIDE the contenteditable — WebKit's DOMObserver heals foreign nodes
      // inserted inside it back out again (see mobileBlockDnd.ts).
      (this.view.dom.parentNode ?? this.doc.body).appendChild(el);
      this.el = el;
    }
    return this.el;
  }

  /** Viewport coordinates, so the element is `position: fixed` and needs no
   * scroll compensation — the same contract the long-press path's indicator
   * uses. */
  private show(target: TopLevelTarget): void {
    const el = this.ensureEl();
    el.style.left = `${target.indicator.left}px`;
    el.style.width = `${target.indicator.width}px`;
    el.style.top = `${target.indicator.top}px`;
    el.classList.add(VISIBLE_CLASS);
  }

  private hide = (): void => {
    this.el?.classList.remove(VISIBLE_CLASS);
  };
}

/**
 * Desktop only, mounted alongside @milkdown/plugin-block (MilkdownEditor.svelte
 * mounts the long-press plugin instead on a native shell, and the two never
 * coexist for one editor instance).
 */
export const blockDropIndicator = $prose(
  () =>
    new Plugin({
      key: blockDropIndicatorKey,
      view: (view) => new BlockDropIndicatorView(view),
      props: {
        /**
         * The drop lands where the line was drawn. Both come from
         * `targetAtPointerY`, so "the indicated position" and "the committed
         * position" are the same expression rather than two that agree by
         * inspection.
         *
         * Returning true on a refused move is deliberate: a drop back at the
         * source is a no-op that must stay a no-op, and letting ProseMirror's
         * default drop run instead would re-fit the slice and could unwrap the
         * node (see blockMove.ts).
         */
        handleDrop: (view, event, _slice, move) => {
          const selection = blockDragSelection(view, move);
          if (!selection) return false;
          const target = targetAtPointerY(view, (event as DragEvent).clientY);
          if (!target) return false;
          event.preventDefault();
          moveTopLevelBlock(view, { from: selection.from, to: selection.to }, target.pos);
          return true;
        },
      },
    }),
);

/*
 * The desktop ⠿ handle's drag: press the handle, move the pointer, release.
 *
 * It is POINTER-DRIVEN, not the browser's HTML5 drag. `@milkdown/plugin-block`'s
 * `BlockProvider` still renders, positions and hover-tracks the handle, but its
 * own drag (`draggable = true` plus `dataTransfer.setDragImage(block, 0, 0)`)
 * hands the picture to the OS, and on Linux (WebKitGTK) at a fractional display
 * scale that image came out oversized with nothing the page could do about it
 * (two attempted fixes failed). So the page draws the lifted block itself — the
 * same ghost card, dimmed source, drop line, edge auto-scroll and commit the
 * native shells' long press uses after its lift (`blockDragSession.ts`) — and
 * no OS drag image exists, on any platform. A drag session never mutates the DOM
 * inside `dragstart` either, which WKWebView treats as a cancel.
 *
 * NEUTRALISING THE PLUGIN'S OWN DRAG. `BlockProvider` attaches its
 * mousedown/mouseup/dragstart/dragend listeners to the handle one animation
 * frame AFTER `update()`, so the listeners added here, synchronously at mount,
 * run first on the same element and cut the event off with
 * `stopImmediatePropagation()` before the plugin sees it:
 *
 *  - `mousedown` is cancelled, which keeps the plugin from dispatching its
 *    NodeSelection over the block (see `handlePressSelection.ts` for what that
 *    used to do to the user's selection) and keeps the engine from moving
 *    focus, starting a text selection or beginning a drag;
 *  - `dragstart` is cancelled and `draggable` is switched off at press, so no
 *    HTML5 drag can begin even if the engine would have started one anyway.
 *
 * The gesture itself starts on `pointerdown` (a mouse's primary button only) and
 * leaves that event alone: cancelling `pointerdown` would suppress the
 * compatibility `mousedown` above, and it is THAT event's cancellation which
 * reliably stops the engine's default handling.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { Selection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { BlockDragSession } from './blockDragSession';
import { carrySelectionThroughMove } from './handlePressSelection';
import { handleSourceFor, type ActiveHandleBlock, type HandleSource } from './handleSource';

/** Pointer travel before a press on the handle turns into a lift. A click that
 * jitters a pixel or two must still be a click. */
const LIFT_DISTANCE_PX = 4;

/** Set on the root element for the length of a lift: the HTML5 drag this
 * replaced drew the OS's own drag cursor, and without one the pointer would be
 * an I-beam over the text it travels across. */
const DRAGGING_CLASS = 'futo-block-dragging';

export interface HandleBlockDragHost {
  /** The element BlockProvider renders as the handle. */
  handleEl: HTMLElement;
  view(): ProseView | null;
  /** What `BlockProvider.active` says the handle stands for. */
  active(): ActiveHandleBlock | null;
  /** Hides the handle so it does not sit stale while its block is in the air. */
  hideHandle(): void;
}

interface Press {
  pointerId: number;
  startX: number;
  startY: number;
  source: HandleSource;
  /** Cloned at press, before the dim decoration renders (same reason as the
   * long press's clone). */
  clone: HTMLElement;
  user: { doc: ProseNode; selection: Selection };
  view: ProseView;
  lifted: boolean;
}

/** Wires the press-move-release gesture onto `host.handleEl`; returns its teardown. */
export function mountHandleBlockDrag(host: HandleBlockDragHost): { destroy(): void } {
  const { handleEl } = host;
  const doc = handleEl.ownerDocument;
  const sessions = new WeakMap<ProseView, BlockDragSession>();
  let press: Press | null = null;

  function sessionFor(view: ProseView): BlockDragSession {
    let session = sessions.get(view);
    if (!session) {
      session = new BlockDragSession(view);
      sessions.set(view, session);
    }
    return session;
  }

  function addGestureListeners(): void {
    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerup', onPointerUp, true);
    doc.addEventListener('pointercancel', onPointerCancel, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.defaultView?.addEventListener('blur', onWindowBlur);
  }

  function removeGestureListeners(): void {
    doc.removeEventListener('pointermove', onPointerMove, true);
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('pointercancel', onPointerCancel, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.defaultView?.removeEventListener('blur', onWindowBlur);
  }

  /** The single exit from pressed/lifted back to idle. */
  function endPress(): Press | null {
    const ended = press;
    press = null;
    removeGestureListeners();
    doc.documentElement.classList.remove(DRAGGING_CLASS);
    return ended;
  }

  function finish(clientY: number, commit: boolean): void {
    const ended = endPress();
    if (!ended?.lifted) return; // a click: nothing was changed, nothing to undo
    const { user, view } = ended;
    sessionFor(view).finish(clientY, commit, (tr, movedTo, range) =>
      carrySelectionThroughMove(tr, user, { from: range.from, to: range.to, movedTo }),
    );
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
    if (press) return;
    const view = host.view();
    const active = host.active();
    if (!view || !active) return;
    const source = handleSourceFor(view, active, event.clientY);
    if (!source) return;
    // Belt and braces with the cancelled `dragstart` below.
    handleEl.draggable = false;
    press = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      source,
      clone: source.dom.cloneNode(true) as HTMLElement,
      user: { doc: view.state.doc, selection: view.state.selection },
      view,
      lifted: false,
    };
    addGestureListeners();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!press || event.pointerId !== press.pointerId) return;
    if (!press.lifted) {
      const distance = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
      if (distance < LIFT_DISTANCE_PX) return;
      press.lifted = true;
      host.hideHandle();
      doc.documentElement.classList.add(DRAGGING_CLASS);
      const { from, to, dom } = press.source;
      sessionFor(press.view).start(
        { from, to, dom, clone: press.clone },
        event.clientX,
        event.clientY,
      );
    }
    sessionFor(press.view).move(event.clientX, event.clientY);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!press || event.pointerId !== press.pointerId) return;
    finish(event.clientY, true);
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (!press || event.pointerId !== press.pointerId) return;
    finish(event.clientY, false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!press || event.key !== 'Escape') return;
    // Only a lift owns the key: Escape on a bare press has nothing to abort and
    // must still reach whatever else listens for it.
    if (press.lifted) {
      event.preventDefault();
      event.stopPropagation();
    }
    finish(0, false);
  };

  const onWindowBlur = (): void => {
    if (press) finish(0, false);
  };

  /** Cancels the press's mouse events so the plugin's mousedown never runs and
   * the engine takes no default action (focus change, text selection, drag). */
  const swallowMouseDown = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const swallow = (event: Event): void => {
    event.stopImmediatePropagation();
  };

  const swallowDragStart = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  handleEl.addEventListener('pointerdown', onPointerDown);
  handleEl.addEventListener('mousedown', swallowMouseDown);
  handleEl.addEventListener('mouseup', swallow);
  handleEl.addEventListener('dragstart', swallowDragStart);
  handleEl.addEventListener('dragend', swallow);

  return {
    destroy(): void {
      const ended = endPress();
      // The view may be going away with it: tear the visuals down without a
      // transaction.
      if (ended?.lifted) sessions.get(ended.view)?.destroy();
      handleEl.removeEventListener('pointerdown', onPointerDown);
      handleEl.removeEventListener('mousedown', swallowMouseDown);
      handleEl.removeEventListener('mouseup', swallow);
      handleEl.removeEventListener('dragstart', swallowDragStart);
      handleEl.removeEventListener('dragend', swallow);
    },
  };
}

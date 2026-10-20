import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { topLevelBlockAt } from './blockDragGeometry';
import { BlockDragSession } from './blockDragSession';
import {
  ARMED_CLASS,
  HIDE_SELECTION_CLASS,
  needsSelectionNet,
  type MobileBlockDndOptions,
  type PressedBlock,
} from './mobileBlockDndConfig';
import { MobileBlockDndGuards } from './mobileBlockDndGuards';

/** The press-to-drop state machine: arming on pointerdown, the lift timer, the
 * document listeners that follow the finger, and the release. */
export abstract class MobileBlockDndGesture extends MobileBlockDndGuards {
  protected startX = 0;
  protected startY = 0;
  protected lastY = 0;
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected dragging = false;
  /** The last pointer position this frame, waiting for `moveFrame` to draw it. */
  protected pendingMove: { x: number; y: number } | null = null;
  protected moveFrame: number | null = null;
  protected pressed: PressedBlock | null = null;
  /** True once the lift timer has fired for this press, whether or not it
   * actually lifted anything (an empty paragraph arms the timer but never
   * lifts). Distinguishes an ordinary short tap — which must still be free to
   * focus and place a caret on release — from a genuine hold, which must not,
   * however it resolves (see `guardFocusBriefly`). */
  protected heldPastThreshold = false;

  /** The lifted half of the gesture: ghost, indicator, auto-scroll, commit. */
  protected readonly session: BlockDragSession;

  protected constructor(view: ProseView, options: MobileBlockDndOptions) {
    super(view, options);
    this.session = new BlockDragSession(view, {
      onBoundaryChange: () => this.options.onHaptic('move'),
    });
  }

  /* ---- listener wiring -------------------------------------------------- *
   * Everything past pointerdown is bound to the DOCUMENT in the capture
   * phase (see the module doc): the pressed block's DOM node can be detached
   * by the decoration re-render, and the finger can leave the editor box —
   * both of which silently starve listeners bound to `view.dom`. */
  protected addGestureListeners(): void {
    const doc = this.doc;
    doc.addEventListener('pointermove', this.onPointerMove, true);
    doc.addEventListener('pointerup', this.onPointerUp, true);
    doc.addEventListener('pointercancel', this.onPointerCancel, true);
    // Non-passive: this is the listener that actually stops WKWebView's own
    // scroll/selection handling once dragging.
    doc.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false });
    doc.addEventListener('touchend', this.onTouchEnd, true);
    doc.addEventListener('touchcancel', this.onTouchEnd, true);
    doc.addEventListener('selectstart', this.onSelectStart, true);
    doc.addEventListener('contextmenu', this.onContextMenu, true);
    doc.addEventListener('selectionchange', this.onSelectionChange);
    // Capture phase, ahead of `view.dom`'s own focus listener — see the module
    // doc's "a block press must never focus the editor". Focus events don't
    // bubble, but they DO run a capture phase, so this fires before the
    // editable's own listener ever sees the event.
    doc.addEventListener('focus', this.onFocusCapture, true);
  }

  protected removeGestureListeners(): void {
    const doc = this.doc;
    doc.removeEventListener('pointermove', this.onPointerMove, true);
    doc.removeEventListener('pointerup', this.onPointerUp, true);
    doc.removeEventListener('pointercancel', this.onPointerCancel, true);
    doc.removeEventListener('touchmove', this.onTouchMove, true);
    doc.removeEventListener('touchend', this.onTouchEnd, true);
    doc.removeEventListener('touchcancel', this.onTouchEnd, true);
    doc.removeEventListener('selectstart', this.onSelectStart, true);
    doc.removeEventListener('contextmenu', this.onContextMenu, true);
    doc.removeEventListener('selectionchange', this.onSelectionChange);
    doc.removeEventListener('focus', this.onFocusCapture, true);
  }

  protected cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The single exit from armed/dragging back to idle: drops the gesture
   * listeners, the long-press timer, and the selection suppression. Anything
   * that abandons a gesture MUST go through here, or the editor is left
   * unselectable. */
  protected disarm(): void {
    this.cancelTimer();
    this.cancelMoveFrame();
    this.removeGestureListeners();
    const wasArmed = this.pointerId !== null;
    this.pointerId = null;
    this.pressed = null;
    const wasDragging = this.dragging;
    this.dragging = false;
    this.heldPastThreshold = false;
    this.view.dom.classList.remove(ARMED_CLASS, HIDE_SELECTION_CLASS);
    // Paired with the lift's / the arm's `true`, from the ONE exit every
    // abandoned gesture goes through — a shell left suspended would swallow
    // text selection for the rest of the session. Drag first, then press, so
    // the shell only ever steps DOWN a level.
    if (wasDragging) this.options.onDragActive(false);
    if (wasArmed) this.options.onPressActive(false);
  }

  /* ---- gesture ----------------------------------------------------------- */

  protected onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (this.pointerId !== null) return; // a second simultaneous touch
    // A new press owns focus arbitration from here (its own `onFocusCapture`);
    // the previous release's guard must not outlive it and swallow a tap's focus.
    this.dropFocusGuard();
    // FOCUS ARBITRATES DRAG VS. SELECTION (module doc): a press that starts
    // with the editor already focused is text selection/caret placement and
    // this plugin must not touch it AT ALL — arming here, even briefly, would
    // suppress selection rendering (ARMED_CLASS) and race the lift timer
    // against normal typing/selecting. Checked before anything else below is
    // touched, so a focused press leaves pointerId null and every listener,
    // decoration, and timer this view owns untouched.
    if (this.view.hasFocus()) return;
    const block = topLevelBlockAt(this.view, event.clientX, event.clientY);
    if (!block) return;
    // An empty paragraph arms like any other block (below) but is never
    // liftable — see the module doc's "an empty paragraph cannot be lifted".
    const liftable = !(block.node.isTextblock && block.node.content.size === 0);
    this.pointerId = event.pointerId;
    // Always false here — the gate above already refused a focused start.
    // Kept (not inlined to `false`) as the named invariant the module doc's
    // "focus arbitrates" point describes: `onFocusCapture`/`finish()` still
    // read it, and this is what makes that reading trivially safe.
    this.pressWasFocused = this.view.hasFocus();
    // FIRST, before any of the page-side work below: this is a message to the
    // shell and it has a WebContent->UI hop to make, and everything it buys is
    // bought by arriving before WKWebView's own long press does (module doc).
    this.options.onPressActive(true);
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.lastY = event.clientY;
    this.dragging = false;
    // Clone NOW, before the lift's decoration dims the live block (a clone
    // taken afterwards inherits the 35% opacity) and before that same
    // re-render can replace the node's DOM out from under us.
    this.pressed = {
      pos: block.pos,
      size: block.node.nodeSize,
      dom: block.dom,
      clone: block.dom.cloneNode(true) as HTMLElement,
      liftable,
    };
    // ARM the suppression here, not at lift: iOS's selection long-press is
    // already running by the time our 340ms timer fires.
    this.view.dom.classList.add(ARMED_CLASS);
    if (needsSelectionNet()) this.view.dom.classList.add(HIDE_SELECTION_CLASS);
    this.addGestureListeners();
    // A hold that STARTS on top of an existing selection produces no
    // `selectionchange`, so the watcher below would never see it.
    this.collapseSelection();
    // The timer always runs, liftable or not: an unliftable press (an empty
    // paragraph) still needs `heldPastThreshold` set for the focus guard
    // below, and `beginLift` itself refuses to lift when `!liftable` — no
    // ghost, no haptic, no `blockDrag` message.
    const { clientX, clientY } = event;
    this.timer = setTimeout(() => this.beginLift(clientX, clientY), this.options.longPressMs);
  };

  protected onPointerMove = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.lastY = event.clientY;

    if (!this.dragging) {
      const dx = event.clientX - this.startX;
      const dy = event.clientY - this.startY;
      if (Math.hypot(dx, dy) >= this.options.moveCancelPx) {
        // Real movement before the timer fired — an ordinary scroll, not a
        // drag. We never called preventDefault, so native scrolling already
        // owns this gesture; stop waiting to lift and restore normal
        // selection behavior immediately.
        this.disarm();
      }
      return;
    }

    this.queueMove(event.clientX, event.clientY);
  };

  /** Draws the lifted block at the finger ONCE PER FRAME, at the last position
   * the finger reported. A touch digitizer samples faster than the display
   * refreshes and WKWebView delivers every sample (Chromium already aligns
   * them to frames); each session move reads geometry and redraws the
   * preview, so drawing every sample is the same frame painted several times
   * over. The release reads its own position (`finish`), so a frame cut short
   * by it is simply dropped. */
  protected queueMove(x: number, y: number): void {
    this.pendingMove = { x, y };
    if (this.moveFrame !== null) return;
    const win = this.doc.defaultView ?? window;
    this.moveFrame = win.requestAnimationFrame(() => {
      this.moveFrame = null;
      const at = this.pendingMove;
      this.pendingMove = null;
      if (!this.dragging || !at) return;
      this.session.move(at.x, at.y);
    });
  }

  protected cancelMoveFrame(): void {
    if (this.moveFrame !== null) {
      (this.doc.defaultView ?? window).cancelAnimationFrame(this.moveFrame);
      this.moveFrame = null;
    }
    this.pendingMove = null;
  }

  protected onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.finish(event.clientY, true);
  };

  protected onPointerCancel = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.finish(event.clientY, false);
  };

  /** touchmove is what actually needs suppressing on WKWebView; pointermove
   * alone does not reliably stop the native scroll/selection gesture. Bound at
   * ARM time on the document, so the FIRST post-lift move is covered even if
   * the pressed block's DOM was replaced by the decoration render. */
  protected onTouchMove = (event: TouchEvent): void => {
    if (this.dragging) event.preventDefault();
  };

  /** Safety net only. The Pointer Events spec dispatches `pointerup` before
   * `touchend`, so the pointer handlers normally win and this finds nothing
   * left to do; it exists so a dropped `pointerup` cannot strand the editor in
   * the armed state (no selection, no caret) forever. */
  protected onTouchEnd = (event: TouchEvent): void => {
    if (this.pointerId === null || event.touches.length > 0) return;
    const commit = event.type === 'touchend';
    setTimeout(() => {
      if (this.pointerId === null) return;
      this.finish(this.lastY, commit);
    }, 0);
  };

  protected beginLift(clientX: number, clientY: number): void {
    this.timer = null;
    if (this.pointerId === null || !this.pressed) return;
    // The press has now held long enough to be a genuine hold rather than an
    // ordinary tap, whether or not it actually lifts below — the focus guard
    // in `finish()` reads this. */
    this.heldPastThreshold = true;
    // An empty paragraph arms and stands the platform's own gestures down
    // like any other press, but is never liftable (module doc's "an empty
    // paragraph cannot be lifted"): no ghost, no haptic, no `blockDrag`.
    if (!this.pressed.liftable) return;
    // Nor while the last drop is still landing (`BlockDragSession.landingDrop`).
    if (this.session.landingDrop) return;

    // Belt and braces: the shell has been holding WKWebView's delayed text
    // interaction down since pointerdown (`onPressActive`), so there should be
    // no range to collapse — but a host without a `blockPress` case leaves this
    // as the page's only defence.
    this.collapseSelection();

    const pressed = this.pressed;
    this.session.start(
      { from: pressed.pos, to: pressed.pos + pressed.size, dom: pressed.dom, clone: pressed.clone },
      clientX,
      clientY,
    );
    this.dragging = true;
    // Escalates the shell from the press-level suspension it has held since
    // pointerdown to the full one (the whole text-interaction stack, plus the
    // `isTextInteractionEnabled` preference) — safe only now that the gesture
    // is known to be a drag. Before the haptic, so the escalation is in flight
    // while the finger is still being told it worked.
    this.options.onDragActive(true);
    this.options.onHaptic('lift');
  }

  /** Shared tail for release (`commit=true`) and cancel (`commit=false`, which
   * WILL happen — incoming calls, system gestures — and must clean up exactly
   * like a normal release with no transaction). */
  protected finish(clientY: number, commit: boolean): void {
    const wasDragging = this.dragging;
    // Captured before `disarm()` resets both: a press that reached the hold
    // threshold — lifted or not (an empty paragraph never lifts) — while
    // starting unfocused must not end up focused either, however it resolves
    // (module doc's "a block press must never focus the editor"). A plain
    // short tap is deliberately excluded: that is ordinary tap-to-place-caret,
    // which `disarm()`'s own listener teardown already leaves alone.
    const guardFocusOnRelease = !this.pressWasFocused && this.heldPastThreshold;
    this.disarm();
    if (guardFocusOnRelease) this.guardFocusBriefly(!wasDragging);

    if (!wasDragging) return; // a plain tap / short hold: nothing to undo

    // A drop that commits nothing is silent: no transaction, no history entry,
    // no 'change', and no drop haptic.
    if (this.session.finish(clientY, commit)) this.options.onHaptic('drop');
  }
}

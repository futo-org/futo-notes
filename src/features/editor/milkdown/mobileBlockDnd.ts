/*
 * Notion-style mobile block drag-and-drop — the native shells' long-press path.
 *
 * The desktop browser (@milkdown/plugin-block) drives drag off a dedicated ⠿ gutter
 * handle (BlockProvider). On a phone the product ask is different: there is no
 * handle at all — THE BLOCK ITSELF is the handle. Touch-and-hold a block
 * (~330-350ms; any real movement before the timer cancels it, so ordinary
 * scrolling is untouched) lifts it (a card-like ghost pops up under the finger
 * + a haptic), dragging floats that ghost with a drop-indicator line at the
 * resolved top-level boundary, and release commits the move as ONE transaction
 * (a second haptic) or, dropped back at the source, is a true no-op: no
 * transaction, no history entry, no bridge 'change' message.
 *
 * Hard-won constraints, each of which cost a device debugging session. They
 * were all measured on iOS/WKWebView, which is the harder engine here: WebKit
 * commits to its own text interaction at touch-down and hands the page no way
 * to cancel it. Where Chromium's Android WebView differs is called out inline.
 *
 *  - `-webkit-user-select: none` IS NOT A SELECTION SUPPRESSION MECHANISM HERE.
 *    The first version of this plugin set it on the ProseMirror root at lift
 *    and believed the race was won. It was not: `src/styles/base.css` already
 *    sets `-webkit-user-select: none` (and `-webkit-touch-callout: none`) on
 *    `body`, so the editor's computed value is ALREADY `none` before this
 *    plugin touches anything — and text is still selectable, because engines
 *    ignore `user-select` inside a contenteditable subtree. Setting a property
 *    to the value it already has was the whole of the old defence, which is
 *    exactly why the user saw highlighting "sometimes" and could not
 *    reproduce it: nothing was ever suppressing anything.
 *  - SELECTION SUPPRESSION IS A WHOLE-GESTURE JOB, NOT A LIFT-TIME ONE.
 *    iOS's own text-selection long-press is already in flight from the instant
 *    the finger lands, so suppression runs from ARM (pointerdown on a block)
 *    to resolution, and is defence-in-depth because no single lever is
 *    reliable in WKWebView:
 *      1. Any live range is collapsed AT ARM — a hold that starts on top of an
 *         existing selection would otherwise simply keep it, with no
 *         `selectionchange` to react to.
 *      2. A transparent `::selection` while armed (iOS WebKit ONLY —
 *         HIDE_SELECTION_CLASS), so a range WebKit manages to establish
 *         anyway is never *rendered*. Not applied under Chromium: the rule
 *         restyles the whole note on every toggle (see its comment) and the
 *         synchronous `selectstart` cancel in 3 already stops the selection.
 *      3. `selectstart` and `contextmenu` cancelled while armed (the callout
 *         menu rides the same gesture).
 *      4. `selectionchange` watched while armed: any range that appears is
 *         re-collapsed immediately, in both the ProseMirror state and the DOM.
 *      5. Non-passive `touchmove` `preventDefault()` for EVERY move once
 *         dragging — see the listener-target note below for why that used to
 *         miss moves. This is what stops WebKit extending a selection from the
 *         initial touch point as the finger travels.
 *    The armed class still declares `-webkit-user-select`/`-webkit-touch-callout`
 *    for the engines that DO honor it; it is simply not load-bearing. It is
 *    removed on `pointerup`, which the Pointer Events spec dispatches BEFORE
 *    `touchend` and so before WebKit's tap gesture resolves a caret, leaving
 *    tap-to-place-caret untouched.
 *  - THE MAGNIFIER LOUPE IS NOT THE PAGE'S TO CANCEL. WKWebView's own
 *    long-press text interaction paints the OS magnifier plus a caret it drags
 *    along, right on top of the block being moved. It is a UIKit gesture
 *    recogniser, and WebKit commits to it at TOUCH-DOWN, so nothing applied
 *    later reaches it: `pointer-events: none` and `touch-action: pan-x pan-y`
 *    on the editable subtree were both measured on a simulator with the loupe
 *    still appearing, on top of the levers already listed above. The shell that
 *    owns the WebView suspends its text interaction instead. Do not re-litigate
 *    this in CSS.
 *  - AND THE SHELL MUST BE ASKED AT TOUCH-DOWN, NOT AT LIFT. `onDragActive`
 *    (bridge.ts BlockDragMessage) can only fire once the 340ms timer has
 *    fired, which made the shell's protection conditional on this plugin
 *    winning a race it does not control — and when a press produced no lift for
 *    ANY reason (a timer starved by a busy main thread, a pointer stream WebKit
 *    withheld, a press that never armed) the user got the OS magnifier and a
 *    word selection instead of a ghost, with the suspension the module doc
 *    claimed never even requested. Measured on the pool simulator, iOS 26.5:
 *    WKWebView's text interaction fires at 655±2ms with the editable focused
 *    (loupe + caret placement) and ~700ms unfocused (word selection) — it does
 *    NOT have a shorter focused threshold, and it never `pointercancel`s the
 *    page. So the fix is not a smaller number, it is not depending on the
 *    number at all: `onPressActive` (bridge.ts BlockPressMessage) fires at
 *    pointerdown and the shell stands the DELAYED recognisers down there,
 *    leaving the tap recognisers (caret placement, double-tap word select)
 *    alive. `onDragActive` still escalates to the full suspension at the lift.
 *    Both are released from the same single `disarm()`.
 *  - LISTEN ON THE DOCUMENT, NOT ON `view.dom`. Applying the source-dim
 *    decoration re-renders the pressed block, which can detach the very DOM
 *    node the touch sequence targets; a `touchmove` listener bound to
 *    `view.dom` then stops seeing that touch (the event no longer bubbles
 *    through a detached target), the `preventDefault()` never runs, and
 *    WKWebView resumes its own scroll/selection handling mid-drag. Everything
 *    after `pointerdown` is bound to the ownerDocument in the capture phase,
 *    which also fixes the ghost freezing when the finger leaves the editor
 *    box.
 *  - WebKit's DOMObserver reverts a plain `classList.add` on a node INSIDE the
 *    contenteditable (it "heals" the DOM back to what ProseMirror's own render
 *    last produced), so the lifted block is dimmed via a ProseMirror
 *    DECORATION, never a direct class mutation. `view.dom` itself is exempt
 *    (prosemirror-view ignores attribute mutations on its own docView node),
 *    which is why the armed/dragging classes above may live there.
 *  - THE DROP MUST NOT TRUST POSITIONS CAPTURED AT POINTERDOWN. The source
 *    range is re-read at drop time from the decoration, which ProseMirror maps
 *    through every intervening transaction; everything that can still go wrong
 *    from there (a range that is no longer one top-level node, a target that
 *    stopped being a top-level gap, a node the Fitter would silently unwrap)
 *    is refused by `blockMove.ts`.
 *  - A BLOCK PRESS MUST NEVER FOCUS THE EDITOR OR RAISE THE KEYBOARD, however
 *    long it lasts and whether or not it lifts. Measured on the pool emulator,
 *    2026-09-08 (Android 16, System WebView 133), touch stationary on a block
 *    with the editor unfocused: Chromium's OWN long-press fires at touch-down
 *    + ~500ms and dispatches, in this order and in the same millisecond,
 *    `selectstart` on the block, `focus` on `.ProseMirror`, `focusin`, then
 *    `contextmenu` — and the `focus` lands regardless of the page cancelling
 *    `selectstart`/`contextmenu`/`touchend`; none of the three levers stop it.
 *    This happens on TEXT blocks too, not only empty ones. So a capture-phase
 *    `focus` listener on the document undoes it for a press that began
 *    unfocused: `stopPropagation()` keeps the event from ever reaching
 *    `view.dom`'s own focus listener (the one bridge.ts's `focus: true`
 *    message rides), then `blur()` returns focus to `body`. A press that
 *    began with the editor already focused is left alone — dragging while
 *    typing must not drop the keyboard.
 *  - AN EMPTY PARAGRAPH CANNOT BE LIFTED. Holding one used to lift a blank
 *    "phantom" card AND (via the point above) raise the keyboard underneath
 *    it — visibly colliding. The press still arms exactly like any other
 *    block press (it still needs to stand the platform's own long-press
 *    gestures down), it just never starts the lift timer, so no ghost, no
 *    haptic, and no `blockDrag` message ever follow it.
 *  - FOCUS ARBITRATES DRAG VS. SELECTION (product decision, 2026-09-11,
 *    closing a QA report that a phone's block drag made text unselectable —
 *    every long-press was read as "lift this block" instead of "select this
 *    word"). Arbitrated ONCE, at touch-down, off `view.hasFocus()`: a press
 *    that begins with the editor ALREADY focused (soft keyboard up) is text
 *    selection and caret placement, full stop — `onPointerDown` returns
 *    before arming anything, so none of the ARMED_CLASS suppression, the
 *    `selectstart`/`contextmenu` cancellation, or the lift timer ever run,
 *    and the platform's own selection gesture is left completely alone. A
 *    press that begins UNFOCUSED (keyboard down) arms and may drag exactly as
 *    before. This does not relax the point above it: the two rules guard
 *    different moments. This one decides whether to arm AT ALL, from the
 *    state at touch-down; that one protects an ALREADY-armed press — which,
 *    because of this gate, is now always an unfocused-start press — from
 *    Chromium's own long-press forcing focus onto it mid-gesture. `pressWasFocused`
 *    is therefore always `false` by the time an armed press reaches
 *    `onFocusCapture`/`finish()`; that is kept as an explicit, named invariant
 *    (not deleted as dead code) so a future change to this gate has to
 *    reckon with it rather than silently reopen the old race.
 *
 * Everything after the lift — the dimmed source, the ghost card, the drop
 * indicator, edge auto-scroll, target resolution and the commit — is the
 * SHARED `BlockDragSession` (`blockDragSession.ts`), which the desktop ⠿ handle
 * drives too (`handleBlockDrag.ts`), so the two gestures can never disagree
 * about where a block may land or about which drops are refused. This file keeps
 * what is specific to a finger on a phone: arming, selection suppression, the
 * focus guards, the shell's press/drag messages and the long-press timer.
 *
 * Gating: this plugin is only ever constructed/`.use()`d for a native shell —
 * iOS and Android alike (`blockDragMode.ts`, read by MilkdownEditor.svelte) —
 * and it never coexists with the block-drag gutter handle for one editor
 * instance.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { topLevelBlockAt } from './blockDragGeometry';
import { BlockDragSession } from './blockDragSession';

export type MobileDndHapticKind = 'lift' | 'move' | 'drop';

export interface MobileBlockDndOptions {
  /** Fired on lift, on every boundary the drop indicator moves to, and on a
   * committed (non-no-op) drop. See {@link MobileDndHapticKind}. */
  onHaptic: (kind: MobileDndHapticKind) => void;
  /**
   * True when a block goes airborne, false the moment the gesture resolves in
   * ANY way — commit, no-op drop, or cancel. The iOS shell suspends WKWebView's
   * text-interaction gestures for that window, which is the only thing that
   * stops the OS magnifier appearing over the block being dragged (see the
   * module doc's loupe note and bridge.ts BlockDragMessage). Optional: the
   * plugin is fully functional without a listener, just with the loupe.
   */
  onDragActive?: (active: boolean) => void;
  /**
   * True the instant a finger lands on a block, false the instant that press
   * resolves in ANY way — lift, plain tap, scroll, or cancel. Strictly wider
   * than {@link MobileBlockDndOptions.onDragActive}, and the whole point of it
   * is that it does NOT wait for the long-press timer: the iOS shell stands
   * WKWebView's delayed text-interaction gestures down here, so the OS
   * magnifier cannot appear even when no lift follows (see the module doc's
   * touch-down note and bridge.ts BlockPressMessage). Optional: the plugin is
   * fully functional without a listener, just back to racing the OS.
   */
  onPressActive?: (pressed: boolean) => void;
  /** Stationary hold (ms) before a touch lifts a block. Default 340, which is
   * a FEEL number, not a race number: iOS's own text interaction was measured at
   * 655ms focused / ~700ms unfocused, and `onPressActive` — not this timer — is
   * what keeps it out of the way (see the module doc's touch-down note). No
   * caller overrides either of these today; they exist because both numbers
   * were tuned by hand on a device and the next tuning pass wants a dial. */
  longPressMs?: number;
  /** Movement (px) before the timer fires that cancels the pending lift and
   * lets the gesture pass through as an ordinary scroll. */
  moveCancelPx?: number;
}

/** Exported so a test can hold for longer than the lift timer without
 * hardcoding a second copy of the number. */
export const DEFAULT_LONG_PRESS_MS = 340;

/** How long a released hold keeps absorbing the native click's deferred focus. */
const FOCUS_GUARD_MS = 1000;

const liveViews = new Set<{ dropFocusGuard: () => void }>();

/** A host `focus()` is intentional, so it must never be swallowed by a release
 * guard still waiting for a native click: the editor's `focus()` calls this first. */
export function dropBlockDndFocusGuards(): void {
  for (const view of liveViews) view.dropFocusGuard();
}
const DEFAULT_MOVE_CANCEL_PX = 10;

/** Marks the ProseMirror root for the whole gesture (pointerdown -> release),
 * not just the drag: iOS's selection gesture starts long before our lift. */
const ARMED_CLASS = 'futo-mobile-dnd-armed';

/** Paints any range WebKit establishes anyway as transparent. SEPARATE from
 * ARMED_CLASS because its descendant `::selection` rule restyles the WHOLE note
 * on every toggle — measured under Chromium (4x CPU throttle) at 21ms/65ms add
 * and the same again on remove for 1,000/3,000 blocks (~0.8s/2.3s on a real
 * Android phone), versus 0.5/1.4ms for the user-select declarations alone; no
 * selector shape (child/tag/:where/sheet or media toggle/custom property) was
 * cheaper there. Only added where the race it covers was actually measured
 * (iOS WebKit, see `needsSelectionNet`). */
const HIDE_SELECTION_CLASS = 'futo-mobile-dnd-hide-selection';

/** iOS WKWebView is the only engine here that commits to a selection the page
 * cannot cancel (module doc); Chromium's long-press selection is stopped by the
 * synchronous `selectstart` cancel alone. Detected as "not Chromium"
 * (`navigator.userAgentData` is Chromium-only) so an engine we cannot identify
 * keeps the net rather than silently losing it. */
function needsSelectionNet(): boolean {
  return typeof navigator === 'undefined' || !('userAgentData' in navigator);
}

/** Injected once per page (not per editor instance/mount). The ghost, indicator
 * and source-dim styles are the shared session's (blockDragSession.ts). */
let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-futo-mobile-block-dnd', '');
  style.textContent = `
    /* Selection suppression for the WHOLE gesture — see the module doc's
     * "selection suppression is a whole-gesture job". !important because
     * milkdownEditor.css's own '.futo-milkdown .ProseMirror ::selection'
     * rule is equally specific and would otherwise win on source order. */
    .${ARMED_CLASS} {
      -webkit-user-select: none !important;
      user-select: none !important;
      -webkit-touch-callout: none !important;
    }
    .${HIDE_SELECTION_CLASS} ::selection,
    .${HIDE_SELECTION_CLASS}::selection {
      background: transparent !important;
      color: inherit !important;
    }
  `;
  document.head.appendChild(style);
}

type PressedBlock = {
  pos: number;
  size: number;
  dom: HTMLElement;
  clone: HTMLElement;
  /** False for an empty paragraph (module doc's "an empty paragraph cannot be
   * lifted") — the press still arms and runs the timer, `beginLift` just
   * refuses to actually lift it. */
  liftable: boolean;
};

/** Owns the whole long-press/lift/drag/drop state machine for one editor
 * instance. Constructed as this Plugin's `view()` (a ProseMirror PluginView),
 * so its lifetime matches the editor view's. Exported so the focus-arbitration
 * gate (module doc's "focus arbitrates drag vs. selection") can be unit-tested
 * directly against a fake `ProseView`, without standing up a real Milkdown
 * editor — the physical long-press gesture itself still needs a device/
 * Playwright's touch stream, which is what `tests/editor-embed-milkdown.spec.ts`
 * covers. */
export class MobileBlockDndView {
  private readonly view: ProseView;
  private readonly options: Required<MobileBlockDndOptions>;
  private readonly doc: Document;

  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private lastY = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dragging = false;
  private pressed: PressedBlock | null = null;
  /** True when the editor already held focus at the moment this press
   * started. Decides whether `onFocusCapture` undoes a focus that lands mid-
   * press (module doc's "a block press must never focus the editor"). */
  private pressWasFocused = false;
  /** True once the lift timer has fired for this press, whether or not it
   * actually lifted anything (an empty paragraph arms the timer but never
   * lifts). Distinguishes an ordinary short tap — which must still be free to
   * focus and place a caret on release — from a genuine hold, which must not,
   * however it resolves (see `guardFocusBriefly`). */
  private heldPastThreshold = false;

  /** The lifted half of the gesture: ghost, indicator, auto-scroll, commit. */
  private readonly session: BlockDragSession;

  constructor(view: ProseView, options: MobileBlockDndOptions) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
    this.options = {
      onHaptic: options.onHaptic,
      onDragActive: options.onDragActive ?? (() => {}),
      onPressActive: options.onPressActive ?? (() => {}),
      longPressMs: options.longPressMs ?? DEFAULT_LONG_PRESS_MS,
      moveCancelPx: options.moveCancelPx ?? DEFAULT_MOVE_CANCEL_PX,
    };
    this.session = new BlockDragSession(view, {
      onBoundaryChange: () => this.options.onHaptic('move'),
    });
    ensureStyles();
    view.dom.addEventListener('pointerdown', this.onPointerDown);
    liveViews.add(this);
  }

  destroy(): void {
    liveViews.delete(this);
    this.dropFocusGuard();
    this.disarm();
    this.session.destroy();
    this.view.dom.removeEventListener('pointerdown', this.onPointerDown);
  }

  /* ---- listener wiring -------------------------------------------------- *
   * Everything past pointerdown is bound to the DOCUMENT in the capture
   * phase (see the module doc): the pressed block's DOM node can be detached
   * by the decoration re-render, and the finger can leave the editor box —
   * both of which silently starve listeners bound to `view.dom`. */
  private addGestureListeners(): void {
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

  private removeGestureListeners(): void {
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

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The single exit from armed/dragging back to idle: drops the gesture
   * listeners, the long-press timer, and the selection suppression. Anything
   * that abandons a gesture MUST go through here, or the editor is left
   * unselectable. */
  private disarm(): void {
    this.cancelTimer();
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

  /* ---- selection suppression -------------------------------------------- */

  private onSelectStart = (event: Event): void => {
    if (this.pointerId === null) return;
    event.preventDefault();
  };

  private onContextMenu = (event: Event): void => {
    if (this.pointerId === null) return;
    event.preventDefault();
  };

  private onSelectionChange = (): void => {
    if (this.pointerId === null) return;
    this.collapseSelection();
  };

  /** Undoes a focus that Chromium's own long-press forces onto the editable
   * mid-press (module doc's "a block press must never focus the editor").
   * Only for a press that began UNFOCUSED — a press that began focused must
   * leave focus (and the keyboard) exactly where it was, since dragging while
   * typing should not dismiss it. `stopPropagation()` first, so `view.dom`'s
   * own focus listener (which is what emits bridge.ts's `focus: true`
   * message and flips the Android toolbar) never sees this focus at all. */
  private onFocusCapture = (event: FocusEvent): void => {
    if (this.pointerId === null || this.pressWasFocused) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !this.view.dom.contains(target)) return;
    event.stopPropagation();
    target.blur();
  };

  /** `disarm()` (called from `finish()`, just before this) intentionally tears
   * down `onFocusCapture` at release so an ORDINARY short tap can still focus
   * and place a caret — that is the existing, load-bearing "tap-to-place-caret
   * untouched" behaviour. But a press that reached the hold threshold is not
   * an ordinary tap, and measured in this very harness: releasing one in place
   * (no movement) still resolves to a native click that focuses the editable,
   * exactly the "however long it lasts... whether or not it lifts" case the
   * module doc names, not the short-tap case `disarm()`'s timing protects. A
   * short-lived, self-removing capture listener absorbs that one deferred
   * focus without staying registered a moment longer than it has to, so it
   * can never shadow a genuinely new press's own guard. */
  private guardFocusBriefly(untilClick: boolean): void {
    this.dropFocusGuard();
    const doc = this.doc;
    const handler = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !this.view.dom.contains(target)) return;
      event.stopPropagation();
      target.blur();
      this.dropFocusGuard();
    };
    doc.addEventListener('focus', handler, true);
    // A hold released without a drag (the empty paragraph, which never lifts)
    // ends in a native click, and that click is a separate task after
    // `pointerup`: under load a frame runs in between, so a one-frame guard was
    // already gone when the focus arrived (the editor ended up focused, and the
    // NEXT press then saw a focused editor and never armed — RC-84). That guard
    // therefore lives until it absorbs the focus, the next press starts, a host
    // `focus()` (`dropBlockDndFocusGuards`), or this timeout. A drag release
    // keeps the original one-frame guard: a touch that moved emits no click, so
    // a longer guard would only swallow the host's own focus (R10-FB20-1).
    const timer = untilClick ? setTimeout(() => this.dropFocusGuard(), FOCUS_GUARD_MS) : null;
    const frame = untilClick ? null : requestAnimationFrame(() => this.dropFocusGuard());
    this.dropFocusGuard = () => {
      if (timer !== null) clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
      doc.removeEventListener('focus', handler, true);
      this.dropFocusGuard = () => {};
    };
  }

  /** Removes the release-time focus guard, if one is live. */
  dropFocusGuard: () => void = () => {};

  /** Collapses any live range in BOTH representations. The ProseMirror state
   * is authoritative for the editor, but WebKit can leave a DOM range behind
   * that ProseMirror has not read yet — and that range is what the user
   * actually sees highlighted. */
  private collapseSelection(): void {
    const view = this.view;
    if (!view.state.selection.empty) {
      const pos = view.state.selection.from;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    }
    const domSelection = this.doc.getSelection();
    if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) return;
    const anchor = domSelection.anchorNode;
    if (!anchor || !view.dom.contains(anchor)) return;
    try {
      domSelection.collapseToStart();
    } catch {
      // Transient (node detached mid-render) — the next selectionchange retries.
    }
  }

  /* ---- gesture ----------------------------------------------------------- */

  private onPointerDown = (event: PointerEvent): void => {
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

  private onPointerMove = (event: PointerEvent): void => {
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

    this.session.move(event.clientX, event.clientY);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.finish(event.clientY, true);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.finish(event.clientY, false);
  };

  /** touchmove is what actually needs suppressing on WKWebView; pointermove
   * alone does not reliably stop the native scroll/selection gesture. Bound at
   * ARM time on the document, so the FIRST post-lift move is covered even if
   * the pressed block's DOM was replaced by the decoration render. */
  private onTouchMove = (event: TouchEvent): void => {
    if (this.dragging) event.preventDefault();
  };

  /** Safety net only. The Pointer Events spec dispatches `pointerup` before
   * `touchend`, so the pointer handlers normally win and this finds nothing
   * left to do; it exists so a dropped `pointerup` cannot strand the editor in
   * the armed state (no selection, no caret) forever. */
  private onTouchEnd = (event: TouchEvent): void => {
    if (this.pointerId === null || event.touches.length > 0) return;
    const commit = event.type === 'touchend';
    setTimeout(() => {
      if (this.pointerId === null) return;
      this.finish(this.lastY, commit);
    }, 0);
  };

  private beginLift(clientX: number, clientY: number): void {
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
  private finish(clientY: number, commit: boolean): void {
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

/** The Milkdown plugin: `.use(createMobileBlockDndPlugin({ onHaptic }))`.
 * The DOM-event-driven `MobileBlockDndView` above; the source-block dim's state
 * is `blockDragSourcePlugin`'s (blockDragSession.ts), mounted beside it. Never
 * combined with `@milkdown/kit/plugin/block`'s gutter handle for one editor
 * instance — see MilkdownEditor.svelte's single native-shell gate. */
export function createMobileBlockDndPlugin(options: MobileBlockDndOptions) {
  return $prose(
    () =>
      new Plugin({
        view(editorView) {
          return new MobileBlockDndView(editorView, options);
        },
      }),
  );
}

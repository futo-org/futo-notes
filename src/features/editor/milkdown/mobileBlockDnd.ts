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
 *      2. A transparent `::selection` while armed, so a range WebKit manages
 *         to establish anyway is never *rendered*.
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
 *
 * Geometry and commit are both SHARED with the ⠿-handle drag path
 * (the desktop ⠿ handle): `blockDragGeometry.ts` resolves the target and
 * `blockMove.ts` performs the move, so the two paths can never disagree about
 * where a block may land or about which drops are refused.
 *
 * Gating: this plugin is only ever constructed/`.use()`d for a native shell —
 * iOS and Android alike (`blockDragMode.ts`, read by MilkdownEditor.svelte) —
 * and it never coexists with the block-drag gutter handle for one editor
 * instance.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import {
  createDragAutoScroller,
  targetAtPointerY,
  topLevelBlockAt,
  type DragAutoScroller,
  type DropTarget,
  dragSourceAt,
} from './blockDragGeometry';
import { isNoOpDrop, moveBlock, type BlockMoveRange } from './blockMove';

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
const DEFAULT_MOVE_CANCEL_PX = 10;

/** Horizontal breathing room the ghost card adds around the block's own rect,
 * so the preview reads as a card the block sits inside rather than a crop of
 * it. Mirrored as the card's own padding so the text stays put under the
 * finger. */
const GHOST_PAD_X_PX = 12;
/** Exported so the ghost-geometry regression test can assert the card's
 * position and content height against the block's own rect without keeping a
 * second copy of the number (same reason as `DEFAULT_LONG_PRESS_MS`). */
export const GHOST_PAD_Y_PX = 10;
/** How much of the screen the card may cover before it is cropped.
 *
 * Applied in JS, from `window.innerHeight`, NOT as `max-height: 40vh` in the
 * stylesheet. Both native hosts render this bundle in a web view whose INITIAL
 * CONTAINING BLOCK is zero-height — the same defect `editor.html` pins the body
 * against, and the reason `MilkdownEditor.svelte`'s bottom padding is written
 * `max(40vh, 280px)` — so `vh` resolves to 0 there while `window.innerHeight`
 * reports the real height. Measured on an Android 16 / Chromium 133 WebView:
 * a `40vh` probe measured 0px with `innerHeight` at 647. With
 * `overflow: hidden` above it, that collapsed the card to its own padding —
 * a 22px sliver of a 105px block, sitting above the drop indicator (MR !276).
 * `innerHeight` is the same number `createGhost` already trusts for the width
 * clamp. */
const GHOST_MAX_HEIGHT_FRACTION = 0.4;
/** How much the card grows on lift, so it reads as picked up off the page. */
const GHOST_SCALE = 1.04;
/** Keep the SCALED card off the screen edges. */
const GHOST_VIEWPORT_MARGIN_PX = 4;

/** Marks the ProseMirror root for the whole gesture (pointerdown -> release),
 * not just the drag: iOS's selection gesture starts long before our lift. */
const ARMED_CLASS = 'futo-mobile-dnd-armed';

interface MobileDndPluginState {
  decorationSet: DecorationSet;
}

const mobileBlockDndKey = new PluginKey<MobileDndPluginState>('futo-mobile-block-dnd');

/** Injected once per page (not per editor instance/mount) — the ghost and
 * indicator live outside the ProseMirror DOM (fixed-position), so their
 * styling can't ride along with the component's scoped `<style>` block. */
let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-futo-mobile-block-dnd', '');
  style.textContent = `
    .futo-mobile-dnd-source { opacity: 0.35; transition: opacity 0.12s ease; }

    /* Selection suppression for the WHOLE gesture — see the module doc's
     * "selection suppression is a whole-gesture job". !important because
     * MilkdownEditor.svelte's own '.futo-milkdown .ProseMirror ::selection'
     * rule is equally specific and would otherwise win on source order. */
    .${ARMED_CLASS} {
      -webkit-user-select: none !important;
      user-select: none !important;
      -webkit-touch-callout: none !important;
    }
    .${ARMED_CLASS} ::selection,
    .${ARMED_CLASS}::selection {
      background: transparent !important;
      color: inherit !important;
    }

    .futo-mobile-dnd-ghost {
      position: fixed;
      left: 0;
      top: 0;
      margin: 0;
      pointer-events: none;
      z-index: 1000;
      will-change: transform;
    }
    /* The card. Deliberately more specific (3 classes) than
     * '.futo-milkdown .ProseMirror' so the ProseMirror class it also carries
     * supplies the real content typography (headings, code, lists) while the
     * editor's own box rules — full height, internal scroller, 54px gutter —
     * are overridden here. */
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-ghost-card.ProseMirror {
      box-sizing: border-box;
      width: 100%;
      height: auto;
      /* The cap itself is set inline from window.innerHeight — see
       * GHOST_MAX_HEIGHT_FRACTION for why it must not be written in vh. */
      overflow: hidden;
      padding: ${GHOST_PAD_Y_PX}px ${GHOST_PAD_X_PX}px;
      border-radius: 14px;
      /* Translucent on purpose: the card is drawn over the drop indicator
       * line and the dimmed source block, and both need to read through it.
       * Only the background is see-through — text stays fully opaque. */
      background: color-mix(in srgb, var(--color-surface, #f2f2f2) 80%, transparent);
      border: 1px solid var(--color-border, #e5e5e5);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.12),
        0 6px 14px rgba(0, 0, 0, 0.16),
        0 20px 44px rgba(0, 0, 0, 0.24);
      opacity: 0;
      transform: scale(0.97);
      transform-origin: 50% 40%;
      transition:
        transform 0.12s cubic-bezier(0.2, 0.9, 0.3, 1),
        opacity 0.12s ease;
    }
    /* Added on the next frame after insertion, so the card visibly POPS up
     * under the finger instead of appearing fully formed. */
    .futo-milkdown .futo-mobile-dnd-ghost--lifted .futo-mobile-dnd-ghost-card.ProseMirror {
      opacity: 1;
      transform: scale(${GHOST_SCALE});
    }
    /* Only when the block genuinely exceeds the height cap — an unconditional
     * mask would fade the bottom of every short block. */
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-ghost-card--clipped {
      -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 56px), transparent 100%);
      mask-image: linear-gradient(to bottom, #000 calc(100% - 56px), transparent 100%);
    }
    /* The block's own leading margin belongs to the document flow, not to a
     * card that is already padded. */
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-ghost-card.ProseMirror > * {
      margin-top: 0;
      margin-bottom: 0;
    }
    /* The source dim is a decoration on the live block; a clone taken while it
     * is applied would be a 35%-opacity ghost. Belt and braces on top of
     * cloning before the decoration is dispatched. */
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-source {
      opacity: 1;
    }

    .futo-mobile-dnd-indicator {
      position: fixed;
      height: 3px;
      margin-top: -1.5px;
      border-radius: 2px;
      background: var(--color-primary, #f26b1f);
      pointer-events: none;
      /* Drawn UNDER the ghost card (z-index 1000): the card's background is
       * translucent (see .futo-mobile-dnd-ghost-card above), so the line
       * still reads through it instead of being fully hidden. */
      z-index: 999;
      opacity: 0;
      transition: opacity 0.08s ease;
    }
    .futo-mobile-dnd-indicator--visible { opacity: 1; }
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
 * so its lifetime matches the editor view's. */
class MobileBlockDndView {
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

  /** The boundary the indicator is currently drawn at. `pos` IS the boundary's
   * whole identity (blockDragGeometry.ts), so only a CHANGE of this fires a
   * 'move' haptic: a finger travelling inside one gap is silent, and crossing
   * from one block's lower half into the next block's upper half — the same
   * gap — is silent too, because the bar did not move. */
  private indicatorPos: number | null = null;

  /** Continuous edge auto-scroll while dragging. Owned per editor view and
   * stopped from `disarm()`, the one exit every gesture goes through. */
  private readonly autoScroll: DragAutoScroller;

  private ghostEl: HTMLDivElement | null = null;
  private indicatorEl: HTMLDivElement | null = null;
  private liftX = 0;
  private liftY = 0;

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
    this.autoScroll = createDragAutoScroller(view, this.onAutoScrollStep);
    ensureStyles();
    view.dom.addEventListener('pointerdown', this.onPointerDown);
  }

  destroy(): void {
    this.disarm();
    this.cleanupDragVisuals();
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
    this.autoScroll.stop();
    this.removeGestureListeners();
    const wasArmed = this.pointerId !== null;
    this.pointerId = null;
    this.pressed = null;
    this.indicatorPos = null;
    const wasDragging = this.dragging;
    this.dragging = false;
    this.heldPastThreshold = false;
    this.view.dom.classList.remove(ARMED_CLASS);
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
  private guardFocusBriefly(): void {
    const doc = this.doc;
    const handler = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !this.view.dom.contains(target)) return;
      event.stopPropagation();
      target.blur();
      doc.removeEventListener('focus', handler, true);
    };
    doc.addEventListener('focus', handler, true);
    requestAnimationFrame(() => doc.removeEventListener('focus', handler, true));
  }

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
    const block = topLevelBlockAt(this.view, event.clientX, event.clientY);
    if (!block) return;
    // An empty paragraph arms like any other block (below) but is never
    // liftable — see the module doc's "an empty paragraph cannot be lifted".
    const liftable = !(block.node.isTextblock && block.node.content.size === 0);
    this.pointerId = event.pointerId;
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

    this.updateGhostPosition(event.clientX, event.clientY);
    this.syncIndicator(event.clientY, true);
    this.autoScroll.update(event.clientY);
  };

  /** Redraws the drop indicator for `clientY`, ticking once per NEW boundary
   * when `tick` is true.
   *
   * Auto-scroll passes false. The finger is holding still while the document
   * sweeps past underneath it, and at auto-scroll speeds that is hundreds of
   * boundaries a second: a tick each would be one continuous buzz, and would
   * destroy the meaning of the tick, which is "you have put the bar somewhere
   * new". The spec already says a hold ticks nothing, and an auto-scroll IS a
   * hold. The key is still updated, so the first tick after the finger resumes
   * moving belongs to a genuinely new boundary rather than to one the eye
   * already saw slide by. */
  private syncIndicator(clientY: number, tick: boolean): void {
    const target = this.computeTarget(clientY);
    if (!target || this.isNoOpTarget(target)) {
      // A no-op target (either of the pressed block's own two boundaries, or
      // nowhere resolvable) draws no line: `indicatorPos` is cleared rather
      // than left pointing at the no-op boundary, so the first tick after the
      // finger leaves this zone always belongs to the first genuinely new
      // boundary it reaches — never a spurious one for re-entering here, and
      // never one for the two no-op boundaries between each other.
      this.hideIndicator();
      this.indicatorPos = null;
      return;
    }
    this.showIndicator(target);
    if (target.pos === this.indicatorPos) return;
    this.indicatorPos = target.pos;
    if (tick) this.options.onHaptic('move');
  }

  /** True when `target` is a no-op for the block currently pressed — i.e. one
   * of its own two boundaries (`isNoOpDrop`, shared with `moveBlock` and the
   * desktop ⠿-handle path). Guards the indicator/haptic layer here; a release
   * over a no-op target was already a silent no-op via `moveBlock`, this only
   * stops the line being drawn (and the card overlapping it) while the finger
   * is still over the block it just picked up. */
  private isNoOpTarget(target: DropTarget): boolean {
    return this.pressed !== null && isNoOpDrop(this.currentSourceRange(this.pressed), target.pos);
  }

  /** After every frame edge auto-scroll actually moved the scroller. The
   * pointer has not moved, so the ghost stays put — but the boundary UNDER it
   * has changed, and the indicator (and the position a release would commit to)
   * must be recomputed from the new geometry rather than assumed. */
  private onAutoScrollStep = (): void => {
    if (!this.dragging) return;
    this.syncIndicator(this.lastY, false);
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
    const view = this.view;

    // Belt and braces: the shell has been holding WKWebView's delayed text
    // interaction down since pointerdown (`onPressActive`), so there should be
    // no range to collapse — but a host without a `blockPress` case leaves this
    // as the page's only defence.
    this.collapseSelection();

    const decoration = Decoration.node(this.pressed.pos, this.pressed.pos + this.pressed.size, {
      class: 'futo-mobile-dnd-source',
    });
    view.dispatch(
      view.state.tr.setMeta(mobileBlockDndKey, {
        decorationSet: DecorationSet.create(view.state.doc, [decoration]),
      }),
    );

    this.dragging = true;
    /* Seeded from where the block already is, so the hold itself is silent: the
     * first tick belongs to the first boundary the finger actually reaches.
     * A resting target that is one of the block's own boundaries seeds null
     * instead (isNoOpTarget), for the same reason `syncIndicator` clears it —
     * that boundary draws no line to begin with. */
    const restingTarget = this.computeTarget(clientY);
    this.indicatorPos =
      restingTarget && !this.isNoOpTarget(restingTarget) ? restingTarget.pos : null;
    this.createGhost(clientX, clientY);
    // Escalates the shell from the press-level suspension it has held since
    // pointerdown to the full one (the whole text-interaction stack, plus the
    // `isTextInteractionEnabled` preference) — safe only now that the gesture
    // is known to be a drag. Before the haptic, so the escalation is in flight
    // while the finger is still being told it worked.
    this.options.onDragActive(true);
    this.options.onHaptic('lift');
  }

  /** The ghost host is the `.futo-milkdown` container (OUTSIDE the
   * contenteditable, so no DOMObserver interference) rather than document.body:
   * the card carries the `ProseMirror` class, and the component's scoped
   * `.futo-milkdown .ProseMirror <element>` typography only applies inside
   * that container. Under document.body the clone rendered with bare UA
   * styling — the "too timid" preview. */
  private ghostHost(): HTMLElement {
    return this.view.dom.closest('.futo-milkdown') ?? this.doc.body;
  }

  private createGhost(clientX: number, clientY: number): void {
    const pressed = this.pressed;
    if (!pressed) return;
    const rect = pressed.dom.getBoundingClientRect();

    const clone = pressed.clone;
    clone.classList.remove('futo-mobile-dnd-source');
    for (const dimmed of Array.from(clone.querySelectorAll('.futo-mobile-dnd-source'))) {
      dimmed.classList.remove('futo-mobile-dnd-source');
    }

    const card = this.doc.createElement('div');
    // `ProseMirror` so the editor's own content typography applies to the
    // clone; the card rules above override the editor's BOX rules.
    card.className = 'futo-mobile-dnd-ghost-card ProseMirror';
    // In pixels, never `vh` (GHOST_MAX_HEIGHT_FRACTION): the native hosts' web
    // view resolves viewport units against a zero-height containing block.
    const viewportHeight = window.innerHeight || this.doc.documentElement.clientHeight;
    card.style.maxHeight = `${Math.round(viewportHeight * GHOST_MAX_HEIGHT_FRACTION)}px`;
    card.appendChild(clone);

    const ghost = this.doc.createElement('div');
    ghost.className = 'futo-mobile-dnd-ghost';
    ghost.setAttribute('aria-hidden', 'true');

    // Essentially full block width, grown by the card's own padding so the
    // content stays put under the finger, then clamped so the SCALED card
    // still clears both screen edges (the scale grows it about its centre, so
    // half the growth bleeds out of each side).
    const viewportWidth = window.innerWidth || rect.width + GHOST_PAD_X_PX * 2;
    const usable = viewportWidth - GHOST_VIEWPORT_MARGIN_PX * 2;
    const width = Math.min(rect.width + GHOST_PAD_X_PX * 2, usable / GHOST_SCALE);
    const bleed = (width * (GHOST_SCALE - 1)) / 2;
    const minLeft = GHOST_VIEWPORT_MARGIN_PX + bleed;
    const left = Math.min(
      Math.max(minLeft, rect.left - GHOST_PAD_X_PX),
      Math.max(minLeft, viewportWidth - GHOST_VIEWPORT_MARGIN_PX - bleed - width),
    );
    ghost.style.width = `${width}px`;
    ghost.style.left = `${left}px`;
    ghost.style.top = `${rect.top - GHOST_PAD_Y_PX}px`;
    ghost.appendChild(card);

    this.ghostHost().appendChild(ghost);
    this.ghostEl = ghost;

    // Fade the bottom out ONLY when the block actually overflows the cap.
    if (card.scrollHeight - card.clientHeight > 1) {
      card.classList.add('futo-mobile-dnd-ghost-card--clipped');
    }
    // Next frame, so the 120ms pop transition has a start state to run from.
    requestAnimationFrame(() => ghost.classList.add('futo-mobile-dnd-ghost--lifted'));

    this.liftX = clientX;
    this.liftY = clientY;
  }

  private updateGhostPosition(clientX: number, clientY: number): void {
    if (!this.ghostEl) return;
    const dx = clientX - this.liftX;
    const dy = clientY - this.liftY;
    // Translation lives on the OUTER element and the pop scale on the inner
    // card, so dragging is never animated through the card's 120ms transition.
    this.ghostEl.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** The pressed block's CURRENT position decides which gaps it may land in
   * (blockDragGeometry.ts); a press always grabs a top-level block today, so
   * those are the top-level gaps. */
  private computeTarget(clientY: number, pressed = this.pressed): DropTarget | null {
    if (!pressed) return null;
    const source = dragSourceAt(this.view.state.doc, this.currentSourceRange(pressed).from);
    return source ? targetAtPointerY(this.view, clientY, source) : null;
  }

  private ensureIndicator(): HTMLDivElement {
    if (!this.indicatorEl) {
      const el = this.doc.createElement('div');
      el.className = 'futo-mobile-dnd-indicator';
      el.setAttribute('aria-hidden', 'true');
      this.doc.body.appendChild(el);
      this.indicatorEl = el;
    }
    return this.indicatorEl;
  }

  /** One line per boundary, drawn IN the gap — the geometry is the target's, so
   * a gap approached from either side puts the bar in exactly one place
   * (blockDragGeometry.ts). The `margin-top` in the stylesheet re-centres the
   * 3px bar on `top`. */
  private showIndicator(target: DropTarget): void {
    const el = this.ensureIndicator();
    el.style.left = `${target.indicator.left}px`;
    el.style.width = `${target.indicator.width}px`;
    el.style.top = `${target.indicator.top}px`;
    el.classList.add('futo-mobile-dnd-indicator--visible');
  }

  private hideIndicator(): void {
    this.indicatorEl?.classList.remove('futo-mobile-dnd-indicator--visible');
  }

  private cleanupDragVisuals(): void {
    this.ghostEl?.remove();
    this.ghostEl = null;
    this.indicatorEl?.remove();
    this.indicatorEl = null;
  }

  private clearDecoration(): void {
    const view = this.view;
    view.dispatch(view.state.tr.setMeta(mobileBlockDndKey, { decorationSet: DecorationSet.empty }));
  }

  /** The source block's CURRENT range. The decoration set is mapped through
   * every transaction (see the plugin's `apply`), so this survives anything
   * that edited the doc between pointerdown and release — autocorrect, a host
   * `setContent`, the trailing-paragraph plugin. The pointerdown-time
   * positions are only the fallback. */
  private currentSourceRange(pressed: PressedBlock): BlockMoveRange {
    const decorations = mobileBlockDndKey.getState(this.view.state)?.decorationSet;
    const found = decorations?.find();
    if (found && found.length === 1) return { from: found[0].from, to: found[0].to };
    return { from: pressed.pos, to: pressed.pos + pressed.size };
  }

  /** Shared tail for release (`commit=true`) and cancel (`commit=false`, which
   * WILL happen — incoming calls, system gestures — and must clean up exactly
   * like a normal release with no transaction). */
  private finish(clientY: number, commit: boolean): void {
    const wasDragging = this.dragging;
    const pressed = this.pressed;
    // Captured before `disarm()` resets both: a press that reached the hold
    // threshold — lifted or not (an empty paragraph never lifts) — while
    // starting unfocused must not end up focused either, however it resolves
    // (module doc's "a block press must never focus the editor"). A plain
    // short tap is deliberately excluded: that is ordinary tap-to-place-caret,
    // which `disarm()`'s own listener teardown already leaves alone.
    const guardFocusOnRelease = !this.pressWasFocused && this.heldPastThreshold;
    this.disarm();
    if (guardFocusOnRelease) this.guardFocusBriefly();

    if (!wasDragging || !pressed) return; // a plain tap / short hold: nothing to undo

    this.cleanupDragVisuals();

    // `pressed` explicitly: disarm() above has already cleared the field.
    const target = commit ? this.computeTarget(clientY, pressed) : null;
    if (!target) {
      this.clearDecoration();
      return;
    }

    const view = this.view;
    const range = this.currentSourceRange(pressed);
    // Every refusal case (stale range, a target that stopped being a top-level
    // gap, a drop back at the source, a node ProseMirror would re-shape) lives
    // in moveBlock, shared with the ⠿-handle drag path. A drop that
    // commits nothing is silent: no transaction, no history entry, no
    // 'change', and no drop haptic.
    const committed = moveBlock(view, range, target.pos, (tr) =>
      // Same transaction as the move, so the source block is never drawn
      // dimmed for a frame at its new position.
      tr.setMeta(mobileBlockDndKey, { decorationSet: DecorationSet.empty }),
    );
    if (committed) this.options.onHaptic('drop');
    else this.clearDecoration();
  }
}

/** The Milkdown plugin: `.use(createMobileBlockDndPlugin({ onHaptic }))`.
 * Owns a plugin-state `DecorationSet` (for the source-block dim) plus the
 * DOM-event-driven `MobileBlockDndView` above. Never combined with
 * `@milkdown/kit/plugin/block`'s gutter handle for one editor instance — see
 * MilkdownEditor.svelte's single iOS gate. */
export function createMobileBlockDndPlugin(options: MobileBlockDndOptions) {
  return $prose(
    () =>
      new Plugin<MobileDndPluginState>({
        key: mobileBlockDndKey,
        state: {
          init: () => ({ decorationSet: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(mobileBlockDndKey) as MobileDndPluginState | undefined;
            if (meta) return meta;
            if (tr.docChanged)
              return { decorationSet: value.decorationSet.map(tr.mapping, tr.doc) };
            return value;
          },
        },
        props: {
          decorations(state) {
            return mobileBlockDndKey.getState(state)?.decorationSet ?? null;
          },
        },
        view(editorView) {
          return new MobileBlockDndView(editorView, options);
        },
      }),
  );
}

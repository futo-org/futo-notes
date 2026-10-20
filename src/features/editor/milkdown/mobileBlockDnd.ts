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
import { Plugin } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { ensureStyles, type MobileBlockDndOptions } from './mobileBlockDndConfig';
import { MobileBlockDndGesture } from './mobileBlockDndGesture';
import { liveViews } from './mobileBlockDndGuards';

export {
  DEFAULT_LONG_PRESS_MS,
  needsSelectionNet,
  type MobileBlockDndOptions,
  type MobileDndHapticKind,
} from './mobileBlockDndConfig';
export { dropBlockDndFocusGuards } from './mobileBlockDndGuards';

/** Owns the whole long-press/lift/drag/drop state machine for one editor
 * instance. Constructed as this Plugin's `view()` (a ProseMirror PluginView),
 * so its lifetime matches the editor view's. Exported so the focus-arbitration
 * gate (module doc's "focus arbitrates drag vs. selection") can be unit-tested
 * directly against a fake `ProseView`, without standing up a real Milkdown
 * editor — the physical long-press gesture itself still needs a device/
 * Playwright's touch stream, which is what `tests/editor-embed-milkdown.spec.ts`
 * covers. */
export class MobileBlockDndView extends MobileBlockDndGesture {
  constructor(view: ProseView, options: MobileBlockDndOptions) {
    super(view, options);
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

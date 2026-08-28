/*
 * Notion-style mobile block drag-and-drop — the iOS long-press path.
 *
 * The desktop/Android touch fallback (handleBlockDrag.ts) drives drag off a
 * dedicated ⠿ gutter handle (BlockProvider). On iPhone the product ask is
 * different: there is no handle at all — THE BLOCK ITSELF is the handle.
 * Touch-and-hold a block (~330-350ms; any real movement before the timer
 * cancels it, so ordinary scrolling is untouched) lifts it (a card-like ghost
 * pops up under the finger + a haptic), dragging floats that ghost with a
 * drop-indicator line at the resolved top-level boundary, and release commits
 * the move as ONE transaction (a second haptic) or, dropped back at the
 * source, is a true no-op: no transaction, no history entry, no bridge
 * 'change' message.
 *
 * Hard-won constraints, each of which cost a device debugging session:
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
 *
 * Geometry and commit are both SHARED with the ⠿-handle drag path
 * (`handleBlockDrag.ts`): `blockDragGeometry.ts` resolves the target and
 * `blockMove.ts` performs the move, so the two paths can never disagree about
 * where a block may land or about which drops are refused.
 *
 * Gating: this plugin is only ever constructed/`.use()`d for the native iOS
 * shell (see MilkdownEditor.svelte) — it never coexists with the block-drag
 * gutter handle for one editor instance.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import {
  autoScrollAtEdge,
  targetAtPointerY,
  topLevelBlockAt,
  type TopLevelTarget,
} from './blockDragGeometry';
import { moveTopLevelBlock, type BlockMoveRange } from './blockMove';

export type MobileDndHapticKind = 'lift' | 'drop';

export interface MobileBlockDndOptions {
  /** Fired once on lift and once on a committed (non-no-op) drop. */
  onHaptic: (kind: MobileDndHapticKind) => void;
  /** Stationary hold (ms) before a touch lifts a block. Default 340 — must
   * beat iOS's own ~500ms text-selection long-press (see module doc). No
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
const GHOST_PAD_Y_PX = 10;
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
      max-height: 40vh;
      overflow: hidden;
      padding: ${GHOST_PAD_Y_PX}px ${GHOST_PAD_X_PX}px;
      border-radius: 14px;
      background: var(--color-surface, #f2f2f2);
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
    .futo-milkdown .futo-mobile-dnd-ghost .futo-mobile-dnd-ghost-card > * {
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
      z-index: 1001;
      opacity: 0;
      transition: opacity 0.08s ease;
    }
    .futo-mobile-dnd-indicator--visible { opacity: 1; }
  `;
  document.head.appendChild(style);
}

type PressedBlock = { pos: number; size: number; dom: HTMLElement; clone: HTMLElement };

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

  private ghostEl: HTMLDivElement | null = null;
  private indicatorEl: HTMLDivElement | null = null;
  private liftX = 0;
  private liftY = 0;

  constructor(view: ProseView, options: MobileBlockDndOptions) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
    this.options = {
      onHaptic: options.onHaptic,
      longPressMs: options.longPressMs ?? DEFAULT_LONG_PRESS_MS,
      moveCancelPx: options.moveCancelPx ?? DEFAULT_MOVE_CANCEL_PX,
    };
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
    this.pointerId = null;
    this.pressed = null;
    this.dragging = false;
    this.view.dom.classList.remove(ARMED_CLASS);
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
    this.pointerId = event.pointerId;
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
    };
    // ARM the suppression here, not at lift: iOS's selection long-press is
    // already running by the time our 340ms timer fires.
    this.view.dom.classList.add(ARMED_CLASS);
    this.addGestureListeners();
    // A hold that STARTS on top of an existing selection produces no
    // `selectionchange`, so the watcher below would never see it.
    this.collapseSelection();
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
    const target = this.computeTarget(event.clientY);
    if (target) this.showIndicator(target);
    else this.hideIndicator();
    autoScrollAtEdge(this.view, event.clientY);
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
    const view = this.view;

    // Pull the rug out from under WKWebView's own long-press-to-select gesture
    // (still in flight at ~340ms; its magnifier/handles show around ~500ms).
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
    this.createGhost(clientX, clientY);
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

  private computeTarget(clientY: number): TopLevelTarget | null {
    return targetAtPointerY(this.view, clientY);
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

  private showIndicator(target: TopLevelTarget): void {
    const el = this.ensureIndicator();
    const rect = target.dom.getBoundingClientRect();
    const y = target.corner === 'before' ? rect.top : rect.bottom;
    el.style.left = `${rect.left}px`;
    el.style.width = `${rect.width}px`;
    el.style.top = `${y}px`;
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
    this.disarm();

    if (!wasDragging || !pressed) return; // a plain tap / short hold: nothing to undo

    this.cleanupDragVisuals();

    const target = commit ? this.computeTarget(clientY) : null;
    if (!target) {
      this.clearDecoration();
      return;
    }

    const view = this.view;
    const range = this.currentSourceRange(pressed);
    // Every refusal case (stale range, a target that stopped being a top-level
    // gap, a drop back at the source, a node ProseMirror would re-shape) lives
    // in moveTopLevelBlock, shared with the ⠿-handle drag path. A drop that
    // commits nothing is silent: no transaction, no history entry, no
    // 'change', and no drop haptic.
    const committed = moveTopLevelBlock(view, range, target.pos, (tr) =>
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

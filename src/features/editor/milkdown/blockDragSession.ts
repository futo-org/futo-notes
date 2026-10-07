/*
 * What a block drag looks like and does once the block is airborne — shared by
 * BOTH gestures that can lift one: the native shells' long press
 * (`mobileBlockDnd.ts`) and the desktop ⠿ handle press-and-move
 * (`handleBlockDrag.ts`). Each owns how its gesture STARTS (arming, the long
 * press timer, the movement threshold) and calls in here at lift; this owns
 * everything after: the source block dimmed in place, a ghost card drawn on the
 * page that follows the pointer by delta, the one drop indicator line at the
 * resolved gap, edge auto-scroll, and the commit through `blockMove.ts`.
 *
 * NOTHING HERE IS AN OS DRAG. The ghost is a clone of the block, drawn by the
 * page, so no platform draws its own drag image — which is the point: the
 * desktop handle used to be the browser's HTML5 drag, whose OS-drawn image came
 * out oversized on a fractionally scaled WebKitGTK display, where nothing the
 * page does can reliably fix the picture.
 *
 * The source range may be a top-level block or a list item
 * (`blockDragGeometry.ts` resolves the gaps for either).
 *
 * Gating: `blockDragSourcePlugin` is mounted for every editor (it is only the
 * state behind the dim); a session is created by whichever gesture the editor
 * got (`blockDragMode.ts`).
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import {
  createDragAutoScroller,
  dragSourceAt,
  targetAtPointerY,
  type DragAutoScroller,
  type DropTarget,
} from './blockDragGeometry';
import { isNoOpDrop, moveBlock, type BlockMoveRange } from './blockMove';
import { CURTAIN_STYLES, ReflowCurtain } from './blockDragCurtain';

/** What the gesture hands over at lift. */
export interface BlockDragLift extends BlockMoveRange {
  /** The block's live DOM — measured for the ghost's placement. */
  dom: HTMLElement;
  /** A clone of `dom` taken BEFORE the dim decoration renders: a clone taken
   * after would inherit the 35% opacity, and that same re-render can replace
   * the live node's DOM out from under the gesture. */
  clone: HTMLElement;
}

export interface BlockDragSessionOptions {
  /** The drop indicator moved to a DIFFERENT boundary (never for auto-scroll,
   * which is a hold). The long press turns it into its 'move' haptic. */
  onBoundaryChange?: () => void;
}

/** Horizontal breathing room the ghost card adds around the block's own rect,
 * so the preview reads as a card the block sits inside rather than a crop of
 * it. Mirrored as the card's own padding so the text stays put under the
 * finger. */
const GHOST_PAD_X_PX = 12;
/** Exported so the ghost-geometry regression test can assert the card's
 * position and content height against the block's own rect without keeping a
 * second copy of the number. */
export const GHOST_PAD_Y_PX = 10;
/** How much of the screen the card may cover before it is cropped.
 *
 * Applied in JS, from `window.innerHeight`, NOT as `max-height: 40vh` in the
 * stylesheet. Both native hosts render this bundle in a web view whose INITIAL
 * CONTAINING BLOCK is zero-height — the same defect `editor.html` pins the body
 * against, and the reason `milkdownEditor.css`'s bottom padding is written
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

interface BlockDragSourceState {
  decorationSet: DecorationSet;
}

export const blockDragSourceKey = new PluginKey<BlockDragSourceState>('futo-block-drag-source');

/** Injected once per page (not per editor instance/mount) — the ghost and
 * indicator live outside the ProseMirror DOM (fixed-position), so their
 * styling can't ride along with the component's scoped `<style>` block. */
let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-futo-block-drag', '');
  style.textContent = `
    .futo-mobile-dnd-source { opacity: 0.35; transition: opacity 0.12s ease; }

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
    /* The card's shadow, drawn ONCE onto a canvas at the lift (drawGhostShadow)
     * rather than as a box-shadow: WebKitGTK re-blurs a box-shadow every time
     * anything under it repaints, which cost a reflow drag ~8-14ms a frame. */
    .futo-mobile-dnd-ghost-shadow {
      position: absolute;
      pointer-events: none;
      opacity: 0;
      transform: scale(0.97);
      transition:
        transform 0.12s cubic-bezier(0.2, 0.9, 0.3, 1),
        opacity 0.12s ease;
    }
    .futo-mobile-dnd-ghost--lifted .futo-mobile-dnd-ghost-shadow {
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

    ${CURTAIN_STYLES}

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

/** The Milkdown plugin behind the source-block dim: a plugin-state
 * `DecorationSet`, mapped through every transaction, that a session sets at
 * lift and clears at the end. WebKit's DOMObserver reverts a plain
 * `classList.add` on a node INSIDE the contenteditable (it "heals" the DOM back
 * to what ProseMirror's own render last produced), so the lifted block is dimmed
 * through a DECORATION, never a direct class mutation. Mounted once per editor
 * by `useBlockDragPlugins`, whichever gesture it got. */
export const blockDragSourcePlugin = $prose(
  () =>
    new Plugin<BlockDragSourceState>({
      key: blockDragSourceKey,
      state: {
        init: () => ({ decorationSet: DecorationSet.empty }),
        apply(tr, value) {
          const meta = tr.getMeta(blockDragSourceKey) as BlockDragSourceState | undefined;
          if (meta) return meta;
          if (tr.docChanged) return { decorationSet: value.decorationSet.map(tr.mapping, tr.doc) };
          return value;
        },
      },
      props: {
        decorations(state) {
          return blockDragSourceKey.getState(state)?.decorationSet ?? null;
        },
      },
    }),
);

/** One editor's block drag after the lift. Created by the gesture that owns the
 * editor view and kept for its lifetime: `start` → `move`* → `finish`/`cancel`. */
export class BlockDragSession {
  private readonly view: ProseView;
  private readonly doc: Document;
  private readonly options: BlockDragSessionOptions;

  private lifted: BlockDragLift | null = null;
  private lastY = 0;
  private liftX = 0;
  private liftY = 0;

  /** The boundary the indicator is currently drawn at. `pos` IS the boundary's
   * whole identity (blockDragGeometry.ts), so only a CHANGE of this fires
   * `onBoundaryChange`: a finger travelling inside one gap is silent, and
   * crossing from one block's lower half into the next block's upper half — the
   * same gap — is silent too, because the bar did not move. */
  private indicatorPos: number | null = null;

  /** Continuous edge auto-scroll while dragging. Owned per editor view and
   * stopped from every exit (`finish`, `cancel`, `destroy`). */
  private readonly autoScroll: DragAutoScroller;

  /** Non-null while the live-reflow preview (`blockDragCurtain.ts`) drives this
   * drag; null falls back to the drop line. */
  private reflow: ReflowCurtain | null = null;

  private ghostEl: HTMLDivElement | null = null;
  private indicatorEl: HTMLDivElement | null = null;

  constructor(view: ProseView, options: BlockDragSessionOptions = {}) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
    this.options = options;
    this.autoScroll = createDragAutoScroller(view, this.onAutoScrollStep);
    ensureStyles();
  }

  get active(): boolean {
    return this.lifted !== null;
  }

  /** Lifts `source`: dims it, draws the ghost over it and seeds the indicator.
   * `clientX/Y` is where the pointer is at the lift. */
  start(source: BlockDragLift, clientX: number, clientY: number): void {
    if (this.lifted) return;
    const view = this.view;
    this.lifted = source;
    this.lastY = clientY;

    // Every geometry read happens up here, before the dim is dispatched or
    // anything is drawn: a read after a write lays the whole note out again
    // (~17ms a time on a 3,000-block note on a budget phone).
    const liftRect = source.dom.getBoundingClientRect();
    this.reflow = ReflowCurtain.measure(view, this.ghostHost(), source, () =>
      this.options.onBoundaryChange?.(),
    );
    /* Seeded from where the block already is, so the hold itself is silent: the
     * first tick belongs to the first boundary the finger actually reaches.
     * A resting target that is one of the block's own boundaries seeds null
     * instead (isNoOpTarget), for the same reason `syncIndicator` clears it —
     * that boundary draws no line to begin with. */
    const restingTarget = this.computeTarget(clientY);

    const decorationSet = DecorationSet.create(view.state.doc, [
      Decoration.node(
        source.from,
        source.to,
        { class: 'futo-mobile-dnd-source' },
        { futoDragSource: true },
      ),
    ]);
    view.dispatch(view.state.tr.setMeta(blockDragSourceKey, { decorationSet }));
    this.reflow?.mount();
    this.indicatorPos =
      restingTarget && !this.isNoOpTarget(restingTarget) ? restingTarget.pos : null;
    this.createGhost(clientX, clientY, liftRect);
  }

  /** The pointer moved while lifted. */
  move(clientX: number, clientY: number): void {
    if (!this.lifted) return;
    this.lastY = clientY;
    this.updateGhostPosition(clientX, clientY);
    this.syncIndicator(clientY, true);
    this.autoScroll.update(clientY);
  }

  /**
   * Ends the drag: tears the visuals down, and when `commit` is true moves the
   * block to the gap under `clientY`. Returns true only when a transaction was
   * dispatched — a drop back at the source, or any refusal `moveBlock` makes,
   * is silent. `commit=false` is the cancel path (incoming calls, system
   * gestures, Escape) and cleans up exactly like a release, with no
   * transaction.
   *
   * `beforeDispatch` runs on the move transaction (after the dim is cleared in
   * it), for a gesture that needs to place the selection.
   */
  finish(
    clientY: number,
    commit: boolean,
    beforeDispatch?: (tr: Transaction, movedTo: number, range: BlockMoveRange) => void,
  ): boolean {
    const lifted = this.lifted;
    if (!lifted) return false;
    this.autoScroll.stop();

    // The target and the range are both read BEFORE the dim is cleared: the
    // range comes from the mapped decoration. The target is also read before
    // the visuals go, because ending the reflow preview switches `computeTarget`
    // back to the line geometry.
    const target = commit ? this.computeTarget(clientY) : null;
    this.cleanupDragVisuals();
    if (!target) {
      this.clearDecoration();
      this.reset();
      return false;
    }

    const range = this.currentSourceRange(lifted);
    // Every refusal case (stale range, a target that stopped being a legal
    // gap, a drop back at the source, a node ProseMirror would re-shape) lives
    // in moveBlock. A drop that commits nothing is silent: no transaction, no
    // history entry, no 'change'.
    const committed = moveBlock(this.view, range, target.pos, (tr, movedTo) => {
      // Same transaction as the move, so the source block is never drawn
      // dimmed for a frame at its new position.
      tr.setMeta(blockDragSourceKey, { decorationSet: DecorationSet.empty });
      beforeDispatch?.(tr, movedTo, range);
    });
    if (!committed) this.clearDecoration();
    this.reset();
    return committed;
  }

  /** Ends the drag with no transaction. */
  cancel(): void {
    this.finish(this.lastY, false);
  }

  /** The editor view is going away: the ghost and the loop must not outlive it. */
  destroy(): void {
    this.autoScroll.stop();
    this.cleanupDragVisuals();
    this.lifted = null;
  }

  private reset(): void {
    this.lifted = null;
    this.indicatorPos = null;
  }

  /** Redraws the drop indicator for `clientY`, notifying once per NEW boundary
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
    if (this.reflow) {
      // False once the doc changed shape under the drag: the preview ended
      // itself, and the line takes over from the next move.
      if (!this.reflow.sync(clientY, tick)) this.reflow = null;
      return;
    }
    const target = this.computeTarget(clientY);
    if (!target || this.isNoOpTarget(target)) {
      // A no-op target (either of the lifted block's own two boundaries, or
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
    if (tick) this.options.onBoundaryChange?.();
  }

  /** True when `target` is a no-op for the block currently lifted — i.e. one
   * of its own two boundaries (`isNoOpDrop`, shared with `moveBlock`). Guards
   * the indicator/haptic layer here; a release over a no-op target was already
   * a silent no-op via `moveBlock`, this only stops the line being drawn (and
   * the card overlapping it) while the pointer is still over the block it just
   * picked up. */
  private isNoOpTarget(target: DropTarget): boolean {
    return this.lifted !== null && isNoOpDrop(this.currentSourceRange(this.lifted), target.pos);
  }

  /** After every frame edge auto-scroll actually moved the scroller. The
   * pointer has not moved, so the ghost stays put — but the boundary UNDER it
   * has changed, and the indicator (and the position a release would commit to)
   * must be recomputed from the new geometry rather than assumed. */
  private onAutoScrollStep = (): void => {
    if (!this.lifted) return;
    this.syncIndicator(this.lastY, false);
  };

  /** The lifted block's CURRENT position decides which gaps it may land in
   * (blockDragGeometry.ts): the top-level gaps for a top-level block, the gaps
   * of its list for a list item. */
  private computeTarget(clientY: number): DropTarget | null {
    if (!this.lifted) return null;
    if (this.reflow) return this.reflow.target(clientY);
    const source = dragSourceAt(this.view.state.doc, this.currentSourceRange(this.lifted).from);
    return source ? targetAtPointerY(this.view, clientY, source) : null;
  }

  /** The source block's CURRENT range. The decoration set is mapped through
   * every transaction (see the plugin's `apply`), so this survives anything
   * that edited the doc between the lift and release — autocorrect, a host
   * `setContent`, the trailing-paragraph plugin. The lift-time positions are
   * only the fallback. */
  private currentSourceRange(lifted: BlockDragLift): BlockMoveRange {
    const decorations = blockDragSourceKey.getState(this.view.state)?.decorationSet;
    const found = decorations?.find(
      undefined,
      undefined,
      (spec: { futoDragSource?: boolean }) => spec.futoDragSource === true,
    );
    if (found && found.length === 1) return { from: found[0].from, to: found[0].to };
    return { from: lifted.from, to: lifted.to };
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

  /** `rect` is the lifted block's, read before anything was drawn. */
  private createGhost(clientX: number, clientY: number, rect: DOMRect): void {
    const lifted = this.lifted;
    if (!lifted) return;

    const clone = lifted.clone;
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
    drawGhostShadow(ghost, card);

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
    this.reflow?.end();
    this.reflow = null;
    this.ghostEl?.remove();
    this.ghostEl = null;
    this.indicatorEl?.remove();
    this.indicatorEl = null;
  }

  private clearDecoration(): void {
    const view = this.view;
    view.dispatch(
      view.state.tr.setMeta(blockDragSourceKey, { decorationSet: DecorationSet.empty }),
    );
  }
}

/** The card's three box-shadows (the old CSS values), as [offsetY, blur, alpha]. */
const GHOST_SHADOWS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 2, 0.12],
  [6, 14, 0.16],
  [20, 44, 0.24],
];
const GHOST_RADIUS_PX = 14;

/** Paints the card's shadow once, onto a canvas behind it, sized to the card's
 * laid-out box plus room for the widest blur. The card is translucent and a
 * box-shadow is never drawn under its own box, so the card's area is cut back
 * out of the canvas. */
function drawGhostShadow(ghost: HTMLElement, card: HTMLElement): void {
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const margin = Math.max(...GHOST_SHADOWS.map(([y, blur]) => y + blur)) + 4;
  const dpr = window.devicePixelRatio || 1;
  const canvas = ghost.ownerDocument.createElement('canvas');
  canvas.className = 'futo-mobile-dnd-ghost-shadow';
  canvas.width = Math.ceil((width + margin * 2) * dpr);
  canvas.height = Math.ceil((height + margin * 2) * dpr);
  canvas.style.width = `${width + margin * 2}px`;
  canvas.style.height = `${height + margin * 2}px`;
  canvas.style.left = `${-margin}px`;
  canvas.style.top = `${-margin}px`;
  // The card scales about (50%, 40%) of ITSELF; the canvas is the card plus a
  // margin all round, so the same point sits `margin` further in.
  canvas.style.transformOrigin = `50% ${margin + height * 0.4}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Shadows are drawn by an off-canvas shape whose shadow is offset back into
  // view, so only the shadow lands. Shadow offset and blur ignore the
  // transform, hence the explicit device-pixel factors.
  const away = canvas.width + 1000;
  for (const [offsetY, blur, alpha] of GHOST_SHADOWS) {
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
    ctx.shadowBlur = blur * dpr;
    ctx.shadowOffsetX = away;
    ctx.shadowOffsetY = offsetY * dpr;
    ctx.beginPath();
    ctx.roundRect(
      margin * dpr - away,
      margin * dpr,
      width * dpr,
      height * dpr,
      GHOST_RADIUS_PX * dpr,
    );
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.roundRect(margin * dpr, margin * dpr, width * dpr, height * dpr, GHOST_RADIUS_PX * dpr);
  ctx.fill();
  ghost.insertBefore(canvas, ghost.firstChild);
}

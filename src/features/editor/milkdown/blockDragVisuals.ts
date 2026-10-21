import { DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { ReflowCurtain } from './blockDragCurtain';
import type { BlockDragLift } from './blockDragSession';
import { blockDragSourceKey } from './blockDragSource';
import type { DropTarget } from './blockDragGeometry';

/** Horizontal breathing room the ghost card adds around the block's own rect,
 * so the preview reads as a card the block sits inside rather than a crop of
 * it. Mirrored as the card's own padding so the text stays put under the
 * finger. */
export const GHOST_PAD_X_PX = 12;
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
export const GHOST_SCALE = 1.04;
/** Keep the SCALED card off the screen edges. */
const GHOST_VIEWPORT_MARGIN_PX = 4;

/** The lifted block's look while it is airborne: the ghost card that follows the
 * pointer, the drop line, and taking them (and the dim) down again. */
export abstract class BlockDragVisuals {
  protected readonly view: ProseView;
  protected readonly doc: Document;

  protected lifted: BlockDragLift | null = null;
  protected liftX = 0;
  protected liftY = 0;

  /** Non-null while the live-reflow preview (`blockDragCurtain.ts`) drives this
   * drag; null falls back to the drop line. */
  protected reflow: ReflowCurtain | null = null;

  protected ghostEl: HTMLDivElement | null = null;
  protected indicatorEl: HTMLDivElement | null = null;

  protected constructor(view: ProseView) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
  }

  /** The ghost host is the `.futo-milkdown` container (OUTSIDE the
   * contenteditable, so no DOMObserver interference) rather than document.body:
   * the card carries the `ProseMirror` class, and the component's scoped
   * `.futo-milkdown .ProseMirror <element>` typography only applies inside
   * that container. Under document.body the clone rendered with bare UA
   * styling — the "too timid" preview. */
  protected ghostHost(): HTMLElement {
    return this.view.dom.closest('.futo-milkdown') ?? this.doc.body;
  }

  /** `rect` is the lifted block's, read before anything was drawn. */
  protected createGhost(clientX: number, clientY: number, rect: DOMRect): void {
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
    // still clears both screen edges (the scale grows it about its center, so
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

  protected updateGhostPosition(clientX: number, clientY: number): void {
    if (!this.ghostEl) return;
    const dx = clientX - this.liftX;
    const dy = clientY - this.liftY;
    // Translation lives on the OUTER element and the pop scale on the inner
    // card, so dragging is never animated through the card's 120ms transition.
    this.ghostEl.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  protected ensureIndicator(): HTMLDivElement {
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
   * (blockDragGeometry.ts). The `margin-top` in the stylesheet re-centers the
   * 3px bar on `top`. */
  protected showIndicator(target: DropTarget): void {
    const el = this.ensureIndicator();
    el.style.left = `${target.indicator.left}px`;
    el.style.width = `${target.indicator.width}px`;
    el.style.top = `${target.indicator.top}px`;
    el.classList.add('futo-mobile-dnd-indicator--visible');
  }

  protected hideIndicator(): void {
    this.indicatorEl?.classList.remove('futo-mobile-dnd-indicator--visible');
  }

  protected cleanupDragVisuals(): void {
    this.reflow?.end();
    this.reflow = null;
    this.ghostEl?.remove();
    this.ghostEl = null;
    this.indicatorEl?.remove();
    this.indicatorEl = null;
  }

  protected clearDecoration(): void {
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

/** Begins a path of a rounded rectangle. `roundRect` is Chromium 99; the
 * Android WebView floor is 80, so older engines get the same shape from four
 * `arcTo` corners. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

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
    roundedRectPath(
      ctx,
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
  roundedRectPath(
    ctx,
    margin * dpr,
    margin * dpr,
    width * dpr,
    height * dpr,
    GHOST_RADIUS_PX * dpr,
  );
  ctx.fill();
  ghost.insertBefore(canvas, ghost.firstChild);
}

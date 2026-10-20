import { CURTAIN_STYLES } from './blockDragCurtain';
import { GHOST_PAD_X_PX, GHOST_PAD_Y_PX, GHOST_SCALE } from './blockDragVisuals';

/** Injected once per page (not per editor instance/mount) — the ghost and
 * indicator live outside the ProseMirror DOM (fixed-position), so their
 * styling can't ride along with the component's scoped `<style>` block. */
let stylesInjected = false;
export function ensureStyles(): void {
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

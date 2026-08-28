/*
 * Touch/pen drag for the ⠿ gutter handle (desktop browser + Android).
 *
 * The handle's own drag mechanism, supplied by @milkdown/plugin-block's
 * BlockProvider, is native HTML5 DnD (`draggable`/`dragstart`). A MOUSE gets
 * that for free and this module deliberately never touches it. A FINGER does
 * not: WKWebView never initiates HTML5 drag for touch on the iPhone idiom
 * (`UIDragInteraction.isEnabled` defaults to false there), and Android's
 * WebView is unreliable about it too, so no real `dragstart` ever fires.
 *
 * The iOS shell replaces the handle entirely with the long-press path in
 * `mobileBlockDnd.ts`; this is the fallback for everything else.
 *
 * An earlier version drove ProseMirror's own core `drop` handler (synthetic
 * DragEvents + `view.dragging`) so the move landed as one transaction "for
 * free". That reuse had a real bug: `handleDrop`'s `dropPoint()` snapping picks
 * the nearest SCHEMA-VALID position for the dragged slice, not the nearest
 * TOP-LEVEL boundary — so dropping a paragraph just below a blockquote landed
 * it INSIDE the blockquote. Target resolution therefore goes through
 * `blockDragGeometry.ts` and the commit through `blockMove.ts`, exactly like
 * the iOS path. The drop indicator is rendered from the SAME resolved boundary
 * (a small custom element, not the `.use(cursor)` one — that plugin only draws
 * where `dropPoint()` would land, which is the position this path deliberately
 * does not use), so what the user sees always matches where the drop lands.
 */
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { contentColumnX, resolveTopLevelTarget, type TopLevelTarget } from './blockDragGeometry';
import { moveTopLevelBlock } from './blockMove';

const TOUCH_DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_STEP_PX = 14;

/** The block the ⠿ handle is currently showing for (BlockProvider's `active`). */
export interface ActiveBlock {
  el: HTMLElement;
  /** Position immediately before the block. */
  pos: number;
  size: number;
}

export interface HandleBlockDragOptions {
  /** The `.futo-milkdown` container the drop indicator is positioned inside. */
  container: HTMLElement;
  getView: () => ProseView | null;
  getActiveBlock: () => ActiveBlock | null;
  /**
   * Auto-scroll below moves `view.dom.scrollTop` directly, which fires a native
   * `scroll` event — the component's scroll handler hides the handle, which
   * would flicker it away mid-drag. Suspended for the drag's duration.
   */
  setScrollHideSuspended: (suspended: boolean) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  sourceEl: HTMLElement | null;
  /**
   * Position immediately before the dragged top-level block, and its size, both
   * captured at drag start. `moveTopLevelBlock` re-validates them at drop time
   * rather than trusting them, so an edit that arrives mid-drag (a sync pull,
   * say) cancels the move instead of relocating the wrong node.
   */
  sourceStart: number;
  sourceSize: number;
}

export interface HandleBlockDrag {
  /** Wires the drag listeners onto the handle element BlockProvider renders. */
  attach: (handleEl: HTMLElement) => void;
  /** Removes the listeners and any drop indicator. Safe to call twice. */
  destroy: () => void;
}

export function createHandleBlockDrag(options: HandleBlockDragOptions): HandleBlockDrag {
  const { container, getView, getActiveBlock, setScrollHideSuspended } = options;

  let handleEl: HTMLElement | null = null;
  let drag: DragState | null = null;
  let indicatorEl: HTMLDivElement | null = null;

  function ensureIndicator(): HTMLDivElement {
    if (!indicatorEl) {
      const el = document.createElement('div');
      el.className = 'milkdown-touch-drop-indicator';
      el.setAttribute('aria-hidden', 'true');
      container.appendChild(el);
      indicatorEl = el;
    }
    return indicatorEl;
  }

  function showIndicator(target: TopLevelTarget): void {
    const el = ensureIndicator();
    const containerRect = container.getBoundingClientRect();
    const domRect = target.dom.getBoundingClientRect();
    const y = target.corner === 'before' ? domRect.top : domRect.bottom;
    el.style.left = `${domRect.left - containerRect.left}px`;
    el.style.width = `${domRect.width}px`;
    el.style.top = `${y - containerRect.top}px`;
    el.classList.add('milkdown-touch-drop-indicator--visible');
  }

  function hideIndicator(): void {
    indicatorEl?.classList.remove('milkdown-touch-drop-indicator--visible');
  }

  /** The drop boundary for a pointer at `clientY`, clamped into the editor. */
  function targetAt(view: ProseView, clientY: number): TopLevelTarget | null {
    const rect = view.dom.getBoundingClientRect();
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
    return resolveTopLevelTarget(view, contentColumnX(view), y);
  }

  function beginDrag(): void {
    const state = drag;
    if (!state) return;
    const active = getActiveBlock();
    if (!active) {
      // Nothing hovered (the handle was tapped without a prior tap/selection
      // nudging it onto a block) — leave `dragging` false so pointerup treats
      // this as a no-op tap rather than a drag with no source.
      return;
    }
    state.dragging = true;
    state.sourceEl = active.el;
    state.sourceStart = active.pos;
    state.sourceSize = active.size;
    state.sourceEl.classList.add('milkdown-block-drag-source');
    setScrollHideSuspended(true);
  }

  const onPointerDown = (event: PointerEvent): void => {
    // Mouse keeps the native HTML5 DnD path untouched — this fallback is
    // touch/pen only, and the two must never both fire for one gesture.
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (drag) return; // a second simultaneous touch on the handle
    const target = event.currentTarget as HTMLElement;
    event.preventDefault();
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Rare (pointer already released); the drag just won't track off-element.
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      sourceEl: null,
      sourceStart: 0,
      sourceSize: 0,
    };
  };

  const onPointerMove = (event: PointerEvent): void => {
    const state = drag;
    if (!state || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    const view = getView();
    if (!view) return;

    if (!state.dragging) {
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (Math.hypot(dx, dy) < TOUCH_DRAG_THRESHOLD_PX) return;
      beginDrag();
      if (!state.dragging) return; // no active block to drag (see beginDrag)
    }

    const target = targetAt(view, event.clientY);
    if (target) showIndicator(target);

    // Rudimentary auto-scroll: `.ProseMirror` (view.dom) owns overflow-y.
    const rect = view.dom.getBoundingClientRect();
    if (event.clientY - rect.top < AUTO_SCROLL_EDGE_PX) {
      view.dom.scrollTop = Math.max(0, view.dom.scrollTop - AUTO_SCROLL_STEP_PX);
    } else if (rect.bottom - event.clientY < AUTO_SCROLL_EDGE_PX) {
      view.dom.scrollTop += AUTO_SCROLL_STEP_PX;
    }
  };

  function endDrag(event: PointerEvent, commit: boolean): void {
    const state = drag;
    if (!state || event.pointerId !== state.pointerId) return;
    drag = null;
    state.sourceEl?.classList.remove('milkdown-block-drag-source');
    hideIndicator();
    if (handleEl) {
      try {
        handleEl.releasePointerCapture(event.pointerId);
      } catch {
        // Already released (e.g. the handle was hidden mid-drag) — fine.
      }
    }
    if (!state.dragging) return; // never crossed the threshold: a no-op tap

    setScrollHideSuspended(false);
    const view = getView();
    if (!commit || !view) return; // pointercancel, or the view vanished: abort cleanly

    const target = targetAt(view, event.clientY);
    if (!target) return;
    moveTopLevelBlock(
      view,
      { from: state.sourceStart, to: state.sourceStart + state.sourceSize },
      target.pos,
    );
  }

  const onPointerUp = (event: PointerEvent): void => endDrag(event, true);
  const onPointerCancel = (event: PointerEvent): void => endDrag(event, false);

  return {
    attach(el: HTMLElement): void {
      handleEl = el;
      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('pointermove', onPointerMove, { passive: false });
      el.addEventListener('pointerup', onPointerUp);
      el.addEventListener('pointercancel', onPointerCancel);
    },
    destroy(): void {
      if (handleEl) {
        handleEl.removeEventListener('pointerdown', onPointerDown);
        handleEl.removeEventListener('pointermove', onPointerMove);
        handleEl.removeEventListener('pointerup', onPointerUp);
        handleEl.removeEventListener('pointercancel', onPointerCancel);
        handleEl = null;
      }
      drag = null;
      indicatorEl?.remove();
      indicatorEl = null;
    },
  };
}

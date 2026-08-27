/*
 * Notion-style mobile block drag-and-drop (SPIKE) — the iOS long-press path.
 *
 * MilkdownEditor.svelte's desktop/Android touch fallback drives drag off a
 * dedicated ⠿ gutter handle (BlockProvider). On iPhone the product ask is
 * different: there is no handle at all — THE BLOCK ITSELF is the handle.
 * Touch-and-hold a block (~330-350ms; any real movement before the timer
 * cancels it, so ordinary scrolling is untouched) lifts it (scale + shadow +
 * a haptic), dragging floats a ghost under the finger with a drop-indicator
 * line at the resolved top-level boundary, and release commits the move as
 * ONE transaction (a second haptic) or, dropped back at the source, is a
 * true no-op: no transaction, no history entry, no bridge 'change' message.
 *
 * Two hard-won constraints from the desktop/Android path carry over exactly:
 *
 *  - The iOS text-selection long-press fires at ~500ms inside a
 *    contenteditable. This plugin's timer fires first (~340ms) and, on
 *    firing, collapses any selection and disables `-webkit-user-select` on
 *    the ProseMirror root for the drag's duration — winning the race instead
 *    of coexisting with it. Only `touchmove` (not `pointermove`) reliably
 *    suppresses WKWebView's native scroll/selection gesture once dragging,
 *    hence the separate non-passive `touchmove` listener below.
 *  - WebKit's DOMObserver reverts a plain `classList.add` on a node inside
 *    the contenteditable (it "heals" the DOM back to what ProseMirror's own
 *    render last produced), so the lifted block is dimmed via a ProseMirror
 *    DECORATION (rendered through the normal state->DOM sync pass), never a
 *    direct class mutation.
 *
 * Drop-target resolution reuses `resolveTopLevelTarget`/`topLevelBlockAt`
 * from `blockDragGeometry.ts` — the same top-level-boundary walk the
 * desktop/Android fallback uses, so both paths agree on where a block can
 * land (never nested inside a blockquote/list the way ProseMirror's own
 * `dropPoint()` would snap it).
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
  contentColumnX,
  resolveTopLevelTarget,
  topLevelBlockAt,
  type TopLevelTarget,
} from './blockDragGeometry';

export type MobileDndHapticKind = 'lift' | 'drop';

export interface MobileBlockDndOptions {
  /** Fired once on lift and once on a committed (non-no-op) drop. */
  onHaptic: (kind: MobileDndHapticKind) => void;
  /** Stationary hold (ms) before a touch lifts a block. Default 340 — must
   * beat iOS's own ~500ms text-selection long-press (see module doc). */
  longPressMs?: number;
  /** Movement (px) before the timer fires that cancels the pending lift and
   * lets the gesture pass through as an ordinary scroll. */
  moveCancelPx?: number;
}

const DEFAULT_LONG_PRESS_MS = 340;
const DEFAULT_MOVE_CANCEL_PX = 10;
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_STEP_PX = 14;

interface MobileDndPluginState {
  decorationSet: DecorationSet;
}

const mobileBlockDndKey = new PluginKey<MobileDndPluginState>('futo-mobile-block-dnd');

/** Injected once per page (not per editor instance/mount) — the ghost and
 * indicator live outside the ProseMirror DOM (fixed-position, appended to
 * `document.body`), so their styling can't ride along with the component's
 * scoped `<style>` block. */
let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-futo-mobile-block-dnd', '');
  style.textContent = `
    .futo-mobile-dnd-source { opacity: 0.35; transition: opacity 0.12s ease; }
    .futo-mobile-dnd-ghost {
      position: fixed;
      left: 0;
      top: 0;
      margin: 0;
      pointer-events: none;
      z-index: 1000;
      opacity: 0.92;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22), 0 2px 6px rgba(0, 0, 0, 0.16);
      border-radius: 6px;
      background: var(--color-bg, #ffffff);
      will-change: transform;
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

type PressedBlock = { pos: number; size: number; dom: HTMLElement };

/** Owns the whole long-press/lift/drag/drop state machine for one editor
 * instance. Constructed as this Plugin's `view()` (a ProseMirror PluginView),
 * so its lifetime matches the editor view's. */
class MobileBlockDndView {
  private readonly view: ProseView;
  private readonly options: Required<MobileBlockDndOptions>;

  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dragging = false;
  private pressed: PressedBlock | null = null;

  private ghostEl: HTMLDivElement | null = null;
  private indicatorEl: HTMLDivElement | null = null;
  private liftX = 0;
  private liftY = 0;

  constructor(view: ProseView, options: MobileBlockDndOptions) {
    this.view = view;
    this.options = {
      onHaptic: options.onHaptic,
      longPressMs: options.longPressMs ?? DEFAULT_LONG_PRESS_MS,
      moveCancelPx: options.moveCancelPx ?? DEFAULT_MOVE_CANCEL_PX,
    };
    ensureStyles();
    view.dom.addEventListener('pointerdown', this.onPointerDown);
    view.dom.addEventListener('pointermove', this.onPointerMove);
    view.dom.addEventListener('pointerup', this.onPointerUp);
    view.dom.addEventListener('pointercancel', this.onPointerCancel);
    // touchmove must be a non-passive LISTENER (not just pointermove) to
    // preventDefault WKWebView's native scroll/selection once dragging.
    view.dom.addEventListener('touchmove', this.onTouchMove, { passive: false });
  }

  destroy(): void {
    this.cancelTimer();
    this.cleanupDragVisuals();
    this.view.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.view.dom.removeEventListener('pointermove', this.onPointerMove);
    this.view.dom.removeEventListener('pointerup', this.onPointerUp);
    this.view.dom.removeEventListener('pointercancel', this.onPointerCancel);
    this.view.dom.removeEventListener('touchmove', this.onTouchMove);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (this.pointerId !== null) return; // a second simultaneous touch
    const block = topLevelBlockAt(this.view, event.clientX, event.clientY);
    if (!block) return;
    this.pointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.dragging = false;
    this.pressed = { pos: block.pos, size: block.node.nodeSize, dom: block.dom };
    this.cancelTimer();
    const { clientX, clientY } = event;
    this.timer = setTimeout(() => this.beginLift(clientX, clientY), this.options.longPressMs);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;

    if (!this.dragging) {
      const dx = event.clientX - this.startX;
      const dy = event.clientY - this.startY;
      if (Math.hypot(dx, dy) >= this.options.moveCancelPx) {
        // Real movement before the timer fired — an ordinary scroll, not a
        // drag. We never called preventDefault, so native scrolling already
        // owns this gesture; just stop waiting to lift.
        this.cancelTimer();
        this.pointerId = null;
        this.pressed = null;
      }
      return;
    }

    this.updateGhostPosition(event.clientX, event.clientY);
    const target = this.computeTarget(event.clientY);
    if (target) this.showIndicator(target);
    else this.hideIndicator();
    this.autoScroll(event.clientY);
  };

  private onPointerUp = (event: PointerEvent): void => this.finishGesture(event, true);
  private onPointerCancel = (event: PointerEvent): void => this.finishGesture(event, false);

  /** touchmove is what actually needs suppressing on WKWebView; pointermove
   * alone does not reliably stop the native scroll/selection gesture. */
  private onTouchMove = (event: TouchEvent): void => {
    if (this.dragging) event.preventDefault();
  };

  private beginLift(clientX: number, clientY: number): void {
    this.timer = null;
    if (this.pointerId === null || !this.pressed) return;
    const view = this.view;

    // Collapse any live selection so the drag isn't fighting a range, and —
    // more importantly — pull the rug out from under WKWebView's own
    // long-press-to-select gesture (which is still in flight at ~340ms; its
    // magnifying glass/handles show around ~500ms).
    if (!view.state.selection.empty) {
      const pos = view.state.selection.from;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    }
    view.dom.style.setProperty('-webkit-user-select', 'none');
    view.dom.style.setProperty('user-select', 'none');

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

  private createGhost(clientX: number, clientY: number): void {
    const pressed = this.pressed;
    if (!pressed) return;
    const rect = pressed.dom.getBoundingClientRect();
    const clone = pressed.dom.cloneNode(true) as HTMLElement;
    const ghost = document.createElement('div');
    ghost.className = 'futo-mobile-dnd-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.appendChild(clone);
    document.body.appendChild(ghost);
    this.ghostEl = ghost;
    this.liftX = clientX;
    this.liftY = clientY;
  }

  private updateGhostPosition(clientX: number, clientY: number): void {
    if (!this.ghostEl) return;
    const dx = clientX - this.liftX;
    const dy = clientY - this.liftY;
    this.ghostEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.02)`;
  }

  private computeTarget(clientY: number): TopLevelTarget | null {
    const view = this.view;
    const rect = view.dom.getBoundingClientRect();
    const x = contentColumnX(view);
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
    return resolveTopLevelTarget(view, x, y);
  }

  private ensureIndicator(): HTMLDivElement {
    if (!this.indicatorEl) {
      const el = document.createElement('div');
      el.className = 'futo-mobile-dnd-indicator';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
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

  private autoScroll(clientY: number): void {
    const view = this.view;
    const rect = view.dom.getBoundingClientRect();
    if (clientY - rect.top < AUTO_SCROLL_EDGE_PX) {
      view.dom.scrollTop = Math.max(0, view.dom.scrollTop - AUTO_SCROLL_STEP_PX);
    } else if (rect.bottom - clientY < AUTO_SCROLL_EDGE_PX) {
      view.dom.scrollTop += AUTO_SCROLL_STEP_PX;
    }
  }

  private cleanupDragVisuals(): void {
    this.ghostEl?.remove();
    this.ghostEl = null;
    this.indicatorEl?.remove();
    this.indicatorEl = null;
    this.view.dom.style.removeProperty('-webkit-user-select');
    this.view.dom.style.removeProperty('user-select');
  }

  private clearDecoration(): void {
    const view = this.view;
    view.dispatch(view.state.tr.setMeta(mobileBlockDndKey, { decorationSet: DecorationSet.empty }));
  }

  /** Shared tail for pointerup (`commit=true`) and pointercancel
   * (`commit=false`, which WILL happen — incoming calls, system gestures —
   * and must clean up exactly like a normal release with no transaction). */
  private finishGesture(event: PointerEvent, commit: boolean): void {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.cancelTimer();
    const wasDragging = this.dragging;
    const pressed = this.pressed;
    this.pointerId = null;
    this.pressed = null;
    this.dragging = false;

    if (!wasDragging || !pressed) return; // a plain tap / short hold: nothing to undo

    this.cleanupDragVisuals();

    const target = commit ? this.computeTarget(event.clientY) : null;
    if (!target) {
      this.clearDecoration();
      return;
    }

    const srcStart = pressed.pos;
    const srcEnd = srcStart + pressed.size;
    if (target.pos >= srcStart && target.pos <= srcEnd) {
      // Dropped back onto/within its own range: a genuine no-op per the
      // product spec — no transaction, no history entry, no 'change'.
      this.clearDecoration();
      return;
    }

    const view = this.view;
    const beforeDoc = view.state.doc;
    const slice = beforeDoc.slice(srcStart, srcEnd);
    let tr = view.state.tr.delete(srcStart, srcEnd);
    const mappedTarget = tr.mapping.map(target.pos);
    tr = tr.insert(mappedTarget, slice.content);
    tr.setMeta(mobileBlockDndKey, { decorationSet: DecorationSet.empty });
    if (!tr.doc.eq(beforeDoc)) {
      view.dispatch(tr);
      this.options.onHaptic('drop');
    } else {
      this.clearDecoration();
    }
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

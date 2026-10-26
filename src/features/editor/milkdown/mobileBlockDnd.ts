import { $prose } from '@milkdown/kit/utils';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { topLevelBlockAt } from './blockDragGeometry';
import { BlockDragSession } from './blockDragSession';
import {
  ARMED_CLASS,
  DEFAULT_LONG_PRESS_MS,
  DEFAULT_MOVE_CANCEL_PX,
  FOCUS_GUARD_MS,
  HIDE_SELECTION_CLASS,
  ensureStyles,
  needsSelectionNet,
  type MobileBlockDndOptions,
} from './mobileBlockDndConfig';

export {
  DEFAULT_LONG_PRESS_MS,
  needsSelectionNet,
  type MobileBlockDndOptions,
  type MobileDndHapticKind,
} from './mobileBlockDndConfig';

const liveViews = new Set<MobileBlockDndView>();

/** A host focus is intentional, even just after a held block press. */
export function dropBlockDndFocusGuards(): void {
  for (const view of liveViews) view.dropFocusGuard();
}

interface PressedBlock {
  pos: number;
  size: number;
  dom: HTMLElement;
  clone: HTMLElement;
  liftable: boolean;
}

/** The native long-press gesture; BlockDragSession owns everything after lift. */
export class MobileBlockDndView {
  private readonly doc: Document;
  private readonly options: Required<MobileBlockDndOptions>;
  private readonly session: BlockDragSession;
  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private lastY = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dragging = false;
  private heldPastThreshold = false;
  private pendingMove: { x: number; y: number } | null = null;
  private moveFrame: number | null = null;
  private pressed: PressedBlock | null = null;

  constructor(
    private readonly view: ProseView,
    options: MobileBlockDndOptions,
  ) {
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

  // The source decoration can detach the pressed node. Document capture keeps
  // receiving its touch stream, including when the finger leaves the editor.
  private addGestureListeners(): void {
    const doc = this.doc;
    doc.addEventListener('pointermove', this.onPointerMove, true);
    doc.addEventListener('pointerup', this.onPointerUp, true);
    doc.addEventListener('pointercancel', this.onPointerCancel, true);
    doc.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false });
    doc.addEventListener('touchend', this.onTouchEnd, true);
    doc.addEventListener('touchcancel', this.onTouchEnd, true);
    doc.addEventListener('selectstart', this.onSelectStart, true);
    doc.addEventListener('contextmenu', this.onContextMenu, true);
    doc.addEventListener('selectionchange', this.onSelectionChange);
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

  private disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.cancelMoveFrame();
    this.removeGestureListeners();
    const wasArmed = this.pointerId !== null;
    const wasDragging = this.dragging;
    this.pointerId = null;
    this.pressed = null;
    this.dragging = false;
    this.heldPastThreshold = false;
    this.view.dom.classList.remove(ARMED_CLASS, HIDE_SELECTION_CLASS);
    // Release the stronger native suspension first; every exit passes here.
    if (wasDragging) this.options.onDragActive(false);
    if (wasArmed) this.options.onPressActive(false);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (this.pointerId !== null) return;
    this.dropFocusGuard();
    // Focused presses belong entirely to the platform's text selection. Every
    // armed press therefore starts unfocused and must stay so through release.
    if (this.view.hasFocus()) return;
    const block = topLevelBlockAt(this.view, event.clientX, event.clientY);
    if (!block) return;
    this.pointerId = event.pointerId;
    // Ask the shell at touch-down, before WKWebView commits its own long press.
    this.options.onPressActive(true);
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.lastY = event.clientY;
    this.dragging = false;
    this.pressed = {
      pos: block.pos,
      size: block.node.nodeSize,
      dom: block.dom,
      // Clone before the dim decoration can replace or fade the source DOM.
      clone: block.dom.cloneNode(true) as HTMLElement,
      liftable: !(block.node.isTextblock && block.node.content.size === 0),
    };
    this.view.dom.classList.add(ARMED_CLASS);
    if (needsSelectionNet()) this.view.dom.classList.add(HIDE_SELECTION_CLASS);
    this.addGestureListeners();
    // A press on an existing selection need not emit selectionchange.
    this.collapseSelection();
    // Empty blocks still time the hold: they never lift, but releasing a hold
    // must absorb the native click's focus while releasing a tap must not.
    const { clientX, clientY } = event;
    this.timer = setTimeout(() => this.beginLift(clientX, clientY), this.options.longPressMs);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.lastY = event.clientY;
    if (!this.dragging) {
      if (
        Math.hypot(event.clientX - this.startX, event.clientY - this.startY) >=
        this.options.moveCancelPx
      ) {
        this.disarm();
      }
      return;
    }
    // WKWebView can deliver more pointer samples than display frames.
    this.pendingMove = { x: event.clientX, y: event.clientY };
    if (this.moveFrame !== null) return;
    this.moveFrame = (this.doc.defaultView ?? window).requestAnimationFrame(() => {
      this.moveFrame = null;
      const at = this.pendingMove;
      this.pendingMove = null;
      if (this.dragging && at) this.session.move(at.x, at.y);
    });
  };

  private cancelMoveFrame(): void {
    if (this.moveFrame !== null) {
      (this.doc.defaultView ?? window).cancelAnimationFrame(this.moveFrame);
      this.moveFrame = null;
    }
    this.pendingMove = null;
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.finish(event.clientY, true);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.finish(event.clientY, false);
  };

  // Pointer cancellation alone does not stop WKWebView scrolling a touch.
  private onTouchMove = (event: TouchEvent): void => {
    if (this.dragging) event.preventDefault();
  };

  private onTouchEnd = (event: TouchEvent): void => {
    if (this.pointerId === null || event.touches.length > 0) return;
    const commit = event.type === 'touchend';
    // pointerup normally wins. A missing one must not strand suppression.
    setTimeout(() => {
      if (this.pointerId !== null) this.finish(this.lastY, commit);
    }, 0);
  };

  private beginLift(clientX: number, clientY: number): void {
    this.timer = null;
    if (this.pointerId === null || !this.pressed) return;
    this.heldPastThreshold = true;
    if (!this.pressed.liftable || this.session.landingDrop) return;
    this.collapseSelection();
    const pressed = this.pressed;
    this.session.start(
      { from: pressed.pos, to: pressed.pos + pressed.size, dom: pressed.dom, clone: pressed.clone },
      clientX,
      clientY,
    );
    this.dragging = true;
    this.options.onDragActive(true);
    this.options.onHaptic('lift');
  }

  private finish(clientY: number, commit: boolean): void {
    const wasDragging = this.dragging;
    const guardFocusOnRelease = this.heldPastThreshold;
    this.disarm();
    if (guardFocusOnRelease) this.guardFocusBriefly(!wasDragging);
    if (wasDragging && this.session.finish(clientY, commit)) this.options.onHaptic('drop');
  }

  private onSelectStart = (event: Event): void => {
    if (this.pointerId !== null) event.preventDefault();
  };

  private onContextMenu = (event: Event): void => {
    if (this.pointerId !== null) event.preventDefault();
  };

  private onSelectionChange = (): void => {
    if (this.pointerId !== null) this.collapseSelection();
  };

  private onFocusCapture = (event: FocusEvent): void => {
    if (this.pointerId === null) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !this.view.dom.contains(target)) return;
    // Chromium focuses on long press even when selectstart was canceled. Keep
    // this focus from reaching the editor's bridge listener before blurring it.
    event.stopPropagation();
    target.blur();
  };

  private guardFocusBriefly(untilClick: boolean): void {
    this.dropFocusGuard();
    const handler = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !this.view.dom.contains(target)) return;
      event.stopPropagation();
      target.blur();
      this.dropFocusGuard();
    };
    this.doc.addEventListener('focus', handler, true);
    // A stationary hold's native click is a later task that can arrive after
    // several frames. A moved drag emits no click, so its guard lasts one frame.
    const timer = untilClick ? setTimeout(() => this.dropFocusGuard(), FOCUS_GUARD_MS) : null;
    const frame = untilClick ? null : requestAnimationFrame(() => this.dropFocusGuard());
    this.dropFocusGuard = () => {
      if (timer !== null) clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
      this.doc.removeEventListener('focus', handler, true);
      this.dropFocusGuard = () => {};
    };
  }

  dropFocusGuard: () => void = () => {};

  private collapseSelection(): void {
    const view = this.view;
    if (!view.state.selection.empty) {
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.from)),
      );
    }
    // WebKit may hold a DOM range ProseMirror has not read yet.
    const selection = this.doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    if (!selection.anchorNode || !view.dom.contains(selection.anchorNode)) return;
    try {
      selection.collapseToStart();
    } catch {
      // A detached node is transient; the next selectionchange retries.
    }
  }
}

export function createMobileBlockDndPlugin(options: MobileBlockDndOptions) {
  return $prose(() => new Plugin({ view: (view) => new MobileBlockDndView(view, options) }));
}

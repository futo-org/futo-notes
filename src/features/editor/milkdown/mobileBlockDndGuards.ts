import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import {
  DEFAULT_LONG_PRESS_MS,
  DEFAULT_MOVE_CANCEL_PX,
  FOCUS_GUARD_MS,
  type MobileBlockDndOptions,
} from './mobileBlockDndConfig';

export const liveViews = new Set<{ dropFocusGuard: () => void }>();

/** A host `focus()` is intentional, so it must never be swallowed by a release
 * guard still waiting for a native click: the editor's `focus()` calls this first. */
export function dropBlockDndFocusGuards(): void {
  for (const view of liveViews) view.dropFocusGuard();
}

/** The press's guards: keeping a held block press from selecting text, and from
 * focusing the editor (or raising the keyboard) whether or not it lifts. */
export abstract class MobileBlockDndGuards {
  protected readonly view: ProseView;
  protected readonly options: Required<MobileBlockDndOptions>;
  protected readonly doc: Document;

  protected pointerId: number | null = null;
  /** True when the editor already held focus at the moment this press
   * started. Decides whether `onFocusCapture` undoes a focus that lands mid-
   * press (module doc's "a block press must never focus the editor"). */
  protected pressWasFocused = false;

  protected constructor(view: ProseView, options: MobileBlockDndOptions) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
    this.options = {
      onHaptic: options.onHaptic,
      onDragActive: options.onDragActive ?? (() => {}),
      onPressActive: options.onPressActive ?? (() => {}),
      longPressMs: options.longPressMs ?? DEFAULT_LONG_PRESS_MS,
      moveCancelPx: options.moveCancelPx ?? DEFAULT_MOVE_CANCEL_PX,
    };
  }

  /* ---- selection suppression -------------------------------------------- */

  protected onSelectStart = (event: Event): void => {
    if (this.pointerId === null) return;
    event.preventDefault();
  };

  protected onContextMenu = (event: Event): void => {
    if (this.pointerId === null) return;
    event.preventDefault();
  };

  protected onSelectionChange = (): void => {
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
  protected onFocusCapture = (event: FocusEvent): void => {
    if (this.pointerId === null || this.pressWasFocused) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !this.view.dom.contains(target)) return;
    event.stopPropagation();
    target.blur();
  };

  /** `disarm()` (called from `finish()`, just before this) intentionally tears
   * down `onFocusCapture` at release so an ORDINARY short tap can still focus
   * and place a caret — that is the existing, load-bearing "tap-to-place-caret
   * untouched" behavior. But a press that reached the hold threshold is not
   * an ordinary tap, and measured in this very harness: releasing one in place
   * (no movement) still resolves to a native click that focuses the editable,
   * exactly the "however long it lasts... whether or not it lifts" case the
   * module doc names, not the short-tap case `disarm()`'s timing protects. A
   * short-lived, self-removing capture listener absorbs that one deferred
   * focus without staying registered a moment longer than it has to, so it
   * can never shadow a genuinely new press's own guard. */
  protected guardFocusBriefly(untilClick: boolean): void {
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
  protected collapseSelection(): void {
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
}

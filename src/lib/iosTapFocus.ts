import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

interface TapPoint {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

export interface IosTapFocusOptions {
  enabled: boolean;
  resolveTapPosition: (point: TapPoint, view: EditorView) => number | null;
  /**
   * Return true if a tap on this target should NOT be consumed to focus the
   * editor — its own handler (registered after this one) will act on the tap
   * instead. Used so a tap on a link FOLLOWS it on the first tap rather than
   * merely placing the caret (which the user then has to tap again to follow).
   * When omitted, every tap focuses.
   */
  shouldIgnoreTap?: (target: EventTarget | null) => boolean;
}

function pointFromTouchList(touches: TouchList): TapPoint | null {
  const touch = touches[0];
  return touch ? { clientX: touch.clientX, clientY: touch.clientY, target: touch.target } : null;
}

function distance(a: TapPoint, b: TapPoint): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function focusWithoutScroll(view: EditorView): void {
  try {
    view.contentDOM.focus({ preventScroll: true });
  } catch {
    view.contentDOM.focus();
  }
  if (!view.hasFocus) {
    view.contentDOM.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  }
}

/**
 * Places the caret at the tapped position when the editor is UNFOCUSED.
 * On refocus of a contenteditable, both WebKit and Blink restore the
 * selection saved at blur instead of honoring the tap — the caret snaps
 * back to wherever it was when the keyboard was dismissed. Resolve the tap
 * on `touchend` (a real tap only), focus with `preventScroll`, then set the
 * CM selection AFTER focus so the browser's restore cannot override it.
 * iOS/WebKit ONLY: Android WebView does not raise the IME for a JS focus
 * when the native tap was preventDefault-ed — there, the native tap path
 * must run (focus + IME) and the click-time caret correction in
 * MarkdownEditor handles the restored selection instead. Taps while already
 * focused fall through to the normal path.
 * See docs/learnings/ios-keyboard-editor-jump.md.
 */
export function iosTapFocus(options: IosTapFocusOptions): Extension[] {
  if (!options.enabled) return [];

  let start: TapPoint | null = null;
  let moved = false;

  return [
    EditorView.domEventHandlers({
      touchstart: (event) => {
        start = event.touches.length === 1 ? pointFromTouchList(event.touches) : null;
        moved = false;
        return false;
      },
      touchmove: (event) => {
        if (!start) return false;
        const current = pointFromTouchList(event.touches);
        if (current && distance(start, current) > 8) moved = true;
        return false;
      },
      touchend: (event, view) => {
        const end = pointFromTouchList(event.changedTouches);
        const isTap = start && end && !moved && distance(start, end) <= 8;
        start = null;
        moved = false;
        if (!isTap || view.hasFocus) return false;

        // Yield a tap on a link so its own handler follows it on the FIRST tap.
        // Otherwise this handler would consume the tap to focus + place the
        // caret, and the link would only follow on a second tap.
        if (end && options.shouldIgnoreTap?.(end.target)) return false;

        const pos = options.resolveTapPosition(end, view);
        if (pos === null) return false;

        event.preventDefault();
        focusWithoutScroll(view);
        // Focus can cause the browser (WebKit and Blink alike) to install its
        // own contenteditable selection — typically the one saved at blur.
        // Set the CM selection after focus so it cannot be overridden.
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
        return true;
      },
    }),
  ];
}

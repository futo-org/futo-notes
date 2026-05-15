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

        const pos = options.resolveTapPosition(end, view);
        if (pos === null) return false;

        event.preventDefault();
        focusWithoutScroll(view);
        // Focus can cause WebKit to install its own contenteditable selection.
        // Set the CM selection after focus so the browser cannot reset it to 0.
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
        return true;
      },
    }),
  ];
}

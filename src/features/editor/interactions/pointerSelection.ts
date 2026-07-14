import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import {
  clearSelectionRevealFreeze,
  freezeSelectionReveal,
  liveMarkdownRefresh,
  setSuppressSelectionReveal,
} from '../liveMarkdownTransform';

interface PointerSelectionOptions {
  view: EditorView;
  onBlur: () => void;
}

function snapSelectionPastMarkdownMarkers(view: EditorView, wasDragging: boolean): void {
  const selection = view.state.selection.main;
  if (selection.empty) return;

  const forward = selection.anchor <= selection.head;
  const originalFrom = forward ? selection.anchor : selection.head;
  const originalTo = forward ? selection.head : selection.anchor;
  const doc = view.state.doc;
  let from = originalFrom;
  let to = originalTo;

  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.to < originalFrom || node.from > originalTo) return;

      if (/^ATXHeading[1-6]$/.test(node.name)) {
        if (!wasDragging) return;
        const headingStart = doc.sliceString(node.from, Math.min(node.to, node.from + 8));
        const marker = headingStart.match(/^#+ ?/)?.[0] ?? '';
        if (marker && originalFrom === node.from + marker.length && originalTo > originalFrom) {
          from = Math.min(from, node.from);
        }
        return;
      }

      let markerLength = 0;
      if (node.name === 'StrongEmphasis' || node.name === 'Strikethrough') markerLength = 2;
      else if (node.name === 'Emphasis') markerLength = 1;
      else if (node.name === 'InlineCode') {
        const codeStart = doc.sliceString(node.from, Math.min(node.to, node.from + 10));
        markerLength = codeStart.match(/^`+/)?.[0].length ?? 0;
      } else return;

      const innerFrom = node.from + markerLength;
      const innerTo = node.to - markerLength;
      if (markerLength === 0 || innerFrom >= innerTo) return;
      if (originalFrom > innerFrom || originalTo < innerTo) return;

      if (originalFrom <= node.from && originalTo === innerTo) to = Math.max(to, node.to);
      if (originalTo >= node.to && originalFrom === innerFrom) from = Math.min(from, node.from);
      if (wasDragging && originalFrom === innerFrom && originalTo === innerTo) {
        from = Math.min(from, node.from);
        to = Math.max(to, node.to);
      }
    },
  });

  if (from === originalFrom && to === originalTo) return;
  view.dispatch({
    selection: EditorSelection.single(forward ? from : to, forward ? to : from),
  });
}

export class EditorPointerSelection {
  private isPointerDown = false;
  private didDrag = false;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private settleTimer: number | null = null;

  constructor(private readonly options: PointerSelectionOptions) {}

  attach(): void {
    this.options.view.dom.addEventListener('mousedown', this.handleEditorMouseDown, true);
    window.addEventListener('mousemove', this.handleGlobalPointerMove, true);
    window.addEventListener('mouseup', this.handleGlobalMouseUp, true);
    window.addEventListener('blur', this.handleGlobalBlur);
  }

  destroy(): void {
    this.clearSettleTimer();
    this.options.view.dom.removeEventListener('mousedown', this.handleEditorMouseDown, true);
    window.removeEventListener('mousemove', this.handleGlobalPointerMove, true);
    window.removeEventListener('mouseup', this.handleGlobalMouseUp, true);
    window.removeEventListener('blur', this.handleGlobalBlur);
    clearSelectionRevealFreeze();
    this.setRevealSuppressed(false);
  }

  private readonly handleEditorMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.isPointerDown = true;
    this.didDrag = false;
    this.pointerDownX = event.clientX;
    this.pointerDownY = event.clientY;
    const { view } = this.options;
    freezeSelectionReveal(view.hasFocus, view.state.selection.ranges);
    this.setRevealSuppressed(false);
  };

  private readonly handleGlobalPointerMove = (event: MouseEvent): void => {
    if (!this.isPointerDown) return;
    if (!this.didDrag) {
      const deltaX = event.clientX - this.pointerDownX;
      const deltaY = event.clientY - this.pointerDownY;
      if (deltaX * deltaX + deltaY * deltaY < 9) return;
    }
    this.didDrag = true;
    this.setRevealSuppressed(true);
  };

  private readonly handleGlobalMouseUp = (): void => {
    if (!this.isPointerDown) return;
    const wasDragging = this.didDrag;
    this.isPointerDown = false;
    this.didDrag = false;
    clearSelectionRevealFreeze();
    this.setRevealSuppressed(false);
    this.options.view.dispatch({ effects: liveMarkdownRefresh.of(null) });
    this.scheduleSelectionSettle(wasDragging);
  };

  private readonly handleGlobalBlur = (): void => {
    this.isPointerDown = false;
    this.didDrag = false;
    clearSelectionRevealFreeze();
    this.setRevealSuppressed(false);
    this.clearSettleTimer();
    this.options.onBlur();
  };

  private setRevealSuppressed(suppressed: boolean): void {
    setSuppressSelectionReveal(suppressed);
    this.options.view.dom.toggleAttribute('data-selection-reveal-suppressed', suppressed);
  }

  private scheduleSelectionSettle(wasDragging: boolean): void {
    this.clearSettleTimer();
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      snapSelectionPastMarkdownMarkers(this.options.view, wasDragging);
    }, 0);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer === null) return;
    window.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}

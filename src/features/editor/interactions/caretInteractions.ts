import { EditorSelection, type Extension, type SelectionRange } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { cursorOnTappedRow } from './caretRow';

const INLINE_STYLED_SELECTOR = '.cm-md-emphasis, .cm-md-strong, .cm-md-strikethrough, .cm-md-code';
const VISIBLE_LINE_EDGE_SELECTOR = [
  '.cm-md-wikilink',
  '.cm-md-link:not(.cm-md-wikilink)',
  INLINE_STYLED_SELECTOR,
  '.cm-md-tag',
  '.cm-md-task-checkbox-wrapper',
  '.cm-md-image-wrapper',
].join(', ');

interface EditorCaretInteractionOptions {
  nativeShell: boolean;
  isIOS: boolean;
  getView: () => EditorView | null;
  hasPendingExternalLink: () => boolean;
}

interface LineHit {
  line: ReturnType<EditorView['state']['doc']['lineAt']>;
  lineElement: HTMLElement;
}

/** One rendered fragment of a line, kept per VISUAL row rather than merged. */
interface RenderedFragment {
  top: number;
  bottom: number;
  right: number;
}

function collectRenderedFragments(line: HTMLElement): RenderedFragment[] {
  const fragments: RenderedFragment[] = [];
  const add = (rect: DOMRect) => {
    if (rect.width <= 0 && rect.height <= 0) return;
    fragments.push({ top: rect.top, bottom: rect.bottom, right: rect.right });
  };

  for (const candidate of line.querySelectorAll(VISIBLE_LINE_EDGE_SELECTOR)) {
    for (const rect of (candidate as HTMLElement).getClientRects()) add(rect);
  }

  const walker = document.createTreeWalker(line, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current instanceof HTMLElement) {
      if (current === line || current.classList.contains('cm-md-marker-widget')) {
        current = walker.nextNode();
        continue;
      }
      for (const rect of current.getClientRects()) add(rect);
    } else if (current instanceof Text) {
      const parent = current.parentElement;
      if (current.textContent && parent && !parent.closest('.cm-md-marker-widget')) {
        const range = document.createRange();
        range.selectNodeContents(current);
        for (const rect of range.getClientRects()) add(rect);
      }
    }
    current = walker.nextNode();
  }
  return fragments;
}

/**
 * The right edge of the rendered text on the pointer's OWN row. Measured across
 * the whole line this is the widest row, so a click past a last row shorter than
 * an earlier one read as "not past the text" and fell through to the engine,
 * which answers inside a wikilink's hidden `]]`. A pointer on no text row
 * measures the whole line — the only answer available there.
 */
function getRenderedRowRight(line: HTMLElement, clientY: number): number | null {
  const fragments = collectRenderedFragments(line);
  if (fragments.length === 0) return null;
  const onPointerRow = fragments.filter(
    (fragment) => clientY >= fragment.top && clientY <= fragment.bottom,
  );
  const measured = onPointerRow.length > 0 ? onPointerRow : fragments;
  return Math.max(...measured.map((fragment) => fragment.right));
}

export class EditorCaretInteractions {
  private lineEndPending: {
    clientX: number;
    clientY: number;
    rowEnd: SelectionRange;
  } | null = null;

  readonly extensions: Extension[];

  constructor(private readonly options: EditorCaretInteractionOptions) {
    this.extensions = [this.createTripleClickHandler(), this.createLineEndClickHandler()];
    if (options.nativeShell && !options.isIOS) {
      this.extensions.push(this.createMobileTapCorrection());
    }
  }

  private getLineHitAtPoint(
    clientX: number,
    clientY: number,
    view: EditorView,
    targetNode?: Node | null,
  ): LineHit | null {
    const target = targetNode instanceof Element ? targetNode : (targetNode?.parentElement ?? null);
    const hit = document.elementFromPoint(clientX, clientY);
    const lineElement = (hit?.closest('.cm-line') ??
      target?.closest('.cm-line')) as HTMLElement | null;
    if (!lineElement) return null;

    let linePosition: number | null = null;
    try {
      linePosition = view.posAtDOM(lineElement, 0);
    } catch {
      try {
        linePosition = view.posAtCoords({ x: clientX, y: clientY });
      } catch {
        linePosition = null;
      }
    }
    if (linePosition === null) return null;
    return { line: view.state.doc.lineAt(linePosition), lineElement };
  }

  resolveTapPositionAt(
    clientX: number,
    clientY: number,
    view: EditorView,
    targetNode?: Node | null,
  ): SelectionRange | null {
    const hit = this.getLineHitAtPoint(clientX, clientY, view, targetNode);
    // No answer off a line: posAtCoords would report a document end and override
    // the engine's own placement. → docs/spec/editor.md
    if (!hit) return null;
    const { line, lineElement } = hit;
    if (line.from === line.to) return EditorSelection.cursor(line.from);

    const rect = lineElement.getBoundingClientRect();
    const x = Math.min(Math.max(clientX, rect.left + 1), rect.right - 1);
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
    const position = view.posAtCoords({ x, y }, false);
    if (position !== null && position >= line.from && position <= line.to) {
      return cursorOnTappedRow(view, position, y);
    }

    const visibleRight = getRenderedRowRight(lineElement, y);
    if (visibleRight !== null && clientX > visibleRight + 1) return EditorSelection.cursor(line.to);
    return EditorSelection.cursor(line.from);
  }

  private createTripleClickHandler(): Extension {
    const selectLine = (event: MouseEvent, view: EditorView): boolean => {
      if (event.button !== 0 || event.detail !== 3) return false;
      const hit = this.getLineHitAtPoint(
        event.clientX,
        event.clientY,
        view,
        event.target as Node | null,
      );
      if (!hit) return false;

      event.preventDefault();
      event.stopPropagation();
      view.focus();
      window.setTimeout(() => {
        if (!this.options.getView()) return;
        view.dispatch({ selection: { anchor: hit.line.from, head: hit.line.to } });
      }, 0);
      return true;
    };
    return EditorView.domEventHandlers({ mousedown: selectLine, click: selectLine });
  }

  /** The end of the visual row the pointer is on, not the wrapped line's end. */
  private rowEndAt(clientY: number, hit: LineHit, view: EditorView): SelectionRange {
    const rect = hit.lineElement.getBoundingClientRect();
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);

    // The row carrying the line's end answers with it, not with what the row
    // renders: hidden trailing markers (a wikilink's `]]`) stop it short.
    const lineEnd = view.coordsAtPos(hit.line.to, -1);
    if (lineEnd && y >= lineEnd.top && y <= lineEnd.bottom) {
      return EditorSelection.cursor(hit.line.to);
    }

    const inRow = view.posAtCoords({ x: rect.right - 1, y }, false);
    return cursorOnTappedRow(view, inRow ?? hit.line.to, y);
  }

  private createLineEndClickHandler(): Extension {
    return EditorView.domEventHandlers({
      mousedown: (event, view) => {
        this.lineEndPending = null;
        if (event.button !== 0 || event.detail !== 1) return false;

        const hit = this.getLineHitAtPoint(
          event.clientX,
          event.clientY,
          view,
          event.target as Node | null,
        );
        if (!hit) return false;
        const visibleRight = getRenderedRowRight(hit.lineElement, event.clientY);
        if (visibleRight === null || event.clientX <= visibleRight + 1) return false;

        this.lineEndPending = {
          clientX: event.clientX,
          clientY: event.clientY,
          rowEnd: this.rowEndAt(event.clientY, hit, view),
        };
        return false;
      },
      click: (event, view) => {
        const pending = this.lineEndPending;
        this.lineEndPending = null;
        if (!pending || event.button !== 0 || event.detail !== 1) return false;
        if (!view.state.selection.main.empty) return false;
        if (
          Math.abs(event.clientX - pending.clientX) > 2 ||
          Math.abs(event.clientY - pending.clientY) > 2
        ) {
          return false;
        }

        event.preventDefault();
        view.dispatch({ selection: EditorSelection.create([pending.rowEnd]) });
        return true;
      },
    });
  }

  private createMobileTapCorrection(): Extension {
    return EditorView.domEventHandlers({
      click: (event, view) => {
        if (event.button !== 0 || event.detail !== 1) return false;
        if (this.options.hasPendingExternalLink() || this.lineEndPending !== null) return false;
        const selection = view.state.selection.main;
        if (!selection.empty) return false;
        const desired = this.resolveTapPositionAt(
          event.clientX,
          event.clientY,
          view,
          event.target as Node | null,
        );
        if (desired === null || desired.head === selection.head) return false;
        view.dispatch({ selection: EditorSelection.create([desired]), scrollIntoView: false });
        return false;
      },
    });
  }
}

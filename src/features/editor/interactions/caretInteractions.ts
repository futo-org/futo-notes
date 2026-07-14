import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

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

function getRenderedLineRight(line: HTMLElement): number | null {
  let right: number | null = null;
  for (const candidate of line.querySelectorAll(VISIBLE_LINE_EDGE_SELECTOR)) {
    const rect = (candidate as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    right = right === null ? rect.right : Math.max(right, rect.right);
  }

  const walker = document.createTreeWalker(line, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current instanceof HTMLElement) {
      if (current === line || current.classList.contains('cm-md-marker-widget')) {
        current = walker.nextNode();
        continue;
      }
      const rect = current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        right = right === null ? rect.right : Math.max(right, rect.right);
      }
    } else if (current instanceof Text) {
      const parent = current.parentElement;
      if (current.textContent && parent && !parent.closest('.cm-md-marker-widget')) {
        const range = document.createRange();
        range.selectNodeContents(current);
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 && rect.height <= 0) continue;
          right = right === null ? rect.right : Math.max(right, rect.right);
        }
      }
    }
    current = walker.nextNode();
  }
  return right;
}

export class EditorCaretInteractions {
  private lineEndPending: {
    clientX: number;
    clientY: number;
    lineTo: number;
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
    requireLine = false,
  ): number | null {
    const hit = this.getLineHitAtPoint(clientX, clientY, view, targetNode);
    if (!hit) return requireLine ? null : view.posAtCoords({ x: clientX, y: clientY }, false);
    const { line, lineElement } = hit;
    if (line.from === line.to) return line.from;

    const rect = lineElement.getBoundingClientRect();
    const x = Math.min(Math.max(clientX, rect.left + 1), rect.right - 1);
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
    const position = view.posAtCoords({ x, y }, false);
    if (position !== null && position >= line.from && position <= line.to) return position;

    const visibleRight = getRenderedLineRight(lineElement);
    if (visibleRight !== null && clientX > visibleRight + 1) return line.to;
    return line.from;
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
        const visibleRight = getRenderedLineRight(hit.lineElement);
        if (visibleRight === null || event.clientX <= visibleRight + 1) return false;

        this.lineEndPending = {
          clientX: event.clientX,
          clientY: event.clientY,
          lineTo: hit.line.to,
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
        view.dispatch({ selection: { anchor: pending.lineTo } });
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
        if (desired === null || desired === selection.head) return false;
        view.dispatch({ selection: { anchor: desired }, scrollIntoView: false });
        return false;
      },
    });
  }
}

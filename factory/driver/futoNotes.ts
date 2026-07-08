import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import type { Driver, DriverEvent, DriverState, DecoratedRange, Position } from './protocol';
import { classToKinds } from './semanticKind';

// Convert an absolute doc position to {line, ch, pos}. Both cm-lines
// and EditorState.Line are 1-based; we expose 0-based to the protocol
// because Position objects flow through scenarios that may be authored
// by humans, and 0-based reads more naturally.
function posToPosition(view: EditorView, pos: number): Position {
  const line = view.state.doc.lineAt(pos);
  return { line: line.number - 1, ch: pos - line.from, pos };
}

function lineChToPos(view: EditorView, line: number, ch: number): number {
  const doc = view.state.doc;
  const target = Math.min(Math.max(line, 0), doc.lines - 1);
  const lineInfo = doc.line(target + 1);
  return lineInfo.from + Math.min(Math.max(ch, 0), lineInfo.length);
}

function isWidgetEl(el: Element): boolean {
  // CM6 widget decorations render as elements not contained in .cm-line
  // text; we identify them by the `cm-widgetBuffer` neighbor or by being
  // a non-text descendant with no contenteditable text. Practical
  // heuristic: treat any element with `data-widget` OR known widget
  // class markers as a widget.
  const classList = el.classList;
  if (classList.contains('cm-widgetBuffer')) return false;
  return (
    classList.contains('cm-md-hr-widget') ||
    classList.contains('cm-md-image-wrapper') ||
    classList.contains('cm-md-image-widget') ||
    classList.contains('cm-md-table-wrapper') ||
    classList.contains('sf-table') ||
    classList.contains('cm-md-table-rendered') ||
    classList.contains('cm-md-task-checkbox-wrapper') ||
    // List-marker widgets stand in for the `- ` / `N. ` source text;
    // their DOM textContent (`•`, `1.`) doesn't match the source range
    // length, so use the next-sibling boundary like other widgets.
    classList.contains('cm-md-bullet') ||
    classList.contains('cm-md-number')
  );
}

function extractDecorations(view: EditorView): DecoratedRange[] {
  const out: DecoratedRange[] = [];
  const root = view.contentDOM;
  // TreeWalker over elements only — text nodes inherit class context
  // from their parent span.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    // Skip cm-line containers — their child spans carry the
    // interesting decorations. Exception: cm-line.hr is how
    // Obsidian renders horizontal rules; capture those so the
    // hr-widget bucket lines up with SF's `cm-md-hr-widget`.
    const cl = node.classList;
    const isLine = cl.contains('cm-line');
    const isHrLine = isLine && cl.contains('hr');
    if (cl.length > 0 && (!isLine || isHrLine)) {
      const classes = Array.from(node.classList);
      const kinds = classToKinds(classes);
      const isUnknown = kinds.length === 1 && kinds[0] === 'unknown';
      if (
        !isUnknown ||
        classes.some((c) =>
          /^cm-(md-|hashtag|formatting|strong|em|strikethrough|link|url|inline-code|header|quote)/.test(
            c,
          ),
        )
      ) {
        try {
          // Range bounds: the doc positions of the first and last
          // characters this DOM element represents.
          const fromPos = view.posAtDOM(node, 0);
          // For replaced widgets the inner text is empty; use offsetWidth heuristic
          let toPos: number;
          const widget = isWidgetEl(node);
          if (widget) {
            // For widgets, the end position is wherever the document
            // resumes after the widget. CM6 inserts zero-width
            // `cm-widgetBuffer` siblings around widgets — those report
            // the same position as the widget itself, so skip past them
            // to find the next real DOM neighbor. Block widgets
            // (HR/image/table) sit inside an empty `.cm-line`; their
            // own `nextSibling` can be null even though the doc
            // continues, so walk up to the parent cm-line and use its
            // next sibling.
            const findNext = (start: Element): Element | null => {
              let cur: Element | null = start;
              while (cur && cur !== view.contentDOM) {
                let n = cur.nextSibling as Element | null;
                while (
                  n &&
                  n.nodeType === Node.ELEMENT_NODE &&
                  (n as Element).classList?.contains('cm-widgetBuffer')
                ) {
                  n = n.nextSibling as Element | null;
                }
                if (n && n.nodeType === Node.ELEMENT_NODE) return n as Element;
                cur = cur.parentElement;
              }
              return null;
            };
            const next = findNext(node);
            // No real sibling means the widget reaches end of doc — common
            // for block widgets (table, hr, image) at the end of a file.
            toPos = next ? view.posAtDOM(next, 0) : view.state.doc.length;
            if (toPos <= fromPos) toPos = fromPos + 1;
          } else {
            // For non-widget spans, ask CM6 for the doc position at the
            // end of the element's children. textContent.length lies
            // when the span contains nested replace decorations or
            // hidden chars (e.g., a heading span surrounding a bold
            // span whose `**` markers are replace-hidden).
            try {
              toPos = view.posAtDOM(node, node.childNodes.length);
            } catch {
              toPos = fromPos + (node.textContent?.length ?? 0);
            }
          }
          for (const kind of kinds) {
            out.push({
              from: posToPosition(view, fromPos),
              to: posToPosition(view, Math.max(toPos, fromPos)),
              kind,
              replaced: widget,
              classes,
              text: node.textContent ?? '',
            });
          }
        } catch {
          // posAtDOM throws on detached nodes — skip silently.
        }
      }
    }
    node = walker.nextNode() as Element | null;
  }
  return out;
}

function extractState(view: EditorView): DriverState {
  const sel = view.state.selection.main;
  const cursor = posToPosition(view, sel.head);
  const anchor = posToPosition(view, sel.anchor);
  return {
    doc: view.state.doc.toString(),
    cursor,
    selection: { head: cursor, anchor },
    decorations: extractDecorations(view),
    visibleText: (view.contentDOM as HTMLElement).innerText,
  };
}

async function applyEvent(view: EditorView, ev: DriverEvent): Promise<void> {
  switch (ev.type) {
    case 'set_doc': {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: ev.markdown },
        selection: EditorSelection.cursor(0),
      });
      break;
    }
    case 'place_cursor': {
      const pos = lineChToPos(view, ev.line, ev.ch);
      view.dispatch({ selection: EditorSelection.cursor(pos) });
      view.focus();
      break;
    }
    case 'type': {
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: ev.text },
        selection: EditorSelection.cursor(sel.from + ev.text.length),
      });
      break;
    }
    case 'key': {
      const map: Record<string, string> = {
        ArrowUp: 'ArrowUp',
        ArrowDown: 'ArrowDown',
        ArrowLeft: 'ArrowLeft',
        ArrowRight: 'ArrowRight',
        Home: 'Home',
        End: 'End',
        Enter: 'Enter',
        Backspace: 'Backspace',
        Delete: 'Delete',
        Escape: 'Escape',
      };
      const key = map[ev.key];
      if (!key) return;
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      break;
    }
    case 'blur':
      view.contentDOM.blur();
      break;
    case 'focus':
      view.focus();
      break;
  }
  // Let Svelte/CM flush any pending RAF work before the judge reads state.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

export function installDriver(view: EditorView): void {
  // Tag this editor's contentDOM so the factory runner can click and
  // send key events to *this* editor specifically, not a sibling
  // .cm-content (Obsidian has many; SF in dev usually has one but the
  // attribute keeps the selector consistent across editors).
  try {
    for (const el of document.querySelectorAll('.cm-content[data-factory-target]')) {
      el.removeAttribute('data-factory-target');
    }
    view.contentDOM.setAttribute('data-factory-target', 'true');
  } catch {}

  const driver: Driver = {
    async setDoc(markdown) {
      await applyEvent(view, { type: 'set_doc', markdown });
    },
    async dispatch(events) {
      for (const ev of events) await applyEvent(view, ev);
    },
    async state() {
      return extractState(view);
    },
    async identify() {
      return { name: 'futo-notes', version: 'dev' };
    },
  };
  (window as any).__driver = driver;
}

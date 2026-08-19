// Every tap→caret placement answer, as pure geometry. → docs/spec/editor.md
import { EditorSelection, type SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { findUrlAtPosition } from '../links/autolinks';

const INLINE_STYLED_SELECTOR = '.cm-md-emphasis, .cm-md-strong, .cm-md-strikethrough, .cm-md-code';
const VISIBLE_LINE_EDGE_SELECTOR = [
  '.cm-md-wikilink',
  '.cm-md-link:not(.cm-md-wikilink)',
  INLINE_STYLED_SELECTOR,
  '.cm-md-tag',
  '.cm-md-task-checkbox-wrapper',
  '.cm-md-image-wrapper',
].join(', ');

const EXTERNAL_LINK_SELECTOR = '.cm-md-link:not(.cm-md-wikilink)';

/**
 * At a wrap point one offset draws in two places — end of a row, start of the
 * next — and only the association separates them. → docs/spec/editor.md
 */
export function cursorOnTappedRow(
  view: EditorView,
  position: number,
  clientY: number,
): SelectionRange {
  const before = view.coordsAtPos(position, -1);
  const after = view.coordsAtPos(position, 1);
  if (!before || !after || before.top === after.top) return EditorSelection.cursor(position);
  return EditorSelection.cursor(position, clientY < after.top ? -1 : 1);
}

export interface LineHit {
  line: ReturnType<EditorView['state']['doc']['lineAt']>;
  lineElement: HTMLElement;
}

export function lineHitAtPoint(
  clientX: number,
  clientY: number,
  view: EditorView,
  targetNode?: Node | null,
): LineHit | null {
  const target = targetNode instanceof Element ? targetNode : (targetNode?.parentElement ?? null);
  const hit = view.dom.ownerDocument.elementFromPoint(clientX, clientY);
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

function lineElementAt(view: EditorView, position: number): HTMLElement | null {
  try {
    const node = view.domAtPos(position).node;
    const element = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line');
    return (element as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

/** The line the pointer sits beside. Below the last row no line is: → positionBelowText */
export function lineHitBesidePoint(
  clientX: number,
  clientY: number,
  view: EditorView,
  targetNode?: Node | null,
): LineHit | null {
  const onLine = lineHitAtPoint(clientX, clientY, view, targetNode);
  if (onLine) return onLine;

  const content = view.contentDOM.getBoundingClientRect();
  if (clientX < content.left || clientX > content.right) return null;
  const end = view.coordsAtPos(view.state.doc.length, -1);
  if (clientY < content.top || (end && clientY > end.bottom)) return null;

  try {
    const line = view.state.doc.lineAt(view.posAtCoords({ x: clientX, y: clientY }, false));
    const lineElement = lineElementAt(view, line.from);
    return lineElement ? { line, lineElement } : null;
  } catch {
    return null;
  }
}

const ROWS_BELOW_TEXT = 2;

/** The column under the pointer, read on the note's last row. → docs/spec/editor.md */
export function positionBelowText(
  clientX: number,
  clientY: number,
  view: EditorView,
): SelectionRange | null {
  const end = view.coordsAtPos(view.state.doc.length, -1);
  if (!end || clientY <= end.bottom) return null;
  const content = view.contentDOM.getBoundingClientRect();
  const surface = view.scrollDOM.getBoundingClientRect();
  if (clientX < content.left || clientX > content.right || clientY > surface.bottom) return null;

  const line = view.state.doc.lineAt(view.state.doc.length);
  if (clientY >= end.bottom + view.defaultLineHeight * ROWS_BELOW_TEXT) {
    return EditorSelection.cursor(line.to);
  }

  const rowY = (end.top + end.bottom) / 2;
  const lineElement = lineElementAt(view, line.from);
  const visibleRight = lineElement ? getRenderedRowRight(lineElement, rowY) : null;

  // Never the last DRAWN position: hidden markup (a wikilink's `]]`) sits past it.
  if (visibleRight === null || clientX > visibleRight + 1) return EditorSelection.cursor(line.to);
  return cursorOnTappedRow(view, view.posAtCoords({ x: clientX, y: rowY }, false), rowY);
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

  const ownerDocument = line.ownerDocument;
  const nodeFilter = ownerDocument.defaultView?.NodeFilter ?? NodeFilter;
  const walker = ownerDocument.createTreeWalker(
    line,
    nodeFilter.SHOW_ELEMENT | nodeFilter.SHOW_TEXT,
  );
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
        const range = ownerDocument.createRange();
        range.selectNodeContents(current);
        for (const rect of range.getClientRects()) add(rect);
      }
    }
    current = walker.nextNode();
  }
  return fragments;
}

/** The rendered right edge of the pointer's OWN row; the whole line measures its widest. */
export function getRenderedRowRight(line: HTMLElement, clientY: number): number | null {
  const fragments = collectRenderedFragments(line);
  if (fragments.length === 0) return null;
  const onPointerRow = fragments.filter(
    (fragment) => clientY >= fragment.top && clientY <= fragment.bottom,
  );
  const measured = onPointerRow.length > 0 ? onPointerRow : fragments;
  return Math.max(...measured.map((fragment) => fragment.right));
}

export function resolveTapPositionAt(
  clientX: number,
  clientY: number,
  view: EditorView,
  targetNode?: Node | null,
): SelectionRange | null {
  const hit = lineHitAtPoint(clientX, clientY, view, targetNode);
  // Declining is the answer off a line: posAtCoords would name a document end.
  if (!hit) return null;
  const { line, lineElement } = hit;
  if (line.from === line.to) return EditorSelection.cursor(line.from);

  const rect = lineElement.getBoundingClientRect();
  const x = Math.min(Math.max(clientX, rect.left + 1), rect.right - 1);
  const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
  const visibleRight = getRenderedRowRight(lineElement, y);
  if (visibleRight !== null && clientX > visibleRight + 1) {
    return rowEndSelectionAt(y, hit, view);
  }
  const position = view.posAtCoords({ x, y }, false);
  if (position !== null && position >= line.from && position <= line.to) {
    return cursorOnTappedRow(view, position, y);
  }

  return EditorSelection.cursor(line.from);
}

/** The end of the visual row the pointer is on, not the wrapped line's end. */
export function rowEndSelectionAt(clientY: number, hit: LineHit, view: EditorView): SelectionRange {
  const rect = hit.lineElement.getBoundingClientRect();
  const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);

  // The row carrying the line's end answers with it, not with what the row
  // renders: hidden trailing markers (a wikilink's `]]`) stop it short.
  const lineEnd = view.coordsAtPos(hit.line.to, -1);
  if (lineEnd && y >= lineEnd.top && y <= lineEnd.bottom) {
    return EditorSelection.cursor(hit.line.to);
  }

  const visibleRight = getRenderedRowRight(hit.lineElement, y);
  const inRow = view.posAtCoords({ x: visibleRight ?? rect.right - 1, y }, false);
  return cursorOnTappedRow(view, inRow ?? hit.line.to, y);
}

/** An internal semantic link hit resolved from decorated editor DOM. */
export type PointerLinkHit =
  { kind: 'wikilink'; title: string; broken: boolean } | { kind: 'external'; url: string };

function eventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function findExternalLinkElementAtPoint(
  target: Element | null,
  clientX: number,
  clientY: number,
): Element | null {
  const line = target?.closest('.cm-line');
  if (!line) return null;

  for (const candidate of line.querySelectorAll(EXTERNAL_LINK_SELECTOR)) {
    for (const rect of candidate.getClientRects()) {
      if (
        clientX >= rect.left - 1 &&
        clientX <= rect.right + 1 &&
        clientY >= rect.top - 1 &&
        clientY <= rect.bottom + 1
      ) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveExternalLinkUrl(view: EditorView, link: Element): string | null {
  try {
    const start = view.posAtDOM(link, 0);
    const end = view.posAtDOM(link, link.childNodes.length);
    return findUrlAtPosition(view, Math.floor((start + end) / 2));
  } catch {
    return null;
  }
}

/** Resolves the semantic editor link under one pointer point using fragment-aware geometry. */
export function resolvePointerLinkAtPoint(
  view: EditorView,
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): PointerLinkHit | null {
  const targetElement = eventTargetElement(target);
  const pointElement = view.dom.ownerDocument.elementFromPoint(clientX, clientY);
  const wikilink = (pointElement?.closest('.cm-md-wikilink') ??
    targetElement?.closest('.cm-md-wikilink')) as HTMLElement | null;
  const title = wikilink?.getAttribute('data-wikilink');
  if (wikilink && title) {
    return {
      kind: 'wikilink',
      title,
      broken: wikilink.classList.contains('cm-md-wikilink-broken'),
    };
  }

  const externalLink =
    findExternalLinkElementAtPoint(pointElement, clientX, clientY) ??
    findExternalLinkElementAtPoint(targetElement, clientX, clientY) ??
    pointElement?.closest(EXTERNAL_LINK_SELECTOR) ??
    targetElement?.closest(EXTERNAL_LINK_SELECTOR);
  if (!externalLink) return null;
  const url = resolveExternalLinkUrl(view, externalLink);
  return url ? { kind: 'external', url } : null;
}

/** True when a native first-focus tap should leave the target to its own interactive owner. */
export function pointerTargetIsInteractive(target: EventTarget | null): boolean {
  return Boolean(eventTargetElement(target)?.closest('a.cm-md-table-link'));
}

import type { Line, LineModel, LineSplice } from './lineModel';
import { createSegment, draws, segmentsOf, textOf, type Segment } from './lineSegments';
import { drawAtoms } from './atomElements';
import { setMarkerWidth } from './markerWidth';
import { codeChromeCount, drawCodeChrome } from './codeBlockChrome';
import { isImageAtom } from './pictureElements';
import { isPictureLine } from './blockNeighbours';
import {
  drawTableLine,
  isTableRowElement,
  pointInTableRow,
  tableLineClass,
  unitsBeforeInTableRow,
} from './tableRowElements';

/* The editor's line elements: each drawn from its line, grouped in chunks of about
 * CHUNK_LINES. With every line a child of one element, WebKit re-lays out all of them on
 * any edit (330 ms per keystroke in a 58,000-line note, and 1.2 s to first lay it out); in
 * chunks an edit costs about 1 ms, and the first layout 0.5 s. Every line stays in the DOM
 * and laid out, so the native selection, input methods and VoiceOver reach the whole note.
 *
 * Not `content-visibility: auto` on the chunks: WebKit leaves a selection painted in a
 * chunk it skipped while the selection was cleared (select all, click, scroll down), and
 * it saved only 0.1 s of the first layout. */

/** A line's classes: its heading level; a list item (`list`, where its text starts
 *  `d1`…`d9`, and `ordered` or `task` where its marker's room moves its text); an indented plain
 *  line under a list (`list` and the level it borrows, no marker: its text starts where that
 *  level's marker would); a quote's nesting (`quote q1`…`q6`); `divider`. Classes, not an
 *  inline style, so lines alike share their style: an indent stops growing after the eighth
 *  level, and quote bars after the sixth. A fenced code line is `code-line`, and `first` and
 *  `last` where it starts or ends its block, `under-block` and `over-block` where that end touches
 *  another block. A line of pictures alone is `picture-line`; `gap-above` and `gap-below` where
 *  a line keeps a gap from a block beside it (blockNeighbours.ts). */
function lineClass(line: Line): string {
  let name = line.heading ? `line heading h${line.heading}` : 'line';
  const list = line.list;
  const isItem = list !== null && list.marker !== '';
  const textLevel = list ? list.level + (isItem ? 1 : 0) : 0;
  if (textLevel > 0) name += ` list d${Math.min(textLevel, 9)}`;
  if (list && isItem && list.first) {
    if (list.checked !== null) name += ' task';
    else if (list.ordered) name += ' ordered';
  }
  if (line.quote) name += ` quote q${Math.min(line.quote, 6)}`;
  if (line.divider) name += ' divider';
  if (line.metadata) name += ' metadata';
  const code = line.code;
  if (code) {
    name += ' code-line';
    if (code.first) name += code.underBlock ? ' first under-block' : ' first';
    if (code.last) name += code.overBlock ? ' last over-block' : ' last';
  }
  if (line.table) name += tableLineClass(line.table);
  if (isPictureLine(line)) name += ' picture-line';
  if (line.gaps.above) name += ' gap-above';
  if (line.gaps.below) name += ' gap-below';
  return name;
}

/** The line each element was last drawn from, so a DOM point finds its line without a
 *  search through every line. */
const drawnLines = new WeakMap<Node, Line>();

/** The line `element` was last drawn from. */
export function drawnLineOf(element: HTMLElement): Line | undefined {
  return drawnLines.get(element);
}

/* WebKit updates every live Range on each removal of child nodes, so many of them make a
 * large DOM rewrite quadratic. The editor measures through one Range, parked on the
 * document after each use; a new line element is filled with `append`, as it has no
 * children to remove. */
let measuringRange: Range | null = null;

/** Run `measure` with the editor's one measuring Range, then park it outside the editor. */
export function withMeasuringRange<T>(measure: (range: Range) => T): T {
  measuringRange ??= document.createRange();
  try {
    return measure(measuringRange);
  } finally {
    measuringRange.setStart(document, 0);
    measuringRange.collapse(true);
  }
}

/** Draw `line` into `element`, touching the DOM only where it differs, so a line whose
 *  description and text did not change is not written at all. Its text is drawn in pieces
 *  (lineSegments.ts): plain text nodes, one span per formatted run, classed by its formats
 *  (`bold italic`), and one element per atom holding the atom's character (atomElements.ts); an
 *  empty line, or one whose only text is a list marker, ends in a `<br>` that gives it its row. A
 *  quote's bars and a divider's rule are drawn by CSS from the line's classes; a code block's
 *  card and numbers too, and its chrome (its header, the zone below it) starts its first and
 *  last lines (codeBlockChrome.ts), the text drawn after it. */
export function drawLine(element: HTMLElement, line: Line): void {
  drawnLines.set(element, line);
  const className = lineClass(line);
  if (element.className !== className) element.className = className;
  const list = line.list;
  setMarkerWidth(element, list?.first && list.ordered ? list.marker : null);
  const chrome = drawCodeChrome(element, line);
  if (drawTableLine(element, line)) return;
  const coloured = line.code !== null && line.colours.length > 0;
  const marked = line.links.length > 0 || line.tags.length > 0;
  if (line.runs.length > 0 || line.atoms.length > 0 || marked || coloured) {
    return drawSegments(element, segmentsOf(line), line, chrome);
  }
  // A plain line, the one typing touches most: one text node or a break, nothing allocated.
  const only = chrome ? chrome.nextSibling : element.firstChild;
  if (!only) element.append(line.text === '' ? document.createElement('br') : line.text);
  else if (line.text === '') {
    if (!(only instanceof HTMLBRElement) || only.nextSibling) {
      replaceText(element, chrome, document.createElement('br'));
    }
  } else if (only instanceof Text && !only.nextSibling) {
    if (only.data !== line.text) only.data = line.text;
  } else {
    replaceText(element, chrome, line.text);
  }
}

/** Replace everything in `element` after its code `chrome` (all of it without any) with
 *  `text`. */
function replaceText(element: HTMLElement, chrome: HTMLElement | null, text: Node | string): void {
  if (!chrome) return element.replaceChildren(text);
  while (chrome.nextSibling) chrome.nextSibling.remove();
  element.append(text);
}

/** Draw `segments` into `element`, compared with what it holds (an input method may have
 *  changed it): the nodes before and after the first and last difference stay, and the ones
 *  between are rewritten in place where they are of the same kind, so a keystroke inside a run
 *  rewrites that run's text alone. Atoms take their description from `line`; code `chrome`
 *  stays first. */
function drawSegments(
  element: HTMLElement,
  segments: readonly Segment[],
  line: Line,
  chrome: HTMLElement | null,
): void {
  const children = [...element.childNodes];
  const nodes = children.slice(chrome ? children.indexOf(chrome) + 1 : 0);
  const shared = Math.min(nodes.length, segments.length);
  let head = 0;
  while (head < shared && draws(nodes[head], segments[head])) head++;
  let tail = 0;
  while (
    tail < shared - head &&
    draws(nodes[nodes.length - 1 - tail], segments[segments.length - 1 - tail])
  ) {
    tail++;
  }
  const stale = nodes.slice(head, nodes.length - tail);
  const after = nodes[nodes.length - tail] ?? null;
  for (let index = head; index < segments.length - tail; index++) {
    const segment = segments[index];
    const old = stale[index - head];
    const text = old && textOf(old, segment);
    if (text) {
      if (text.data !== segment.text) text.data = segment.text;
      continue;
    }
    const node = createSegment(segment);
    if (old) old.replaceWith(node);
    else element.insertBefore(node, after);
  }
  for (const extra of stale.slice(segments.length - tail - head)) extra.remove();
  drawAtoms(element, line);
}

export const CHUNK_LINES = 512;

/** `lines`, in order, in new chunks. */
export function chunked(lines: readonly HTMLElement[]): HTMLElement[] {
  const chunks: HTMLElement[] = [];
  for (let index = 0; index < lines.length; index += CHUNK_LINES) {
    const chunk = document.createElement('div');
    chunk.className = 'chunk';
    chunk.append(...lines.slice(index, index + CHUNK_LINES));
    chunks.push(chunk);
  }
  return chunks;
}

/** After an edit added or removed lines in `chunks`: drop the empty ones and split the
 *  ones grown past twice the size. */
export function settle(chunks: Iterable<HTMLElement | null>): void {
  for (const chunk of chunks) {
    if (!chunk?.isConnected) continue;
    const count = chunk.children.length;
    if (count === 0) chunk.remove();
    else if (count > 2 * CHUNK_LINES) {
      const lines = [...chunk.children] as HTMLElement[];
      chunk.after(...chunked(lines.slice(CHUNK_LINES)));
    }
  }
}

/** The editor's children are chunks holding exactly `lines`, in order, and nothing else:
 *  false after an input method rearranged them. */
export function holds(editor: HTMLElement, lines: readonly HTMLElement[]): boolean {
  let index = 0;
  for (const chunk of editor.childNodes) {
    if (!(chunk instanceof HTMLElement) || chunk.className !== 'chunk' || !chunk.firstChild)
      return false;
    for (const line of chunk.childNodes) if (line !== lines[index++]) return false;
  }
  return index === lines.length;
}

/** The UTF-16 display offset of a DOM point in the editor `dom`, whose chunks hold one
 *  element per line of `model`, each drawn from its line. */
export function offsetOf(dom: HTMLElement, model: LineModel, node: Node, offset: number): number {
  // A point between lines, in the editor or a chunk, is the start of the line after it.
  if (node === dom || node.parentNode === dom) {
    const after =
      node === dom
        ? dom.childNodes[offset]?.firstChild
        : (node.childNodes[offset] ?? node.nextSibling?.firstChild);
    const line = after && drawnLines.get(after);
    return line ? line.start : model.length;
  }
  let element: Node | null = node;
  while (element && element.parentNode?.parentNode !== dom) element = element.parentNode;
  const line = element && drawnLines.get(element);
  if (!element || !line) return 0;
  const units = line.table
    ? unitsBeforeInTableRow(element as HTMLElement, node, offset)
    : unitsBefore(element, node, offset);
  return line.start + Math.min(units, line.text.length);
}

/** The UTF-16 units of a line element's text before the DOM point `node`/`offset` in it. */
function unitsBefore(element: Node, node: Node, offset: number): number {
  // The line's child the point is in (or, on the line itself, before), and how far into it.
  let child: Node | null;
  let units = 0;
  if (node === element) child = element.childNodes[offset] ?? null;
  else {
    child = node;
    while (child.parentNode !== element) child = child.parentNode!;
    units = node instanceof Text ? offset : offset === 0 ? 0 : (node.textContent ?? '').length;
  }
  for (let at = child ? child.previousSibling : element.lastChild; at; at = at.previousSibling) {
    units += (at.textContent ?? '').length;
  }
  return units;
}

/** The DOM point at UTF-16 `at` in a line element's text: inside a text node. At a boundary
 *  between two (a format's or an atom's edge) it is the start of the one after, which draws on
 *  the lower row where a soft wrap falls there, or with `before` the end of the one before. A
 *  line with no text is its element's start; after a list marker with no text after it, the
 *  point after the marker's element, where the item's text would start. Beside an image with
 *  no text on that side, the point beside its element. */
export function pointInLine(element: HTMLElement, at: number, before = false): [Node, number] {
  if (isTableRowElement(element)) return pointInTableRow(element, at, before);
  let text: Text | null = null;
  let index = 0;
  for (let node = element.firstChild; node; node = node.nextSibling, index++) {
    const inside = node instanceof Text ? node : node.firstChild;
    if (!(inside instanceof Text)) continue;
    // Never in an image's hidden spelling: beside its element, where no text is.
    if (isImageAtom(node)) {
      if (at <= 0) return [element, index];
      at = Math.max(at - inside.length, 0);
      if (at === 0 && (before || !node.nextSibling)) return [element, index + 1];
      continue;
    }
    text = inside;
    if (at < text.length || (before && at === text.length && at > 0)) return [text, at];
    at -= text.length;
    if (at === 0 && !before && isMarker(node) && !hasTextAfter(node)) {
      return [element, index + 1];
    }
  }
  // A code line's chrome, its first children, is not the line's start.
  return text ? [text, text.length] : [element, codeChromeCount(element)];
}

function isMarker(node: Node): boolean {
  return node instanceof HTMLElement && node.classList.contains('marker');
}

function hasTextAfter(node: Node): boolean {
  for (let after = node.nextSibling; after; after = after.nextSibling) {
    if (after.textContent) return true;
  }
  return false;
}

/** The DOM point at UTF-16 display `offset` (see `pointInLine`). */
export function pointAt(
  elements: readonly HTMLElement[],
  model: LineModel,
  offset: number,
  before = false,
): [Node, number] {
  const index = model.lineAt(offset);
  return pointInLine(elements[index], offset - model.lines[index].start, before);
}

/** Show a splice of `model` in `elements` (spliced in place) and the page: reuse the
 *  replaced lines' elements, add or remove the rest, and draw the new lines and those the
 *  projection restyled, each once (a line the projection missed is drawn again once the
 *  engine describes it: applyViewChanges.ts). */
export function redraw(elements: HTMLElement[], model: LineModel, splice: LineSplice): void {
  const reused = elements.slice(splice.first, splice.first + splice.removed);
  const lines = Array.from(
    { length: splice.added },
    (_, index) => reused[index] ?? document.createElement('div'),
  );
  // The first line is always reused (a splice replaces at least one), so new lines go
  // after the reused ones, in their chunk.
  const touched = new Set<HTMLElement | null>();
  for (const stale of reused.slice(lines.length)) {
    touched.add(stale.parentElement);
    stale.remove();
  }
  const fresh = lines.slice(reused.length);
  if (fresh.length > 0) {
    const before = lines[reused.length - 1];
    before.after(...fresh);
    touched.add(before.parentElement);
  }
  settle(touched);
  elements.splice(splice.first, splice.removed, ...lines);
  const [from, to] = splice.restyled;
  const end = Math.max(to, splice.first + splice.added);
  for (let index = Math.min(from, splice.first); index < end; index++) {
    drawLine(elements[index], model.lines[index]);
  }
  // At a digit threshold (99 to 100 lines), the rest of a block for its gutter's width; after a
  // change to a table's column count or alignments, the rest of its rows.
  const widened = splice.widened;
  if (!widened) return;
  for (let index = widened[0]; index < widened[1]; index++) {
    if (index < Math.min(from, splice.first) || index >= end) {
      drawLine(elements[index], model.lines[index]);
    }
  }
}

/* Find's matches drawn in the note: one band per row of each match, behind the lines in a layer
 * of their own under the selection's (highlight.ts), so the lines' DOM and offsets stay the
 * engine's. A match never crosses a line (portable-core/find.md), so its bands are its text's
 * boxes on that line, merged per row. Only the matches on the lines near the screen are asked
 * for and drawn, as the selection's highlight draws only those lines. */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { LineModel } from './lineModel';
import { firstBelow, type Band } from './highlight';
import { pointInLine, withMeasuringRange } from './lineElements';
import { clipToTableRow } from './tableScroll';

/** A match's band; `current` is the match stepping is on. */
export interface FindBand extends Band {
  current: boolean;
}

/** The UTF-16 display range of the lines from a screen above the window's top to a screen
 *  below its bottom: the lines find draws matches on. Null with no lines. */
export function findWindowRange(
  elements: readonly HTMLElement[],
  model: LineModel,
): DisplayRange | null {
  if (elements.length === 0) return null;
  const screen = window.innerHeight;
  const first = Math.min(firstBelow(elements, -screen), elements.length - 1);
  const last = Math.min(firstBelow(elements, 2 * screen), elements.length - 1);
  const end = model.lines[last];
  return { start: model.lines[first].start, end: end.start + end.text.length };
}

/** The boxes, viewport px, of the text of `match` (UTF-16 display offsets), one per row. */
export function matchRects(
  elements: readonly HTMLElement[],
  model: LineModel,
  match: DisplayRange,
): DOMRect[] {
  const index = model.lineAt(match.start);
  const element = elements[index];
  const line = model.lines[index];
  if (!element) return [];
  const rects = withMeasuringRange((span) => {
    span.setStart(...pointInLine(element, match.start - line.start));
    span.setEnd(...pointInLine(element, match.end - line.start, true));
    return [...span.getClientRects()];
  });
  const rows = new Map<number, DOMRect>();
  for (const rect of rects) {
    if (rect.width === 0) continue;
    const row = Math.round(rect.top);
    const known = rows.get(row);
    if (!known) {
      rows.set(row, rect);
      continue;
    }
    const left = Math.min(known.left, rect.left);
    const right = Math.max(known.right, rect.right);
    const top = Math.min(known.top, rect.top);
    const bottom = Math.max(known.bottom, rect.bottom);
    rows.set(row, new DOMRect(left, top, right - left, bottom - top));
  }
  return [...rows.values()];
}

/** The bands of `matches`, relative to `origin`; the one equal to `current` is marked. */
export function findBands(
  elements: readonly HTMLElement[],
  model: LineModel,
  matches: readonly DisplayRange[],
  current: DisplayRange | null,
  origin: HTMLElement,
): FindBand[] {
  const base = origin.getBoundingClientRect();
  return matches.flatMap((match) => {
    const isCurrent = match.start === current?.start && match.end === current.end;
    const element = elements[model.lineAt(match.start)];
    const shown = matchRects(elements, model, match).flatMap(
      (rect) => clipToTableRow(element, rect) ?? [],
    );
    return shown.map((rect) => ({
      left: rect.left - base.left,
      top: rect.top - base.top,
      width: rect.width,
      height: rect.height,
      current: isCurrent,
    }));
  });
}

/** The layer the bands draw in, behind the lines and the selection's highlight. */
export class FindLayer {
  private readonly layer = document.createElement('div');

  constructor(wrap: HTMLElement) {
    this.layer.className = 'desktop-find';
    this.layer.setAttribute('aria-hidden', 'true');
    wrap.prepend(this.layer);
  }

  draw(bands: readonly FindBand[]): void {
    const layer = this.layer;
    while (layer.children.length > bands.length) layer.lastElementChild!.remove();
    while (layer.children.length < bands.length) layer.append(document.createElement('div'));
    bands.forEach((band, index) => {
      const element = layer.children[index] as HTMLElement;
      element.classList.toggle('current', band.current);
      const style = element.style;
      style.transform = `translate(${band.left}px, ${band.top}px)`;
      style.width = `${band.width}px`;
      style.height = `${band.height}px`;
    });
  }
}

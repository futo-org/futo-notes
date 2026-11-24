/* The desktop editor's lines (features/editor/desktop) as Puppet reads them: each line's kind
 * as drawn, its text as `doc` shows it, which lines a person sees, and the note's text with the
 * display offset of each of its characters, for the text anchors. */
import type { Line } from '$features/editor/desktop/lineModel';
import { scrollerOf } from '$features/editor/desktop/paneScroll';
import type { EditorView } from '$features/editor/desktop/view';
import type { OnScreen } from './puppetText';

/** A line's kind as drawn, outermost first, joined by ` > `: `quote` per quote level, then a
 *  list item's marker on its first line (`bullet`, a numbered item's marker as typed such as `3.`
 *  or `3)`, `task ☐`, `task ☑`), then `heading1`…, `divider`, `code` (`code js` with its block's
 *  language, on every line of the block), `table header`, `table delimiter` or `table row`,
 *  `paragraph`, or `gap` for an empty line of body text. */
export function kindOf(line: Line, codeLanguage: string | null): string {
  const parts: string[] = Array.from({ length: line.quote }, () => 'quote');
  const list = line.list;
  if (list?.first && list.marker !== '') {
    if (list.checked !== null) parts.push(list.checked ? 'task ☑' : 'task ☐');
    else parts.push(list.ordered ? list.marker : 'bullet');
  }
  if (line.code) parts.push(codeLanguage === null ? 'code' : `code ${codeLanguage}`);
  else if (line.heading) parts.push(`heading${line.heading}`);
  else if (line.divider) parts.push('divider');
  else if (line.table) parts.push(`table ${line.table.role}`);
  else if (parts.length === 0) parts.push(line.text === '' ? 'gap' : 'paragraph');
  return parts.join(' > ');
}

/** Each line's kind, a code block's language carried from its first line to the rest. */
export function kindsOf(lines: readonly Line[]): string[] {
  let codeLanguage: string | null = null;
  return lines.map((line) => {
    if (line.code?.first) codeLanguage = line.code.language;
    return kindOf(line, line.code ? codeLanguage : null);
  });
}

/** The UTF-16 ranges of a line's list marker units, which `doc`'s text leaves out (its kind
 *  names the marker) while its offsets count them. */
function markerRanges(line: Line): Array<[number, number]> {
  return line.atoms
    .filter((atom) => atom.kind === 'ListMarker')
    .map((atom): [number, number] => [atom.start, atom.end]);
}

/** A line's text as `doc` reports it: without a list item's marker unit. */
export function docTextOf(line: Line): string {
  let text = line.text;
  for (const [start, end] of markerRanges(line).reverse()) {
    text = text.slice(0, start) + text.slice(end);
  }
  return text;
}

/** The note's text as `doc` shows it, lines joined by newlines, and for each of its characters
 *  (and the end) the display offset it stands at. */
export interface ShownText {
  text: string;
  offsets: number[];
}

export function shownTextOf(lines: readonly Line[]): ShownText {
  let text = '';
  const offsets: number[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      offsets.push(lines[index - 1].start + lines[index - 1].text.length);
      text += '\n';
    }
    const markers = markerRanges(line);
    for (let unit = 0; unit < line.text.length; unit++) {
      if (markers.some(([start, end]) => unit >= start && unit < end)) continue;
      offsets.push(line.start + unit);
      text += line.text[unit];
    }
  });
  const last = lines[lines.length - 1];
  offsets.push(last ? last.start + last.text.length : 0);
  return { text, offsets };
}

/** The part of the window the note's pane shows, in viewport CSS px. */
function visibleBand(view: EditorView): { top: number; bottom: number } {
  const pane = scrollerOf(view.dom).getBoundingClientRect();
  return { top: Math.max(pane.top, 0), bottom: Math.min(pane.bottom, innerHeight) };
}

/** Which lines (1-based) a person looking at the pane sees, null when none: two binary searches
 *  over where the line elements paint, so the cost follows the screen, not the note. */
export function textLinesOnScreen(view: EditorView): OnScreen | null {
  const elements = view.lineElements();
  if (elements.length === 0 || !view.dom.isConnected) return null;
  const band = visibleBand(view);
  const firstBelow = (y: number): number => {
    let low = 0;
    let high = elements.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (elements[middle].getBoundingClientRect().bottom <= y) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const first = firstBelow(band.top);
  let last = first;
  while (last < elements.length && elements[last].getBoundingClientRect().top < band.bottom) last++;
  return last > first ? { first: first + 1, last } : null;
}

/** The text of the lines on screen, as a person reads them there. */
export function textOnScreen(view: EditorView): string {
  const onScreen = textLinesOnScreen(view);
  if (!onScreen) return '';
  return view
    .displayLines()
    .slice(onScreen.first - 1, onScreen.last)
    .map(docTextOf)
    .join(' ');
}

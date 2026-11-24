/* Whether the page shows the engine's reading of the note: its lines against the engine's
 * full projection, and its line elements against a fresh draw of those lines. Off the
 * keystroke path: the differential test and Puppet's reads ask, never an edit. */
import type { Line } from './lineModel';
import { drawLine } from './lineElements';
import { drawnCodeChrome, isCodeChrome } from './codeBlockChrome';
import { withoutPictureState } from './pictureElements';
import { TABLE_SCROLL } from './tableRowElements';

function describeLine(line: Line | undefined): string {
  if (!line) return 'no line';
  const { text, cr, start, byteStart, heading, list, quote, divider, code, table } = line;
  const { runs, atoms, links, gaps } = line;
  return JSON.stringify({
    text,
    cr,
    start,
    byteStart,
    heading,
    list,
    quote,
    divider,
    code,
    table,
    runs,
    atoms,
    links,
    gaps,
  });
}

/** The first line whose text, offsets, block (a code line's place and gutter width included),
 *  formats, atoms or gaps differ between `shown` and `read`
 *  (the engine's full projection, `LineModel.from`), described; null when all agree. */
export function lineModelDrift(shown: readonly Line[], read: readonly Line[]): string | null {
  const count = Math.max(shown.length, read.length);
  for (let index = 0; index < count; index++) {
    const page = describeLine(shown[index]);
    const engine = describeLine(read[index]);
    if (page !== engine) return `line ${index + 1}: the page has ${page}, the engine ${engine}`;
  }
  return null;
}

/** What an element draws: its classes, its other attributes, its style (but a table's layout
 *  and the mark on a delimiter row being written, which are the page's) and its content, a code line's chrome by what it draws from the line
 *  (codeBlockChrome.ts `drawnCodeChrome`). An emptied `style` attribute draws nothing, as a
 *  missing one. */
function describeElement(element: HTMLElement): string {
  // A picture's load and selection are the page's, not its line's.
  if (element.querySelector('.atom.image')) element = withoutPictureState(element);
  const attributes = [...element.attributes]
    .filter((attribute) => attribute.name !== 'style' && attribute.name !== 'data-writing')
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .sort();
  let content = element.innerHTML;
  if (isCodeChrome(element.firstChild)) {
    const rest = element.cloneNode(true) as HTMLElement;
    let chrome = '';
    while (isCodeChrome(rest.firstChild)) {
      chrome += drawnCodeChrome(rest.firstChild);
      rest.firstChild.remove();
    }
    content = chrome + rest.innerHTML;
  }
  const style = [...element.style]
    .filter((name) => name !== TABLE_SCROLL)
    .map((name) => `${name}: ${element.style.getPropertyValue(name)}`);
  return JSON.stringify([attributes, style, content]);
}

/** The first of `elements` (indices `from` to `to`) that does not draw what a new element
 *  drawn from its line of `lines` would, described; null when all agree. */
export function drawnLineDrift(
  elements: readonly HTMLElement[],
  lines: readonly Line[],
  from = 0,
  to = lines.length,
): string | null {
  if (elements.length !== lines.length) {
    return `the page draws ${elements.length} line elements for ${lines.length} lines`;
  }
  for (let index = from; index < to; index++) {
    const fresh = document.createElement('div');
    drawLine(fresh, lines[index]);
    const drawn = describeElement(elements[index]);
    const expected = describeElement(fresh);
    if (drawn !== expected) return `line ${index + 1} draws ${drawn}, its line ${expected}`;
  }
  return null;
}

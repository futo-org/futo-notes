import type { Line } from './lineModel';
import { atomClass } from './atomElements';
import { pictureOf } from './pictureElements';
import { classedRuns } from './lineLinks';

/** A piece of a line drawn alike: plain text, one classed run (a span classed by its formats
 *  and `link`: lineLinks.ts `classedRuns`; on a code line, by its syntax colour's token
 *  classes), one atom (an element holding the atom's text) or the `<br>` that gives a line
 *  with no text of its own its row. */
export interface Segment {
  kind: 'text' | 'run' | 'atom' | 'break';
  text: string;
  className: string;
}

const BREAK: Segment = { kind: 'break', text: '', className: '' };

/** The pieces `line` is drawn in: its text cut at every run's and atom's edge. A line with no
 *  text, or only a list marker (drawn out of the text's flow), ends in a break. */
export function segmentsOf(line: Line): Segment[] {
  const { text, atoms } = line;
  // A code line's text is literal (no formats or links): its runs are its syntax colours.
  const runs = line.code ? line.colours : classedRuns(line);
  if (runs.length === 0 && atoms.length === 0) return text === '' ? [BREAK] : [plain(text)];
  const segments: Segment[] = [];
  let at = 0;
  let run = 0;
  for (const atom of [...atoms, null]) {
    const stop = atom ? atom.start : text.length;
    for (; run < runs.length && runs[run].start < stop; run++) {
      const { start, end, className } = runs[run];
      const from = Math.max(start, at);
      if (from > at) segments.push(plain(text.slice(at, from)));
      const to = Math.min(end, stop);
      if (to > from) segments.push({ kind: 'run', text: text.slice(from, to), className });
      at = Math.max(at, to);
      if (end > stop) break;
    }
    if (stop > at) segments.push(plain(text.slice(at, stop)));
    if (!atom) break;
    // A wikilink's label takes the formats of the run around it, as a link's label does.
    const around = atom.kind === 'Wikilink' ? runs[run] : undefined;
    const formats =
      around && around.start <= atom.start && around.end >= atom.end ? ` ${around.className}` : '';
    const className = atomClass(atom, line.list) + formats;
    segments.push({ kind: 'atom', text: text.slice(atom.start, atom.end), className });
    at = atom.end;
    // A run cut by the atom goes on after it.
    while (run < runs.length && runs[run].end <= at) run++;
  }
  const last = atoms[atoms.length - 1];
  if (last?.kind === 'ListMarker' && last.end === text.length) segments.push(BREAK);
  return segments;
}

function plain(text: string): Segment {
  return { kind: 'text', text, className: '' };
}

/** The text node `node` draws `segment` in, if it is that kind of node: a break has none. An
 *  image atom's element holds its picture after its text (pictureElements.ts). */
export function textOf(node: ChildNode, segment: Segment): Text | null {
  if (segment.kind === 'text') return node instanceof Text ? node : null;
  if (segment.kind === 'break') return null;
  const text = node.firstChild;
  return node instanceof HTMLSpanElement &&
    node.className === segment.className &&
    text instanceof Text &&
    (node.childNodes.length === 1 || (node.childNodes.length === 2 && !!pictureOf(node)))
    ? text
    : null;
}

/** Whether `node` already draws `segment` as it is. */
export function draws(node: ChildNode, segment: Segment): boolean {
  if (segment.kind === 'break') return node instanceof HTMLBRElement;
  return textOf(node, segment)?.data === segment.text;
}

/** A new node drawing `segment`. */
export function createSegment(segment: Segment): Node {
  if (segment.kind === 'break') return document.createElement('br');
  const text = document.createTextNode(segment.text);
  if (segment.kind === 'text') return text;
  const span = document.createElement('span');
  span.className = segment.className;
  span.append(text);
  return span;
}

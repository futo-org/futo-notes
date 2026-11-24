/* A line's links and wikilinks, from the engine's projection (portable-core/links.md,
 * wikilinks.md), in UTF-16 units from the line's start. A link is its label (the engine hides
 * `[`, `](url)`) or a web address; a wikilink is drawn as one atom (lineModel.ts `LineAtom`)
 * holding its whole `[[target]]` and showing the engine's label. */
import type {
  Affinity,
  LinkDescription,
  WikilinkDescription,
} from '@futo-notes/editor/wasm-payloads';
import type { Line, LineAtom } from './lineModel';
import { utf16Within } from './lineModel';
import { TAG_CLASS } from './lineTags';

/** A link's label or a web address on a line, and where it goes as written. */
export interface LineLink {
  start: number;
  end: number;
  destination: string;
}

/** A wikilink on a line: one atom whose text is its `[[target]]` and which shows `label`;
 *  `noteId` is the note it resolves to, null when it resolves to none (or to several). */
export interface WikilinkAtom {
  kind: 'Wikilink';
  start: number;
  end: number;
  /** A wikilink shows no picture (lineModel.ts `LineAtom`). */
  image: null;
  target: string;
  label: string;
  noteId: string | null;
}

const NO_LINKS: readonly LineLink[] = [];

/** The UTF-16 range on `line` (whose text is `bytes` long) of display bytes `start`..`end`. */
export function unitsOn(line: Line, bytes: number, start: number, end: number): [number, number] {
  const within = (byte: number) => Math.min(Math.max(byte - line.byteStart, 0), bytes);
  const ascii = bytes === line.text.length;
  const at = (byte: number) => (ascii ? within(byte) : utf16Within(line.text, within(byte)));
  return [at(start), at(end)];
}

/** The links of `links` (display bytes, in order, from index `first`) on `line`, whose text is
 *  `bytes` long. */
export function linksOnLine(
  line: Line,
  bytes: number,
  links: readonly LinkDescription[],
  first: number,
): readonly LineLink[] {
  let found: LineLink[] | null = null;
  const end = line.byteStart + bytes;
  for (let index = first; index < links.length && links[index].range.start < end; index++) {
    const { range, destination } = links[index];
    if (range.end <= line.byteStart) continue;
    const [from, to] = unitsOn(line, bytes, range.start, range.end);
    (found ??= []).push({ start: from, end: to, destination });
  }
  return found ?? NO_LINKS;
}

/** `atoms` with the wikilinks of `wikilinks` (display bytes, in order, from index `first`) on
 *  `line` among them, in order. */
export function withWikilinks(
  line: Line,
  bytes: number,
  atoms: readonly LineAtom[],
  wikilinks: readonly WikilinkDescription[],
  first: number,
): readonly LineAtom[] {
  const end = line.byteStart + bytes;
  let found: LineAtom[] | null = null;
  for (let index = first; index < wikilinks.length && wikilinks[index].range.start < end; index++) {
    const { range, target, label, note_id } = wikilinks[index];
    const [from, to] = unitsOn(line, bytes, range.start, range.end);
    (found ??= [...atoms]).push({
      kind: 'Wikilink',
      start: from,
      end: to,
      image: null,
      target,
      label,
      noteId: note_id,
    });
  }
  return found ? found.sort((one, other) => one.start - other.start) : atoms;
}

/** The class of a link's label and a web address. */
export const LINK_CLASS = 'link';

/** A stretch of a line drawn alike, in UTF-16 units from its start, and its class: its
 *  formats (`bold italic`), `link` on a link and `tag` on a tag. */
export interface ClassedRun {
  start: number;
  end: number;
  className: string;
}

/** `line`'s formatted runs, its links and its tags as one list of stretches, cut at every edge
 *  of any, in order: only those formatted, linked or tagged. */
export function classedRuns(line: Line): ClassedRun[] {
  const { runs, links, tags } = line;
  const formatClass = (index: number) => runs[index].formats.join(' ').toLowerCase();
  if (links.length === 0 && tags.length === 0) {
    return runs.map((run, index) => ({
      start: run.start,
      end: run.end,
      className: formatClass(index),
    }));
  }
  const edges = new Set<number>();
  for (const { start, end } of [...runs, ...links, ...tags]) edges.add(start).add(end);
  const cuts = [...edges].sort((one, other) => one - other);
  const classed: ClassedRun[] = [];
  let run = 0;
  let link = 0;
  let tag = 0;
  for (let index = 0; index + 1 < cuts.length; index++) {
    const [start, end] = [cuts[index], cuts[index + 1]];
    while (run < runs.length && runs[run].end <= start) run++;
    while (link < links.length && links[link].end <= start) link++;
    while (tag < tags.length && tags[tag].end <= start) tag++;
    const formatted = run < runs.length && runs[run].start <= start ? formatClass(run) : '';
    const linked = link < links.length && links[link].start <= start;
    const tagged = tag < tags.length && tags[tag].start <= start;
    const className = [formatted, linked ? LINK_CLASS : '', tagged ? TAG_CLASS : '']
      .filter((name) => name !== '')
      .join(' ');
    if (className) classed.push({ start, end, className });
  }
  return classed;
}

/** The side of UTF-16 `at` (from `line`'s start) outside the link that ends or starts there:
 *  a letter typed at a link's edge is never the link's (the engine types on the side its
 *  affinity names). Null away from an edge, and between two links that touch. */
export function outsideLinkEdge(line: Line, at: number): Affinity | null {
  let ends = false;
  let starts = false;
  for (const link of line.links) {
    ends ||= link.end === at;
    starts ||= link.start === at;
  }
  if (ends === starts) return null;
  return ends ? 'Forward' : 'Backward';
}

/** The wikilink on `line` that UTF-16 `at` (from the line's start) is strictly inside. */
export function wikilinkAround(line: Line, at: number): WikilinkAtom | null {
  for (const atom of line.atoms) {
    if (atom.kind === 'Wikilink' && atom.start < at && at < atom.end) return atom;
  }
  return null;
}

/* The display text as lines, in the two coordinate systems the engine speaks:
 * UTF-16 units (the DOM's offsets and the `_utf16` methods) and UTF-8 bytes
 * (projections and view changes). A `\r` before a line's `\n` is display text but
 * never drawn, so the caret cannot land between the two; a lone `\r` ends a line. */
import type {
  AtomDescription,
  AtomKind,
  DisplayRange,
  ImageDescription,
  InlineFormat,
  ListDescription,
  ProjectionSlice,
  SemanticRun,
  ViewChange,
} from '@futo-notes/editor/wasm-payloads';
import { fitBlockNeighbours, NO_GAPS, type LineGaps } from './blockNeighbours';
import { codeLineOf, gutterDigits, type CodeLine } from './codeLines';
import { linksOnLine, withWikilinks, type LineLink, type WikilinkAtom } from './lineLinks';
import { fitTableLines, tableLineOf, type TableLine } from './tableLines';
import { NO_TAGS, tagsOnLine, type LineTag } from './lineTags';

/** A stretch of a line drawn with inline formats, in UTF-16 units from the line's start. */
export interface FormatRun {
  start: number;
  end: number;
  formats: readonly InlineFormat[];
}

/** A stretch of a code line drawn in a syntax colour, its token classes (`tok-keyword`), in
 *  UTF-16 units from the line's start: the page's own reading (codeColours.ts), not the engine's. */
export interface ColourRun {
  start: number;
  end: number;
  className: string;
}

/** One unit of the display text the engine draws as an object (a divider, a list item's
 *  marker, an image: its whole spelling), in UTF-16 units from the line's start; or a
 *  wikilink, which the page draws as one (lineLinks.ts). */
export type LineAtom =
  | {
      kind: AtomKind;
      start: number;
      end: number;
      /** What an image atom shows; null for the other kinds. */
      image: ImageDescription | null;
    }
  | WikilinkAtom;
/** A line with no formatted text or atoms: shared empty lists, so plain lines cost nothing. */
const NO_RUNS: readonly FormatRun[] = [];
const NO_ATOMS: readonly LineAtom[] = [];
export const NO_COLOURS: readonly ColourRun[] = [];
const NO_LINKS: readonly LineLink[] = [];

export interface Line {
  /** Drawn text: the line without its `\r`. */
  text: string;
  cr: boolean;
  /** UTF-16 offset of the line's first unit. */
  start: number;
  /** UTF-8 offset of the same point. */
  byteStart: number;
  /** 0 for body text, 1–6 for a heading line. */
  heading: number;
  /** The list item the line is in, as the engine describes it (its marker draws on the item's
   *  first line only); null outside a list. */
  list: ListDescription | null;
  /** How many quotes the line is in. */
  quote: number;
  /** A divider (`---`): its text is the atom's one `\uFFFC`. */
  divider: boolean;
  /** Its place in a fenced code block; null outside one. */
  code: CodeLine | null;
  /** Its place in a table; null outside one. */
  table: TableLine | null;
  /** Its formatted stretches, in order: the engine's runs, clipped to the line. */
  runs: readonly FormatRun[];
  /** Its atoms, in order, as the engine's projection reports them, its wikilinks among them. */
  atoms: readonly LineAtom[];
  /** Its syntax colours, in order, while it is a code line. */
  colours: readonly ColourRun[];
  /** Its links and web addresses, in order. */
  links: readonly LineLink[];
  /** Its `#tag`s, in order (lineTags.ts). */
  tags: readonly LineTag[];
  /** A line of the note's leading front matter: inert metadata, shown as it is. */
  metadata: boolean;
  /** The gaps it keeps from the blocks beside it (blockNeighbours.ts). */
  gaps: LineGaps;
}

/** Lines `first` to `first + removed` were replaced by `added` lines there, and the
 *  change's projection restyled lines `restyled[0]` to `restyled[1]`. `guessed` are the new
 *  lines it did not reach: their block and formats are `splitLines`' guess until the engine
 *  describes them (`describeLines`). */
export interface LineSplice {
  first: number;
  removed: number;
  added: number;
  restyled: [number, number];
  /** The lines past `restyled` the change reached: a code block's whose gutter it widened or
   *  narrowed (`fitGutters`), a block's end now beside another block or no longer
   *  (`fitBlockNeighbours`), a table's whose columns or alignments it changed (`fitTables`). */
  widened: [number, number] | null;
  guessed: readonly Line[];
}

export function utf8Length(text: string, from = 0, to = text.length): number {
  let bytes = 0;
  for (let index = from; index < to; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    // A surrogate pair is 4 bytes; count 2 for each half.
    else if (unit >= 0xd800 && unit < 0xe000) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

export function utf16Within(text: string, bytes: number): number {
  let index = 0;
  for (let counted = 0; counted < bytes; index++) counted += utf8Length(text, index, index + 1);
  return index;
}

/** A guess, until the engine describes the lines: the first keeps `kind`'s block (heading,
 *  list, quote, divider), the lines after it are body text, and every line is plain. */
function splitLines(text: string, start: number, byteStart: number, kind?: Line): Line[] {
  const lines: Line[] = [];
  // A line ends at `\n`, `\r\n` or a lone `\r`, as the engine reads line endings; the
  // ending after the line's text is one unit wide but CRLF's hidden `\r`.
  const parts = text.split(/(\r\n|\r|\n)/);
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index];
    const cr = parts[index + 1] === '\r\n';
    lines.push({
      text,
      cr,
      start,
      byteStart,
      heading: (lines.length === 0 && kind?.heading) || 0,
      list: (lines.length === 0 && kind?.list) || null,
      quote: (lines.length === 0 && kind?.quote) || 0,
      divider: lines.length === 0 && !!kind?.divider,
      code: (lines.length === 0 && kind?.code) || null,
      table: (lines.length === 0 && kind?.table) || null,
      runs: NO_RUNS,
      atoms: NO_ATOMS,
      colours: NO_COLOURS,
      links: NO_LINKS,
      tags: NO_TAGS,
      metadata: lines.length === 0 && !!kind?.metadata,
      gaps: NO_GAPS,
    });
    start += text.length + (cr ? 2 : 1);
    byteStart += utf8Length(text) + (cr ? 2 : 1);
  }
  return lines;
}

/** The formatted ones of `runs` (display bytes, in order, from index `first`) on `line`, whose
 *  text is `bytes` long, in the line's UTF-16 units. */
function formatRuns(
  line: Line,
  bytes: number,
  runs: readonly SemanticRun[],
  first: number,
): readonly FormatRun[] {
  let found: FormatRun[] | null = null;
  const ascii = bytes === line.text.length;
  const unitAt = (byte: number) => {
    const within = Math.min(Math.max(byte - line.byteStart, 0), bytes);
    return ascii ? within : utf16Within(line.text, within);
  };
  const end = line.byteStart + bytes;
  for (let index = first; index < runs.length && runs[index].range.start < end; index++) {
    const run = runs[index];
    if (run.formats.length === 0 || run.range.end <= line.byteStart) continue;
    (found ??= []).push({
      start: unitAt(run.range.start),
      end: unitAt(run.range.end),
      formats: run.formats,
    });
  }
  return found ?? NO_RUNS;
}

/** The atoms of `atoms` (display bytes, in order, from index `first`) on `line`, whose text is
 *  `bytes` long, in the line's UTF-16 units. */
function lineAtoms(
  line: Line,
  bytes: number,
  atoms: readonly AtomDescription[],
  first: number,
): readonly LineAtom[] {
  let found: LineAtom[] | null = null;
  const end = line.byteStart + bytes;
  for (let index = first; index < atoms.length && atoms[index].range.start < end; index++) {
    const { kind, range, image } = atoms[index];
    const start = utf16Within(line.text, range.start - line.byteStart);
    (found ??= []).push({
      kind,
      start,
      end: start + utf16Within(line.text.slice(start), range.end - range.start),
      image,
    });
  }
  return found ?? NO_ATOMS;
}

/** The lines two ranges reach, or null when neither is. */
function spanOf(
  one: [number, number] | null,
  other: [number, number] | null,
): [number, number] | null {
  if (!one || !other) return one ?? other;
  return [Math.min(one[0], other[0]), Math.max(one[1], other[1])];
}

const width = (line: Line) => line.text.length + (line.cr ? 1 : 0);

export class LineModel {
  private constructor(readonly lines: Line[]) {}

  static from(slice: ProjectionSlice): LineModel {
    const model = new LineModel(splitLines(slice.text, 0, 0));
    fitBlockNeighbours(model.lines, model.applyBlocks(slice));
    return model;
  }

  /** The line holding UTF-16 `offset`; a line's end belongs to it, not the next. */
  lineAt(offset: number): number {
    return this.search((line) => line.start <= offset);
  }

  private lineAtByte(offset: number): number {
    return this.search((line) => line.byteStart <= offset);
  }

  private search(before: (line: Line) => boolean): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (before(this.lines[middle])) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  toUtf16(byteOffset: number): number {
    const line = this.lines[this.lineAtByte(byteOffset)];
    const full = line.cr ? `${line.text}\r` : line.text;
    return line.start + utf16Within(full, byteOffset - line.byteStart);
  }

  toByte(offset: number): number {
    const line = this.lines[this.lineAt(offset)];
    const full = line.cr ? `${line.text}\r` : line.text;
    return line.byteStart + utf8Length(full, 0, offset - line.start);
  }

  /** Apply an edit already made in the engine; `change.range` addresses this
   *  model's (old) display. Of two equal neighbouring line breaks the engine names the later
   *  one, so its projection can miss a rebuilt line: those are `guessed`. */
  splice(change: ViewChange): LineSplice {
    const start = this.toUtf16(change.range.start);
    const end = this.toUtf16(change.range.end);
    const first = this.lineAt(start);
    const last = this.lineAt(end);
    const head = this.lines[first];
    const tail = this.lines[last];
    // A CRLF's `\r` is display text: a change can take it and keep the `\n` (an Enter that
    // writes the break as `\n` over a selection ending after a CRLF) or put one back before a
    // `\n` (its Undo). The break after a line without CRLF is taken to be `\n`: a lone `\r`
    // there (classic Mac endings) given a `\r` before it would be two breaks, not one CRLF.
    const withCr = (line: Line) => (line.cr ? `${line.text}\r` : line.text);
    let text =
      withCr(head).slice(0, start - head.start) +
      change.inserted +
      withCr(tail).slice(end - tail.start);
    const cr = last < this.lines.length - 1 && text.endsWith('\r');
    if (cr) text = text.slice(0, -1);
    const replaced = splitLines(text, head.start, head.byteStart, head);
    replaced[replaced.length - 1].cr = cr;
    const shift = change.inserted.length - (end - start);
    const byteShift = utf8Length(change.inserted) - (change.range.end - change.range.start);
    for (let index = last + 1; index < this.lines.length; index++) {
      this.lines[index].start += shift;
      this.lines[index].byteStart += byteShift;
    }
    this.lines.splice(first, last - first + 1, ...replaced);
    const restyled = this.applyBlocks(change.projection);
    const replacedLines: [number, number] = [first, first + replaced.length];
    const widened = spanOf(
      spanOf(
        this.fitGutters(change.projection, restyled),
        this.fitTables(change.projection, restyled),
      ),
      spanOf(
        fitBlockNeighbours(this.lines, restyled),
        fitBlockNeighbours(this.lines, replacedLines),
      ),
    );
    const guessed = replaced.filter(
      (_, offset) => first + offset < restyled[0] || first + offset >= restyled[1],
    );
    return { first, removed: last - first + 1, added: replaced.length, restyled, widened, guessed };
  }

  /** Give those of `lines` still in the model the engine's block and formats, read through
   *  `project` (display bytes, the engine's current revision); returns the line range
   *  restyled (the lines `fitGutters`, `fitBlockNeighbours` and `fitTables` reached included), or null when none of them
   *  is left. */
  describeLines(
    lines: readonly Line[],
    project: (range: DisplayRange) => ProjectionSlice,
  ): [number, number] | null {
    let first = Infinity;
    let last = -1;
    for (const line of lines) {
      const index = this.lineAtByte(line.byteStart);
      if (this.lines[index] !== line) continue;
      first = Math.min(first, index);
      last = Math.max(last, index);
    }
    if (last < 0) return null;
    const from = this.lines[first];
    const to = this.lines[last];
    const slice = project({ start: from.byteStart, end: to.byteStart + utf8Length(to.text) });
    const restyled = this.applyBlocks(slice);
    const widened = spanOf(
      spanOf(this.fitGutters(slice, restyled), this.fitTables(slice, restyled)),
      fitBlockNeighbours(this.lines, restyled),
    );
    if (!widened) return restyled;
    return [Math.min(restyled[0], widened[0]), Math.max(restyled[1], widened[1])];
  }

  /** A block's gutter is as wide on all its lines as its line count's digits, and a change
   *  describes only the lines it read again (`restyled`): where the count's digits changed,
   *  the block's other lines are given the new width. Only a block's two ends need checking,
   *  as the lines described are one stretch. Returns the block lines restyled, if any. */
  private fitGutters(
    slice: ProjectionSlice,
    [from, to]: [number, number],
  ): [number, number] | null {
    let widened: [number, number] | null = null;
    for (const block of slice.code_blocks) {
      const digits = gutterDigits(block.line_count);
      const first = this.lineAtByte(block.range.start);
      const last = this.lineAtByte(block.range.end);
      const stale = (index: number) => {
        const code = this.lines[index].code;
        return (index < from || index >= to) && !!code && code.digits !== digits;
      };
      if (!stale(first) && !stale(last)) continue;
      for (let index = first; index <= last; index++) {
        const line = this.lines[index];
        if (line.code && line.code.digits !== digits) line.code = { ...line.code, digits };
      }
      widened = widened
        ? [Math.min(widened[0], first), Math.max(widened[1], last + 1)]
        : [first, last + 1];
    }
    return widened;
  }

  /** The rows of `slice`'s tables outside lines `restyled` given their table's column count and
   *  alignments where a change reached them (tableLines.ts); returns those lines, if any. */
  private fitTables(slice: ProjectionSlice, restyled: [number, number]): [number, number] | null {
    const lineAtByte = (byte: number): number => this.lineAtByte(byte);
    return fitTableLines(this.lines, restyled, slice.tables, lineAtByte);
  }

  /** Restyle the lines a projection covers (the engine describes each display line as a
   *  block: heading, list item, quote depth, divider, code line, table line; its formatted text
   *  as runs; and its atoms); returns that line range. */
  applyBlocks(slice: ProjectionSlice): [number, number] {
    const from = this.lineAtByte(slice.range.start);
    let last = this.lineAtByte(slice.range.end);
    // A line starting exactly where the slice ends is outside it, unless a block there says
    // otherwise or it is the note's empty last line (after a final line break): no block
    // describes that line, it is body text, and the slice reaches it.
    const end = slice.range.end;
    const emptyLast = last === this.lines.length - 1 && this.lines[last].text === '';
    if (
      last > from &&
      !emptyLast &&
      this.lines[last].byteStart === end &&
      slice.blocks[slice.blocks.length - 1]?.range.start !== end
    ) {
      last--;
    }
    const to = last + 1;
    let next = 0;
    let nextRun = 0;
    let nextAtom = 0;
    let nextCodeBlock = 0;
    let nextTable = 0;
    let nextLink = 0;
    let nextWikilink = 0;
    let nextTag = 0;
    const { links, wikilinks, tags } = slice;
    const codeBlocks = slice.code_blocks;
    const tables = slice.tables;
    const runs = slice.runs;
    const atoms = slice.atoms;
    for (let index = from; index < to; index++) {
      const line = this.lines[index];
      const bytes = utf8Length(line.text);
      const lineEnd = line.byteStart + bytes + (line.cr ? 1 : 0);
      while (next < slice.blocks.length && slice.blocks[next].range.end < line.byteStart) next++;
      const candidate = slice.blocks[next];
      const block = candidate && candidate.range.start <= lineEnd ? candidate : undefined;
      line.heading = block?.heading ?? 0;
      line.list = block?.list ?? null;
      line.quote = block?.quote_depth ?? 0;
      line.divider = block?.divider ?? false;
      line.metadata = block?.metadata ?? false;
      // A line is in the block whose range holds its start.
      while (
        nextCodeBlock < codeBlocks.length &&
        codeBlocks[nextCodeBlock].range.end < line.byteStart
      ) {
        nextCodeBlock++;
      }
      line.code = codeLineOf(block?.code, codeBlocks[nextCodeBlock]);
      while (nextTable < tables.length && tables[nextTable].range.end < line.byteStart) nextTable++;
      line.table = tableLineOf(line, bytes, block?.table, tables[nextTable]);
      while (nextRun < runs.length && runs[nextRun].range.end <= line.byteStart) nextRun++;
      line.runs = formatRuns(line, bytes, runs, nextRun);
      while (nextAtom < atoms.length && atoms[nextAtom].range.start < line.byteStart) nextAtom++;
      while (nextLink < links.length && links[nextLink].range.end <= line.byteStart) nextLink++;
      line.links = linksOnLine(line, bytes, links, nextLink);
      while (nextTag < tags.length && tags[nextTag].end <= line.byteStart) nextTag++;
      line.tags = tagsOnLine(line, bytes, tags, nextTag);
      while (
        nextWikilink < wikilinks.length &&
        wikilinks[nextWikilink].range.start < line.byteStart
      )
        nextWikilink++;
      const ownAtoms = lineAtoms(line, bytes, atoms, nextAtom);
      line.atoms = withWikilinks(line, bytes, ownAtoms, wikilinks, nextWikilink);
    }
    return [from, to];
  }

  get length(): number {
    const last = this.lines[this.lines.length - 1];
    return last.start + width(last);
  }
}

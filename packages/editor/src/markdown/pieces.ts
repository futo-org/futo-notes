/**
 * What a block is written as before its escapes are decided: lines of pieces,
 * where a piece is fixed text or a SITE — a spot with two spellings, the house
 * style's (index 0) and another (index 1). An ESCAPE site's other spelling is
 * the safe one: a character with a backslash or as a character reference, a
 * thematic break as `***`, a link written out in full. A LAYOUT site's is a
 * different line structure: a blank line the house style would not write, or a
 * line written without its list item's indent.
 *
 * Which sites take their other spelling is decided by parsing (`./choose.ts`),
 * never here. Several pieces may share one site number (an opening and a
 * closing delimiter), so they always change together.
 */

import type { NodeJson } from './docJson';

export interface SitePiece {
  readonly site: number;
  readonly options: readonly [string, string];
}

/** A line holding this (in any option) is not written at all. */
export const DROPPED_LINE = '\u0000';

export type Piece = string | SitePiece;
export type Line = Piece[];

/** Which characters a writer offers as escape sites (see `./inline.ts`). */
export type SiteScope = 'plausible' | 'every';

/**
 * One run of inline content — a heading's, a cell's, or a paragraph's lines up
 * to a line break no formatting spans — and the sites inside it. Escapes in
 * one unit should not change how another reads, so a unit's escapes are
 * decided with a parse of the unit alone, and the block is parsed once more to
 * confirm (`./choose.ts`).
 */
export interface InlineUnit {
  readonly lines: readonly Line[];
  /** The sites numbered `first` up to (not including) `end` belong to it. */
  readonly first: number;
  readonly end: number;
  /** Which paragraph, heading or cell of the block it is part of, in document order. */
  readonly leaf: number;
  /** Which of that paragraph's runs of lines it is (0 for a heading or a cell). */
  readonly segment: number;
  /** The unit as a document of its own, so it parses in the context it is written in. */
  readonly standalone: (text: string) => string;
}

/**
 * A top-level list item or table cell. Items and cells cannot change how
 * another reads — what joins them (markers, numbers, row pipes, blank lines) is
 * written by the block, not by their content — so each is checked against a
 * document of its own: a one-item list, a one-cell table. A list or table block
 * is then never parsed whole, which for a 2,000-item list is half a second.
 */
export interface BlockPart {
  readonly lines: readonly Line[];
  readonly first: number;
  readonly end: number;
  /** Whether anything in it could read differently, so it needs its parse at all. */
  readonly needsCheck: boolean;
  /** The part as a document of its own… */
  readonly standalone: (text: string) => string;
  /** …and what that document must read as. */
  readonly expected: readonly NodeJson[];
}

/** Per-block writing state: hands out site numbers and records whether a parse check is needed. */
export class Sites {
  count = 0;
  /** Set when the block holds anything a parse could read differently from what was meant. */
  needsCheck = false;
  /** The layout sites' numbers, in writing order. */
  readonly layout: number[] = [];
  /** The block's inline units, in document order. */
  readonly units: InlineUnit[] = [];
  /** A top-level list's items or table's cells (`BlockPart`); empty for any other block. */
  readonly parts: BlockPart[] = [];
  /** How many paragraphs, headings and cells have been written. */
  leaves = 0;

  constructor(readonly scope: SiteScope) {}

  piece(options: readonly [string, string]): SitePiece {
    this.needsCheck = true;
    return { site: this.count++, options };
  }

  layoutPiece(options: readonly [string, string]): SitePiece {
    const piece = this.piece(options);
    this.layout.push(piece.site);
    return piece;
  }

  /** A blank line written only if a parse needs it. */
  optionalLine(): Line {
    return [this.layoutPiece([DROPPED_LINE, ''])];
  }

  /**
   * Writes one part with `write`, recording it in `parts` with whether it
   * needs a check of its own.
   */
  part(
    write: () => Line[],
    standalone: (text: string) => string,
    expected: readonly NodeJson[],
  ): Line[] {
    const before = this.needsCheck;
    this.needsCheck = false;
    const first = this.count;
    const lines = write();
    this.parts.push({
      lines,
      first,
      end: this.count,
      needsCheck: this.needsCheck,
      standalone,
      expected,
    });
    this.needsCheck ||= before;
    return lines;
  }

  /** One site shared by several pieces. Returns a function that makes each piece. */
  shared(): (options: readonly [string, string]) => SitePiece {
    this.needsCheck = true;
    const site = this.count++;
    return (options) => ({ site, options });
  }
}

/** One line per entry; a choice per site number (missing = 0, the house style). */
export function render(lines: readonly Line[], choice: readonly number[] = []): string {
  const out: string[] = [];
  for (const line of lines) {
    let text = '';
    for (const piece of line) {
      text += typeof piece === 'string' ? piece : piece.options[choice[piece.site] ?? 0];
    }
    if (!text.includes(DROPPED_LINE)) out.push(text);
  }
  return out.join('\n');
}

/** A line with nothing on it — or an optional blank line, which a container prefixes as one. */
export function isBlankLine(line: Line): boolean {
  return line.every(
    (piece) => piece === '' || (typeof piece !== 'string' && piece.options[0] === DROPPED_LINE),
  );
}

/**
 * `lines` with `first` in front of the first line and `rest` in front of every
 * other non-blank one. A blank line gets `blank` (a quote's `>`, or nothing),
 * so a container never leaves trailing whitespace behind.
 */
export function prefixLines(
  lines: readonly Line[],
  first: string,
  rest: string,
  blank = '',
): Line[] {
  return lines.map((line, index) => {
    if (index === 0) return isBlankLine(line) ? [first.trimEnd(), ...line] : [first, ...line];
    return isBlankLine(line) ? [blank, ...line] : [rest, ...line];
  });
}

/** Splits fixed pieces at `\n` so every line is its own entry (sites never hold one). */
export function splitLines(pieces: readonly Piece[]): Line[] {
  const lines: Line[] = [[]];
  for (const piece of pieces) {
    if (typeof piece !== 'string' || !piece.includes('\n')) {
      (lines[lines.length - 1] as Line).push(piece);
      continue;
    }
    const parts = piece.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== '') (lines[lines.length - 1] as Line).push(part);
    });
  }
  return lines;
}

/** Blank lines, as entries. */
export function blankLines(count: number): Line[] {
  return Array.from({ length: count }, () => []);
}

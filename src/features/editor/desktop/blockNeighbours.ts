/* What a line's neighbours make of it, as facts on the line rather than a CSS `:has()`, which
 * WebKit checks again on every line added or removed. Blocks touch when one's last line is
 * right over another's first: a code block, a table, or a line holding only pictures. Two code
 * blocks that touch stand 4px apart in the lower one's top margin (codeLines.ts, its header's
 * room); a picture line keeps 4px of its own padding from a block it touches, above it or below
 * it (a picture line below carries the gap between two); the front matter panel keeps 8px of
 * its last line's padding from the body under it. Every gap is a line's, so a press in it lands
 * on that line. */
import type { Line } from './lineModel';

/** The gaps a line keeps inside its box from the lines beside it (desktopImages.css,
 *  desktopTags.css). */
export interface LineGaps {
  above: boolean;
  below: boolean;
}

export const NO_GAPS: LineGaps = { above: false, below: false };

/** Whether `line` holds only pictures: every unit of its text outside its images is a space. */
export function isPictureLine(line: Line): boolean {
  if (line.atoms.length === 0 || line.code || line.table) return false;
  let covered = 0;
  for (const atom of line.atoms) {
    if (atom.kind !== 'Image' || line.text.slice(covered, atom.start).trim()) return false;
    covered = atom.end;
  }
  return !line.text.slice(covered).trim();
}

function startsBlock(line: Line | undefined): boolean {
  if (!line) return false;
  return !!line.code?.first || line.table?.role === 'header' || isPictureLine(line);
}

function endsBlock(line: Line | undefined, next: Line | undefined): boolean {
  if (!line) return false;
  return !!line.code?.last || (!!line.table && !next?.table) || isPictureLine(line);
}

/** The gaps `line` keeps from `above` and `below`, the lines beside it. */
function gapsOf(line: Line, above: Line | undefined, below: Line | undefined): LineGaps {
  if (line.metadata) return { above: false, below: !!below && !below.metadata };
  if (!isPictureLine(line)) return NO_GAPS;
  return {
    above: endsBlock(above, line),
    below: startsBlock(below) && !isPictureLine(below!),
  };
}

/** Give lines `from` to `to` of `lines`, and the line on either side of them, the facts their
 *  neighbours make: a code block's first line right under another block's last line, its last
 *  line right over another's first (`codeLineOf` describes a line alone), and every line's
 *  gaps. Returns the lines outside `from` to `to` this restyled, if any. */
export function fitBlockNeighbours(
  lines: Line[],
  [from, to]: [number, number],
): [number, number] | null {
  let first = Infinity;
  let last = -1;
  const end = Math.min(to, lines.length - 1);
  for (let index = Math.max(from - 1, 0); index <= end; index++) {
    const line = lines[index];
    const above = lines[index - 1];
    const below = lines[index + 1];
    let changed = false;
    const code = line.code;
    if (code) {
      const underBlock = code.first && !!above?.code?.last;
      const overBlock = code.last && !!below?.code?.first;
      if (code.underBlock !== underBlock || code.overBlock !== overBlock) {
        line.code = { ...code, underBlock, overBlock };
        changed = true;
      }
    }
    const gaps = gapsOf(line, above, below);
    if (gaps.above !== line.gaps.above || gaps.below !== line.gaps.below) {
      line.gaps = gaps.above || gaps.below ? gaps : NO_GAPS;
      changed = true;
    }
    if (!changed || (index >= from && index < to)) continue;
    first = Math.min(first, index);
    last = Math.max(last, index);
  }
  return last < 0 ? null : [first, last + 1];
}

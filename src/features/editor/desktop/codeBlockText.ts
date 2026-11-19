/* A fenced code block's lines read as one text, as its grammar parses it (codeColours.ts): its
 * code lines joined by `\n`, a CRLF's hidden `\r` left out. */
import type { Line } from './lineModel';

/** The block holding code line `index`: its first line, and the line after its last. */
export function codeBlockAround(lines: readonly Line[], index: number): [number, number] {
  let first = index;
  while (first > 0 && !lines[first].code?.first) first--;
  let last = index;
  while (last < lines.length - 1 && lines[last].code && !lines[last].code?.last) last++;
  return [first, last + 1];
}

/** The text of lines `start` to `end`, joined by `\n`, and where each starts in it. */
export function codeBlockText(
  lines: readonly Line[],
  start: number,
  end: number,
): { text: string; lineStarts: number[] } {
  const texts: string[] = [];
  const lineStarts: number[] = [];
  let at = 0;
  for (let index = start; index < end; index++) {
    lineStarts.push(at);
    texts.push(lines[index].text);
    at += lines[index].text.length + 1;
  }
  return { text: texts.join('\n'), lineStarts };
}

/** The line holding `offset` of a block's text whose lines start at `lineStarts`. */
export function codeLineAtOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

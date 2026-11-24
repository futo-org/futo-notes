/* A fenced code block's lines as the page draws them: each line's place in its block, read from
 * the engine's line and block descriptions. Line numbers are not kept: CSS counts them
 * (desktopCodeBlocks.css), so none drawn below an edit can be stale. */
import type { CodeBlockDescription, CodeLineDescription } from '@futo-notes/editor/wasm-payloads';

export interface CodeLine {
  first: boolean;
  last: boolean;
  /** The block's line count's digits, at least two: its gutter's width, alike on every line. */
  digits: number;
  /** The block's language and `name:` as written, on its first line only (its header). */
  language: string | null;
  name: string | null;
  /** Its first line, right under another block's last line; its last line, right over another
   *  block's first line (blockNeighbours.ts `fitBlockNeighbours`). */
  underBlock: boolean;
  overBlock: boolean;
}

export function gutterDigits(lineCount: number): number {
  return Math.max(2, String(lineCount).length);
}

/** The code facts of a line the engine describes as `code`, in `block`. */
export function codeLineOf(
  code: CodeLineDescription | null | undefined,
  block: CodeBlockDescription | undefined,
): CodeLine | null {
  if (!code) return null;
  return {
    first: code.first,
    last: code.last,
    digits: gutterDigits(block?.line_count ?? 0),
    language: code.first ? (block?.language ?? null) : null,
    name: code.first ? (block?.name ?? null) : null,
    underBlock: false,
    overBlock: false,
  };
}

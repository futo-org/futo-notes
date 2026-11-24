/* Where the `/` menu opens (docs/spec/editor/desktop/slash-menu.md): the `/` starts a word, at
 * the start of its line's text (a list item's marker unit is not text; a heading's or a quote's
 * markers are hidden) or after a space or tab, the query runs from it to the caret and holds no
 * whitespace, and the `/` is not inline code. A `/` inside a word (`and/or`, `http://`, `1/2`)
 * is a character. Never on a code, table, front matter or divider line: no item acts there.
 * Reads back from the caret over one word only. */
import type { Line } from './lineModel';

/** An open `/` run on one line, in UTF-16 units from the line's start. */
export interface SlashRun {
  slash: number;
  query: string;
}

function isLineSpace(character: string): boolean {
  return character === ' ' || character === '\t';
}

/** The open run when the caret is at UTF-16 `at` from `line`'s start; null for none. */
export function slashRunAt(line: Line, at: number): SlashRun | null {
  if (line.code || line.table || line.metadata || line.divider) return null;
  const text = line.text;
  const marker = line.atoms[0];
  const textStart = marker?.kind === 'ListMarker' && marker.start === 0 ? marker.end : 0;
  let slash = at - 1;
  while (slash >= textStart && text[slash] !== '/' && !/\s/.test(text[slash])) slash--;
  if (slash < textStart || text[slash] !== '/') return null;
  if (slash > textStart && !isLineSpace(text[slash - 1])) return null;
  const query = text.slice(slash + 1, at);
  const inCode = line.runs.some(
    (run) => run.start <= slash && slash < run.end && run.formats.includes('Code'),
  );
  return inCode ? null : { slash, query };
}

/**
 * `text` case-folded for a case-insensitive literal match, WITHOUT changing its
 * length — offset `i` in the result is offset `i` in `text`.
 *
 * Two things a bare `toLowerCase()` gets wrong for matching:
 *
 * - A handful of code points grow when lowercased (`İ` → `i̇`, two code units),
 *   which would shift every offset after one of them. Growing characters are
 *   left as they are: they simply do not fold, which can only ever lose a
 *   case-insensitive match, never invent one at a wrong place.
 * - Capital sigma lowercases by context: `Σ` is final `ς` with no letter after
 *   it and `σ` before one, so the query `ΟΔΟΣ` folded to `οδος` while the `ΟΔΟΣ`
 *   inside `ΟΔΟΣΑ` folded to `οδοσ`. Every sigma folds to `σ`, as Unicode case
 *   folding does, so one letter compares equal whatever follows it.
 *
 * Locale-independent (`toLowerCase`, not `toLocaleLowerCase`), so a match is the
 * same in every WebView whatever language the device runs.
 */
export function foldCase(text: string): string {
  let folded = text.toLowerCase();
  if (folded.length !== text.length) {
    folded = '';
    for (const character of text) {
      const lower = character.toLowerCase();
      folded += lower.length === character.length ? lower : character;
    }
  }
  return folded.replace(/ς/g, 'σ');
}

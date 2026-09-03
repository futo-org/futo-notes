import { ParserReady, parserCtx } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';

/**
 * A fenced code block (``` or ~~~, non-greedy, may span lines) or a
 * single-line inline code span. Used to compute "do not rewrite" ranges.
 * Deliberately simple — it does not model escaped or doubled backticks —
 * because its only job is to keep the escape below out of code samples, not
 * to reimplement a markdown tokenizer.
 */
const CODE_MASK_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g;

function computeCodeRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  CODE_MASK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_MASK_RE.exec(markdown))) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function overlapsCode(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([a, b]) => start < b && end > a);
}

/**
 * Escape a bullet marker immediately followed by `<digit>.` or `<digit>)`.
 *
 * `* 0. item one` is not a Milkdown bug: CommonMark says a list item's content
 * is its own mini-document, so `0. item one` opens a *nested ordered list*, and
 * the bullet item becomes `[empty paragraph, ordered list]`. Upstream then wrote
 * that empty leading paragraph as its `<br />` placeholder, and the note came
 * back as `* <br />` plus an indented continuation line; with the placeholder
 * retired ({@link ../emptyLine}) it would come back as a bare `*` over a nested
 * list — structure the author never meant either way. This was the census's
 * single largest failure class — 456
 * of 30,995 notes, mostly manual "0., 1., 2." step numbering inside bullets.
 *
 * remark-stringify's own protection for this exact ambiguity is a backslash
 * escape, and that machinery is intact in Milkdown — it just never gets a turn,
 * because parsing resolved the ambiguity into real structure before
 * serialization ran. So the escape has to happen *before* the parse, which is
 * why this one fix is a string pass and not a remark transformer.
 *
 * Only the marker-adjacent shape is escaped. A digit-dot later in the item's
 * text ("see step 2. above") is not ambiguous, and a genuine nested ordered
 * list on its own continuation line does not share the bullet's line.
 *
 * Known limit: the leading-indent allowance is CommonMark's 0-3 spaces, so a
 * bullet nested deeply enough to sit at 4+ columns is not escaped. Widening it
 * would start rewriting indented code blocks, which this pass cannot recognize
 * without a real parser; fenced and inline code are masked out above.
 */
export function escapeAmbiguousBulletNumbers(markdown: string): string {
  const ranges = computeCodeRanges(markdown);
  const re = /^([ \t]{0,3}[*+-][ \t]+)(\d{1,9})([.)])(?=[ \t]|$)/gm;
  return markdown.replace(
    re,
    (whole, prefix: string, digits: string, punct: string, offset: number) => {
      if (overlapsCode(ranges, offset, offset + whole.length)) return whole;
      return `${prefix}${digits}\\${punct}`;
    },
  );
}

/**
 * Applies {@link escapeAmbiguousBulletNumbers} inside Milkdown's parser rather
 * than at the host's call sites.
 *
 * Every path that turns markdown into a document — `defaultValueCtx`,
 * `replaceAll`, `insert`, clipboard paste — goes through `parserCtx`, so
 * wrapping it once here means no caller has to remember the ordering.
 */
export const bulletNumberEscapePlugin: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(ParserReady);
  const parse = ctx.get(parserCtx);
  ctx.set(parserCtx, (text: string) => parse(escapeAmbiguousBulletNumbers(text)));
  return () => {
    ctx.set(parserCtx, parse);
  };
};

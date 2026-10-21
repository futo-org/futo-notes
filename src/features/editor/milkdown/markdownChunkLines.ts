/** Leading-whitespace width, counting a tab as the 4 columns CommonMark gives it. */
export function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

/**
 * CommonMark's blank line: only space and tab. NOT `String#trim`, which also
 * strips NBSP and friends; `lineOffense` stops the scan before that
 * difference can matter, so the two agree on every line the scanner reaches.
 */
export function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/** `- `, `* `, `+ `, `1. `, `1) ` — a list-item marker starting a line. */
export const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * A list marker with NOTHING after it. What such a line means depends on the
 * block before it — CommonMark forbids an empty item from interrupting a
 * paragraph, and remark also declines to start a list with one directly after
 * an indented code block, parsing it as a paragraph instead. Give it a chunk of
 * its own and it loses that context and becomes an empty list item: 7 of the
 * corpus's remaining divergences, all of them a `- ` under a tab-indented
 * template line. Cutting in front of one is never safe.
 */
export const EMPTY_LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*$/;

/**
 * Where a link reference definition (`[label]: dest`) or a GFM footnote
 * definition (`[^1]: text`) can begin: a `[` after nothing but container
 * markers (`>`, `- `, `1. `) and whitespace. Both kinds resolve across the
 * WHOLE document — a `[foo]` in chunk 1 whose definition lands in chunk 3
 * parses as literal text when the chunks are parsed apart — so one anywhere
 * makes the document ineligible.
 *
 * This is a deliberately loose reading of the grammar, not a model of it: the
 * definition may sit in a list item or a blockquote, carry an escaped `]` in
 * its label, or break its label over lines, and every one still begins with
 * `[` at the start of a line and still has a `]:` where the label ends.
 */
export const DEFINITION_START = /^(?:[ \t]|>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]))*\[/;

/**
 * Whether `bare` could be (the end of) a definition's label line, given whether
 * an earlier line of this paragraph opened a `[` that has not closed yet.
 * Returns the new "label still open" flag alongside.
 */
export function definitionLabel(
  bare: string,
  labelOpen: boolean,
): { hit: boolean; labelOpen: boolean } {
  const starts = DEFINITION_START.test(bare);
  // An escaped `]` does not end a label.
  const closes = bare.replace(/\\./g, '').includes(']');
  return {
    hit: bare.includes(']:') && (starts || labelOpen),
    labelOpen: (starts || labelOpen) && !closes,
  };
}

/** Opening fence: 3+ backticks or tildes, indented at most 3, plus its info string. */
export const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Parses a fence-opener line, or returns null. Shared by `advance` (which
 * tracks the open fence) and the non-blank boundary rule (which treats any
 * fence opener as a hard starter) so the backtick-info-string exception below
 * is checked in exactly one place.
 */
export function parseFenceOpen(line: string): { marker: string; length: number } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  /* A backtick fence's info string may not contain a backtick — ```` ```toml` ````
   * is a PARAGRAPH, not a code block. See `advance`'s comment at its call site
   * for what reading it as a fence used to break. */
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { marker: match[1][0], length: match[1].length };
}

/** A top-level (column-0..3) blockquote marker. */
export const BLOCKQUOTE_LINE = /^ {0,3}>/;

/**
 * ATX heading: `#` through `######`, followed by a space/tab or end of line.
 * Column-0 only is enforced by the caller (see the boundary rule) rather than
 * here, because `advance` also needs to know about an indented heading-shaped
 * line reading as a lazy continuation, not a heading.
 */
export const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;

/**
 * A list item that CommonMark lets interrupt a paragraph without a blank
 * line: a non-empty bullet, or an ordered item starting at exactly `1`. `2. x`
 * and an empty `- ` cannot interrupt, so neither is a hard starter.
 */
export const INTERRUPTING_LIST_ITEM = /^(?:[-*+]|1[.)])[ \t]+\S/;

/**
 * A GFM table delimiter row (`| --- | :-: |`, or the bare `---` shape, which
 * is harmless here since a lone `---` is never a hard starter anyway). Once
 * seen, the table is presumed open until a blank line — deliberately
 * over-approximated the same way the HTML-block-6/7 tracking below is: the
 * cost of treating a false positive as "still a table" is a missed cut, never
 * a wrong one.
 */
export const TABLE_DELIMITER_ROW =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/**
 * The start of ANY HTML block (CommonMark types 1–7: `<pre`, `<!--`, `<?`,
 * `<!X`, `<![CDATA[`, a block tag, or any bare tag/closing tag). Deliberately
 * over-approximate: a paragraph that begins with an inline tag or an autolink
 * also matches. An HTML block's end condition depends on its type, and on
 * whether a fence or another starter appears inside it; the scanner used to
 * track that and disagreed with micromark twice, so any match declines.
 */
export const HTML_BLOCK_START = /^ {0,3}<[A-Za-z/!?]/;

/**
 * An HTML block opened INSIDE a container: `- <pre>`, `> <!--`, `1. <script>`.
 * `HTML_BLOCK_START` only sees column 0..3, so without this the scanner reads
 * the block's blank lines and `# h` lines as ordinary structure. Needs at least
 * one container marker; a URL autolink (`<https://x>`) is not a tag and is let
 * through, since a scheme's `:` cannot appear in a tag name.
 */
export const CONTAINED_HTML_START =
  /^(?:[ \t]|>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]))+<(?![A-Za-z][A-Za-z0-9+.-]{1,31}:)[A-Za-z/!?]/;

/**
 * A fence marker run that follows only whitespace and container markers
 * (`- `, `1. `, `> `), with something in front of it. At column 0 the scanner
 * tracks a fence exactly; anywhere else its closing rule belongs to the
 * enclosing container and the scanner cannot prove where it ends.
 */
export const CONTAINED_FENCE = /^[ \t>*+\-\d.)]+(?:`{3,}|~{3,})/;

/**
 * A line that would open YAML front matter if it were the first line of a
 * document: exactly `---` at column 0, nothing after it but whitespace
 * (micromark-extension-frontmatter's opening condition — `----` and ` ---` are
 * thematic breaks, not fences).
 *
 * Front matter is a document-START construct, and each chunk is parsed as its
 * own little document (`packages/editor/src/milkdown-compat/frontmatter.ts`).
 * So a chunk that BEGAN with one of these would turn a mid-note thematic break
 * plus setext heading into a front matter node, which cannot be appended to a
 * document that is already past its first position — ProseMirror would drop it,
 * losing those bytes. Refusing the boundary costs one larger chunk; the planner
 * has plenty of others, and a document with no other boundary declines and
 * loads whole, which is exactly today's behavior.
 */
export const FRONT_MATTER_FENCE = /^---[ \t]*$/;

/**
 * The line index the document's OWN front matter block ends after, or 0 when it
 * has none. No boundary may fall at or before it.
 *
 * Front matter can contain a blank line followed by a column-0 line — which is
 * exactly what the scanner reads as a top-level block start — so without this a
 * `---\na: 1\n\nb: 2\n---` block would be cut in half, and each half parsed
 * apart is neither front matter nor what it was. `remark-frontmatter` requires
 * the closing fence to be exactly `---` too, and requires it to exist: with no
 * closing fence there is no front matter, so there is nothing to protect.
 */
export function frontMatterEndLine(lines: string[]): number {
  if (lines.length === 0) return 0;
  if (!FRONT_MATTER_FENCE.test(lines[0].replace(/\r?\n$/, ''))) return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONT_MATTER_FENCE.test(lines[i].replace(/\r?\n$/, ''))) return i + 1;
  }
  return 0;
}

/** Splits into lines, each keeping its own terminator, so a join is byte-exact. */
export function splitKeepingLineEndings(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/(?<=\n)/);
  return lines;
}

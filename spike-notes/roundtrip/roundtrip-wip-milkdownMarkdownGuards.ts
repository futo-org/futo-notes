/*
 * SPIKE — string-level guards worked around three Milkdown round-trip
 * data-loss/corruption bugs found by the 30,995-note corpus harness (see
 * milkdown-corpus-report.md). All three are caused by preset-internal remark
 * plugins (@milkdown/preset-commonmark) that are too aggressive or too
 * narrow for real-world markdown; rather than forking those internals, each
 * fix rewrites the markdown TEXT just before Milkdown parses it (and, for
 * one of the three, just after Milkdown serializes it), entirely outside
 * Milkdown's own remark/ProseMirror pipeline. Root causes, one per bug:
 *
 * 1. `<br>` word-fusion (protectInlineBreaks/restoreInlineBreaks): Milkdown
 *    ships `remarkPreserveEmptyLinePlugin` (preset-commonmark's
 *    plugin/remark-preserve-empty-line.ts) so that a lone `<br />` written on
 *    its own blank-line-delimited line round-trips back to a genuinely empty
 *    ProseMirror paragraph (letting the WYSIWYG view show a real blank line
 *    instead of literal text). That plugin's `visitEmptyLine` walk deletes
 *    ANY mdast `html` node whose trimmed value is `<br>`/`<br/>`/`<br
 *    />`/`<br >` from the tree — with NO check that the node is actually
 *    alone in its paragraph. An inline `<br>` used mid-sentence (or inside a
 *    GFM table cell, where it's the only legal way to represent a line
 *    break) matches the exact same value string, so it gets deleted with
 *    ZERO replacement, silently fusing the surrounding words/sentences
 *    together. Confirmed via node/html.ts + plugin/remark-preserve-empty-line.ts
 *    and a doc-tree dump (`<br>` never reaches the ProseMirror doc at all —
 *    it is removed from the mdast tree before Milkdown's parser ever runs).
 *
 * 2. Empty-text link loss (part of expandEmptyLinks): `[](url)` is an mdast
 *    `link` node with an EMPTY `children` array. Milkdown represents links
 *    as a ProseMirror MARK (mark/link.ts), and a mark needs content to
 *    attach to — `state.next(node.children)` with zero children adds nothing
 *    to the document, so both the (invisible) label AND the href are
 *    dropped entirely, with no node ever created to carry the href. Fixed by
 *    giving the link visible text (its own URL) before Milkdown ever sees
 *    it, so there is now text for the mark to attach to and the href
 *    survives.
 *
 * 3. Spurious `<br />` on numbered-looking bullets (escapeAmbiguousBulletNumbers):
 *    `* 0. item one` is not a Milkdown bug at all — remark-parse (any
 *    CommonMark-compliant parser) legitimately parses a bullet item whose
 *    content starts with `<digit>.`/`<digit>)` as a bullet list item
 *    containing a NESTED ordered list (confirmed via a doc-tree dump: the
 *    bullet item becomes `[empty paragraph, ordered_list]`). Milkdown's
 *    paragraph node (node/paragraph.ts) serializes a non-last EMPTY
 *    paragraph as a literal `<br />` (via the SAME remarkPreserveEmptyLinePlugin
 *    machinery from bug 1, used here for its DESIGNED purpose: preserving a
 *    blank line), so the empty leading paragraph that structural parse
 *    creates comes back out as visible `* <br />` + an indented nested-list
 *    continuation. remark-stringify's normal protection for this exact
 *    ambiguity is a backslash escape (`0\.`) — Milkdown's SerializerState
 *    builds a full mdast tree and hands it to plain remark-stringify in one
 *    shot (serializer/state.ts's `toString`), so that escaping machinery is
 *    intact and unmodified; the nested-list parse just never gives it the
 *    chance, because by the time serialization happens the ambiguity has
 *    already been resolved (incorrectly) into real nested-list structure.
 *    Fixed by applying the identical escape BEFORE Milkdown/remark-parse
 *    ever sees the text, so the ambiguity never arises: `* 0. item one` ->
 *    `* 0\. item one`, which CommonMark (and Milkdown) parses as plain text
 *    "0. item one" with no nested list and no empty paragraph.
 *
 * All three transforms skip fenced code blocks and inline code spans, so
 * markdown intentionally shown as code is never rewritten.
 */

/** Matches a fenced code block (```...``` or ~~~...~~~, non-greedy, may span
 * lines) or a single-line inline code span (`` `...` ``). Used to compute
 * "do not touch" ranges for all three transforms below. Deliberately simple
 * (does not handle escaped/doubled backticks) — good enough to keep this
 * spike's fixes out of code samples without reimplementing a markdown
 * tokenizer. */
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
 * Bug 3 (see file header). Escapes a bullet-list marker (`*`/`-`/`+`)
 * immediately followed by `<digit>.` or `<digit>)` — the exact shape
 * CommonMark parses as "bullet item containing a nested ordered list" —
 * with a backslash, matching remark-stringify's own protection for this
 * ambiguity elsewhere. Only the marker-adjacent case is escaped: a digit-dot
 * appearing later in an item's text (e.g. "see step 2. above") is never
 * ambiguous and is left untouched, and a genuinely nested ordered list on
 * its own indented continuation line (not sharing the bullet's line) is
 * unaffected since the regex is anchored to a bullet marker on the same
 * line.
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
 * Bug 2 (see file header). Rewrites an empty-label link `[](url)` (or
 * `[](url "title")`) into `[url](url "title")` before Milkdown ever parses
 * it, so the link mark has visible text to attach to and the href is never
 * silently dropped. One-way: there is no reason to convert back on
 * serialize, this is the same kind of forward-only normalization Milkdown
 * already performs for many other constructs (list markers, autolinks, ...).
 *
 * Deliberately excludes `![](url)` (image syntax, via the `(?<!!)`
 * lookbehind): an empty ALT text is a normal, intentional, and already
 * lossless way to embed a decorative image — Milkdown round-trips it fine
 * as-is — so rewriting it here would silently change real notes for no
 * reason and was caught by the corpus re-run (it also does not share bug 2's
 * root cause: an image is a NODE with a `src` attribute, not a mark that
 * needs text content to attach to).
 */
export function expandEmptyLinks(markdown: string): string {
  const ranges = computeCodeRanges(markdown);
  const re = /(?<!!)\[]\(([^\s()]+)(?:[ \t]+"([^"]*)")?\)/g;
  return markdown.replace(re, (whole, url: string, title: string | undefined, offset: number) => {
    if (overlapsCode(ranges, offset, offset + whole.length)) return whole;
    const titlePart = title !== undefined ? ` "${title}"` : '';
    return `[${url}](${url}${titlePart})`;
  });
}

/** Marker injected into an at-risk `<br>` so it survives
 * remarkPreserveEmptyLinePlugin's exact-string-match deletion (bug 1, see
 * file header) — chosen to still be valid, parseable HTML tag syntax (so it
 * becomes an ordinary inert `html` atom node, rendered as literal inert text
 * exactly like `<kbd>`/HTML comments already are) while never equaling one
 * of the plugin's four stripped strings after trimming. */
const BR_MARKER_ATTR = 'data-futo-hb="1"';
const PROTECTED_BR = `<br ${BR_MARKER_ATTR}>`;

const BR_TAG_RE = /<br[ \t]*\/?[ \t]*>/gi;

function lineBounds(text: string, index: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const nl = text.indexOf('\n', index);
  const end = nl === -1 ? text.length : nl;
  return { start, end };
}

function isBlankLineAt(text: string, lineEnd: number, direction: 1 | -1): boolean {
  if (direction === -1) {
    if (lineEnd <= 0) return true; // start of document counts as a boundary
    const prevEnd = lineEnd - 1; // the '\n' just before this line
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    return text.slice(prevStart, prevEnd).trim() === '';
  }
  if (lineEnd >= text.length) return true; // end of document counts as a boundary
  const nextStart = lineEnd + 1;
  const nextEnd = text.indexOf('\n', nextStart);
  const nextLine = text.slice(nextStart, nextEnd === -1 ? text.length : nextEnd);
  return nextLine.trim() === '';
}

/**
 * Is `match` (at [matchStart, matchEnd) within `line`, whose own bounds in
 * the full text are [lineStart, lineEnd)) the ENTIRE trimmed content of one
 * GFM table cell on that row? Table cell schema wraps its content in a
 * paragraph (preset-gfm's table/schema.ts `cellContent: 'paragraph'`), so an
 * EMPTY cell hits the exact same "empty paragraph, not last node ->
 * literal `<br />`" mechanism as a preserved blank line (paragraph.ts) —
 * Milkdown creates this placeholder ITSELF on serialize, with no `<br>` in
 * the original source at all, and relies on recognizing that exact string
 * again on the next parse to rebuild the empty cell. Protecting it like an
 * ordinary inline `<br>` would break that round-trip (the cell would stop
 * being empty), so it must be left alone exactly like an isolated paragraph
 * — the difference is the boundary is the nearest unescaped `|` on each
 * side instead of blank lines/block markers, since a whole GFM table row is
 * always one physical line.
 */
function isSoleTableCellContent(
  line: string,
  lineStart: number,
  matchStart: number,
  matchEnd: number,
  matchText: string,
): boolean {
  if (!line.trim().startsWith('|')) return false;
  const relStart = matchStart - lineStart;
  const relEnd = matchEnd - lineStart;
  const cellOpenRel = line.lastIndexOf('|', relStart - 1);
  const cellCloseRel = line.indexOf('|', relEnd);
  if (cellOpenRel === -1 || cellCloseRel === -1) return false;
  const cellText = line.slice(cellOpenRel + 1, cellCloseRel);
  return cellText.trim() === matchText.trim();
}

/** Repeated leading blockquote (`>`) and/or list marker (`-`/`*`/`+`/
 * `<digit>.`/`<digit>)`) prefixes, with their following whitespace — i.e.
 * everything CommonMark strips off the front of a line to find a list
 * item's or blockquote's own content. Used below to recognize "this `<br>`
 * is the sole content of a list item (or blockquote), same container as any
 * other block" without needing a full block parser. */
const BLOCK_PREFIX_RE = /^(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+))+/;

/**
 * Is `match` the ENTIRE trimmed content of its line once any leading list-
 * item/blockquote marker(s) are stripped off — i.e. a list item or
 * blockquote whose own (only) content is this one `<br>` tag? Just like the
 * table-cell case above, this hits paragraph.ts's "empty paragraph, not
 * last node -> literal `<br />`" mechanism (a list item's/blockquote's
 * content is a paragraph too), and Milkdown itself is the one that puts the
 * tag there — not the original note. Unlike a bare top-level paragraph, a
 * list item never needs a blank-line neighbor to be its OWN container (a
 * "tight" list has no blank lines between items at all), so this check
 * intentionally has no blank-line requirement.
 */
function isSoleBlockPrefixedContent(line: string, matchText: string): boolean {
  const prefixMatch = BLOCK_PREFIX_RE.exec(line);
  if (!prefixMatch || prefixMatch[0].length === 0) return false;
  return line.slice(prefixMatch[0].length).trim() === matchText.trim();
}

/**
 * Bug 1 (see file header). Protects every `<br>`/`<br/>`/`<br />`/`<br >`
 * that is NOT the sole content of its immediate block container — a bare,
 * blank-line-delimited top-level paragraph, a list item/blockquote (any
 * nesting), or a GFM table cell — i.e. every occurrence that is genuinely
 * inline with OTHER surrounding text, by rewriting it to a marker form
 * remarkPreserveEmptyLinePlugin's exact value check will not match. A
 * `<br>` that IS the sole content of one of those containers is left
 * completely untouched: all three are the SAME existing, correct "empty
 * paragraph, not last node -> literal `<br />`" mechanism (paragraph.ts,
 * exercised for a bare paragraph directly and via a list item's/table
 * cell's own `cellContent: 'paragraph'`/list-item content model) that
 * already round-trips fine — including when Milkdown itself, not the
 * original source, is the one that put the `<br />` there (an empty list
 * item or table cell serializes to one even with no `<br>` in the note at
 * all — confirmed against the corpus: protecting those unconditionally
 * caused ~1300 notes to become newly unstable across round-trips before
 * this exemption was added).
 */
export function protectInlineBreaks(markdown: string): string {
  const ranges = computeCodeRanges(markdown);
  let result = '';
  let lastIndex = 0;
  BR_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BR_TAG_RE.exec(markdown))) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    result += markdown.slice(lastIndex, matchStart);

    if (overlapsCode(ranges, matchStart, matchEnd)) {
      result += match[0];
      lastIndex = matchEnd;
      continue;
    }

    const { start: lineStart, end: lineEnd } = lineBounds(markdown, matchStart);
    const line = markdown.slice(lineStart, lineEnd);
    const isolatedBarePara =
      line.trim() === match[0].trim() &&
      isBlankLineAt(markdown, lineStart, -1) &&
      isBlankLineAt(markdown, lineEnd, 1);
    const isolatedCell =
      !isolatedBarePara && isSoleTableCellContent(line, lineStart, matchStart, matchEnd, match[0]);
    const isolatedBlockPrefixed =
      !isolatedBarePara && !isolatedCell && isSoleBlockPrefixedContent(line, match[0]);

    result += isolatedBarePara || isolatedCell || isolatedBlockPrefixed ? match[0] : PROTECTED_BR;
    lastIndex = matchEnd;
  }
  result += markdown.slice(lastIndex);
  return result;
}

/** Reverses protectInlineBreaks on Milkdown's serialized output (see file
 * header) — a plain literal replace since we control the exact marker
 * string we inject. Always normalizes to a bare `<br>`; the original
 * self-closing style (`<br/>` vs `<br />`) is not preserved across an edit,
 * the same kind of minor syntax normalization Milkdown already applies to
 * list markers, table separators, etc. */
export function restoreInlineBreaks(markdown: string): string {
  return markdown.split(PROTECTED_BR).join('<br>');
}

/** Applied to markdown just before it is handed to Milkdown (defaultValueCtx
 * / replaceAll / insert). */
export function prepareMarkdownForMilkdown(markdown: string): string {
  return protectInlineBreaks(expandEmptyLinks(escapeAmbiguousBulletNumbers(markdown)));
}

/** Applied to markdown just after Milkdown serializes it (getMarkdown /
 * markdownUpdated). */
export function restoreMarkdownFromMilkdown(markdown: string): string {
  return restoreInlineBreaks(markdown);
}

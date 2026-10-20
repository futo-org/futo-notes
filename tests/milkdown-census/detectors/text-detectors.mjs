/**
 * The per-note counters: br tags, empty links, html tags, front matter, numeric
 * references and wikilinks.
 */

/**
 * Tag counting is deliberately NOT masked by code fences. A tag inside a fence
 * is inert and round-trips verbatim, so masking buys nothing — and it costs
 * something real: the round trip re-indents raw HTML blocks, which shifts which
 * backtick runs the mask matches and manufactures loss that is not there.
 */
const BR_TAG_RE = /<br[ \t]*\/?[ \t]*>/gi;

export function countBrTags(markdown) {
  return (markdown.match(BR_TAG_RE) ?? []).length;
}

/**
 * Fenced code blocks and inline code spans.
 *
 * This mask only excludes code from counters; it never rewrites editor input.
 */
const CODE_MASK_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g;

function stripCode(markdown) {
  return markdown.replace(CODE_MASK_RE, (m) => ' '.repeat(m.length));
}

/**
 * The destinations of `[](url)` links, excluding `![](url)` images. An empty
 * destination (`[]()`, `[](<>)`) is skipped: there is no href to lose.
 */
const EMPTY_LINK_RE = /(?<!!)\[]\(([^\s()]*)(?:[ \t]+"[^"]*")?\)/g;

export function emptyLinkTargets(markdown) {
  const masked = stripCode(markdown);
  const urls = [];
  EMPTY_LINK_RE.lastIndex = 0;
  let match;
  while ((match = EMPTY_LINK_RE.exec(masked))) {
    const url = match[1];
    if (url === '' || url === '<>') continue;
    urls.push(url);
  }
  return urls;
}

/**
 * HTML tags in the source, ignoring autolinks (`<https://…>` is a link, not a
 * tag) and tolerating CommonMark's backslash escaping.
 */
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g;

export function countHtmlTags(markdown) {
  return (markdown.match(HTML_TAG_RE) ?? []).length;
}

/**
 * A bullet item whose entire content is the empty-paragraph placeholder, with
 * the item's real content pushed onto an indented continuation line.
 */
const INJECTED_BULLET_BR_RE = /^[ \t]*[*+-] <br \/>[ \t]*$/m;

/**
 * A bullet marker followed on the same line by something that opens a block of
 * its own: an ordered-list number, another bullet, a blockquote, a heading.
 * CommonMark parses the item's content as its own mini-document, so the item
 * gets an empty leading paragraph — which is what comes back as the placeholder.
 *
 * Milkdown emits the same placeholder for a genuinely empty list item, which is
 * correct and must not be counted, hence pairing the two patterns below.
 */
const BULLET_BLOCK_OPENER_RE =
  /^[ \t]*[*+-][ \t]+(?:\d{1,9}[.)](?=[ \t]|$)|[*+-][ \t]|>|#{1,6}[ \t])/m;

export function hasInjectedBulletBreak(markdown) {
  return INJECTED_BULLET_BR_RE.test(markdown);
}

export function hasBulletBlockOpener(markdown) {
  return BULLET_BLOCK_OPENER_RE.test(stripCode(markdown));
}

/**
 * A document-leading YAML front matter block, captured from its opening fence
 * to the end of its closing one (the line ending after it belongs to what
 * follows, which a save writes LF).
 *
 * Exactly the shape `micromark-extension-frontmatter` accepts: the opening and
 * closing fences are each exactly three dashes at column 0 with nothing but
 * whitespace after them (`----` and ` ---` are thematic breaks), and CR, LF or
 * CRLF ends a line — a save keeps the block's own line endings.
 */
const FRONT_MATTER_RE = /^---[ \t]*(?:\r\n?|\n)[\s\S]*?(?:\r\n?|\n)---[ \t]*(?=\r|\n|$)/;

export function leadingFrontMatter(markdown) {
  return FRONT_MATTER_RE.exec(markdown)?.[0] ?? null;
}

/**
 * A numeric character reference the editor WROTE that the note never had.
 *
 * The serializer writes references on purpose — `**Note:**&#x62;ar` keeps a bold
 * run whose edge is punctuation, and upstream writes `&#x20;` for a space that
 * would end a line — so a reference in the output is not a flag by itself. What
 * is one: a reference that is malformed (`&#xNAN;`, `&#x61&#x3B;`, a missing
 * `;`, a code point past U+10FFFF or a lone surrogate) or that names a
 * character the note did not contain. Both read back as text the author never
 * wrote (RC-104, P4-L8-1): a count of lost tokens cannot see text that was
 * GAINED, which is why `text_loss` stayed silent. References the note already
 * had (same spelling, same count) are the note's own and are skipped.
 */
const REFERENCE_RE = /&#(?:[xX][0-9A-Za-z]*|[0-9A-Za-z]*);?/g;
const WELL_FORMED_REFERENCE_RE = /^&#(?:[xX]([0-9A-Fa-f]{1,6})|([0-9]{1,7}));$/;

function referenceCodePoint(reference) {
  const match = WELL_FORMED_REFERENCE_RE.exec(reference);
  if (!match) return null;
  const codePoint = match[1] ? parseInt(match[1], 16) : parseInt(match[2], 10);
  if (codePoint === 0 || codePoint > 0x10ffff) return null;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
  return codePoint;
}

/** Whether the `&` at `index` is backslash-escaped, which makes the reference literal text. */
function isEscaped(text, index) {
  let slashes = 0;
  while (index - 1 - slashes >= 0 && text[index - 1 - slashes] === '\\') slashes += 1;
  return slashes % 2 === 1;
}

/** Whether `output` holds a reference `input` did not, that is malformed or foreign to it. */
export function hasInsertedReference(input, output) {
  const had = new Map();
  const characters = new Set(Array.from(input, (char) => char.codePointAt(0)));
  for (const match of input.matchAll(REFERENCE_RE)) {
    const reference = match[0];
    had.set(reference, (had.get(reference) ?? 0) + 1);
    const codePoint = referenceCodePoint(reference);
    if (codePoint !== null) characters.add(codePoint);
  }
  for (const match of output.matchAll(REFERENCE_RE)) {
    const reference = match[0];
    const left = had.get(reference) ?? 0;
    if (left > 0) {
      had.set(reference, left - 1);
      continue;
    }
    /* `\&#x1F600;` is the text `&#x1F600;`, which is how a note that spelled it
     * `&amp;#x1F600;` is saved: literal text, fine while the note held those
     * characters (an escaped `&#xNAN;` is still the editor's garbage, just
     * escaped once by the next save). */
    if (isEscaped(output, match.index)) {
      if (input.includes(reference.slice(1))) continue;
      return true;
    }
    const codePoint = referenceCodePoint(reference);
    /* A malformed one written bare is literal text again (`&#1F600;` is not a
     * reference), which is how the owned serializer saves a note that spelled
     * it `&amp;#1F600;` or `\&#1F600;`: fine while the note held that text. */
    if (codePoint === null && heldAsText(input, reference)) continue;
    if (codePoint === null || !characters.has(codePoint)) return true;
  }
  return false;
}

/** Whether `input` spelled `reference` as literal text: with `&amp;` or a backslash. */
function heldAsText(input, reference) {
  return input.includes(`&amp;${reference.slice(1)}`) || input.includes(`\\${reference}`);
}

const WIKILINK_RE = /\\?\[\\?\[[^\]\n]+\]\\?\]/g;

export function countWikilinks(markdown) {
  return (markdown.match(WIKILINK_RE) ?? []).length;
}

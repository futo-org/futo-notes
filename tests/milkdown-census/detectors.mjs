/**
 * What the census counts.
 *
 * Two of these are precise measurements of the loss classes the compat plugins
 * exist to eliminate (`br_loss`, `empty_link_loss`) — those are the numbers the
 * acceptance criteria are stated against. The rest are the same broad
 * instability/structure signals the first census used: useful for spotting a
 * regression against a baseline run, not exact in themselves.
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
 * A deliberate copy of the mask in `milkdown-compat/bulletNumbers.ts` rather
 * than an import: this module is loaded by plain Node (`run.mjs`), which cannot
 * follow a reference into a `.ts` file — `scripts/typescript-script-runtime.test.mjs`
 * fails the build if it tries. The two masks serve different jobs anyway (that
 * one decides what to rewrite, this one what to count), so they are free to
 * diverge.
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

const WIKILINK_RE = /\\?\[\\?\[[^\]\n]+\]\\?\]/g;

export function countWikilinks(markdown) {
  return (markdown.match(WIKILINK_RE) ?? []).length;
}

/**
 * Flags for one note. `round1`/`round2`/`round3` are successive `RoundTrip`
 * results from `entry.ts` — `round1` is the body's own load, `round2` is a load
 * of `round1.markdown`, and `round3` is null when the note already settled.
 * (Named in prose rather than imported: this module is loaded by plain Node,
 * which cannot follow a reference into a `.ts` file even a type-only one.)
 *
 * @returns {Record<string, true>}
 */
export function classify({ body, round1, round2, round3 }) {
  const flags = {};

  if (round1.markdown !== round2.markdown) flags.unstable = true;
  if (round3 && round2.markdown !== round3.markdown) flags.unstable_persistent = true;

  // round1.docJson is the document the body parsed to; round2.docJson is what
  // round1 parsed to. Unequal means the editor changed the document, not just
  // its spelling.
  if (JSON.stringify(round1.docJson) !== JSON.stringify(round2.docJson)) flags.doc_mismatch = true;
  if (round1.text !== round2.text) flags.text_loss = true;
  if (JSON.stringify(round1.histogram) !== JSON.stringify(round2.histogram)) {
    flags.structural_diff = true;
  }

  if (countBrTags(round1.markdown) < countBrTags(body)) flags.br_loss = true;
  if (
    hasBulletBlockOpener(body) &&
    hasInjectedBulletBreak(round1.markdown) &&
    !hasInjectedBulletBreak(body)
  ) {
    flags.bullet_br_injected = true;
  }

  const emptyLinks = emptyLinkTargets(body);
  if (emptyLinks.length > 0 && emptyLinks.some((url) => !round1.markdown.includes(url))) {
    flags.empty_link_loss = true;
  }

  if (countHtmlTags(round1.markdown) < countHtmlTags(body)) flags.html_loss = true;
  if (countWikilinks(round1.markdown) < countWikilinks(body)) flags.wikilink_loss = true;

  return flags;
}

export const FLAG_ORDER = [
  'unstable',
  'unstable_persistent',
  'doc_mismatch',
  'text_loss',
  'structural_diff',
  'br_loss',
  'bullet_br_injected',
  'empty_link_loss',
  'html_loss',
  'wikilink_loss',
];

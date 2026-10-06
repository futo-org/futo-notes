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
 * A document-leading YAML front matter block, captured whole.
 *
 * Exactly the shape `micromark-extension-frontmatter` accepts: the opening and
 * closing fences are each exactly three dashes at column 0 with nothing but
 * whitespace after them (`----` and ` ---` are thematic breaks).
 */
const FRONT_MATTER_RE = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;

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

/**
 * The document a note reads as, with everything a fixed house style may change
 * taken out, so two readings compare equal exactly when the save lost or
 * changed nothing the author wrote. Stated here, not imported from the
 * serializer, so the gate does not trust the code it gates. Each rule is a line
 * of docs/spec/editor.md "Markdown house style".
 *
 * Spelling-only attributes — what a parse derives from HOW the file spelled
 * something, not from what it holds — are dropped:
 *   - `emphasis.marker`, `strong.marker`: `*` or `_`, the file's choice.
 *   - `heading.id`: a slug of the heading's text.
 *   - `list_item.label`, `list_item.listType`: `•`/`3.` and bullet/ordered,
 *     derived from the parent list and the item's position.
 *   - `table_header.colwidth`, `table_cell.colwidth`: markdown has no widths.
 *   - `table_cell.alignment` (body cells): the delimiter row sets a column's
 *     alignment, read from the header cell, which keeps it.
 *   - a link's `title` of `""` reads the same as none; an image's missing
 *     title is the schema's `''`.
 * Normalizations the house style makes on purpose:
 *   - whitespace before a soft line break, and at the end of a paragraph,
 *     heading or table cell, is dropped, then a line break at the very end of
 *     a paragraph or heading (the parser drops both on every read; a cell's
 *     last `<br>` reads back as a line break, so it stays);
 *   - a table cell holding only line breaks and whitespace is empty (a lone
 *     `<br>` in a cell reads back as an empty cell);
 *   - a heading's line breaks are spaces (an ATX heading is one line);
 *   - a paragraph is split at each empty line inside it — a soft line break
 *     ending a line that holds nothing (whitespace counts as nothing; a line
 *     where a link opens or closes holds its `[` or `](…)`) — since
 *     an empty line in the file ends a paragraph: `n` empty lines between two
 *     lines of text are a paragraph break and `n - 1` empty paragraphs, `n` at
 *     its start are `n` empty paragraphs before it, and the line break before
 *     an empty line ends a paragraph, so it goes like any break at the end;
 *   - empty paragraphs at the start or end of a quote, list item or footnote,
 *     and at the end of the note, are dropped (no spelling reaches them; a list
 *     item's empty first child, the schema's filler, stays unless the item's
 *     first block is a paragraph, and the empty paragraphs after a first
 *     paragraph that holds text are inside the item, not at its start);
 *   - CR and CRLF inside code, HTML and front matter are LF;
 *   - an HTML block's indentation before its first tag is dropped (layout, not
 *     HTML; only a block's value can start with whitespace);
 *   - a list item whose blocks need a blank line between them — two paragraphs
 *     in a row (a paragraph cannot interrupt one), or an empty paragraph
 *     between two blocks — is loose: no tight spelling keeps them apart.
 * Text runs whose marks then agree are merged, and an emptied paragraph is an
 * empty paragraph.
 */
const SPELLING_ATTRS = {
  heading: ['id'],
  list_item: ['label', 'listType'],
  table_header: ['colwidth'],
  table_cell: ['colwidth', 'alignment'],
};
const CONTAINERS = new Set(['blockquote', 'list_item', 'footnote_definition']);
const lf = (value) => value.replace(/\r\n?/g, '\n');

function houseMarkKey(mark) {
  if (mark.type === 'link')
    return `link\u0000${mark.attrs?.href ?? ''}\u0000${mark.attrs?.title || ''}`;
  return mark.type;
}

function houseMarks(marks) {
  return (marks ?? []).map(houseMarkKey).sort().join('\u0001');
}

function isEmptyParagraph(node) {
  return node.type === 'paragraph' && (node.content?.length ?? 0) === 0;
}

/** A list item's blocks (trimmed) that only a blank line keeps apart; its first may be the schema's filler. */
function needsBlankLine(content) {
  const htmlBlock = (node) => node.content?.length === 1 && node.content[0].type === 'html';
  return content.some((child, i) => {
    if (i === 0 || child.type !== 'paragraph') return false;
    if (isEmptyParagraph(child)) return true;
    const previous = content[i - 1];
    return previous.type === 'paragraph' && !isEmptyParagraph(previous) && !htmlBlock(child);
  });
}

function houseInline(content, kind) {
  let nodes = content.map((node) => {
    if (node.type === 'html') return node;
    if (kind === 'heading' && node.type === 'hardbreak')
      return { type: 'text', text: ' ', marks: node.marks };
    return node;
  });
  const merge = (list) => {
    const out = [];
    for (const node of list) {
      if (node.type === 'text' && !node.text) continue;
      const last = out[out.length - 1];
      if (
        last?.type === 'text' &&
        node.type === 'text' &&
        houseMarks(last.marks) === houseMarks(node.marks)
      ) {
        out[out.length - 1] = { ...last, text: last.text + node.text };
      } else out.push(node);
    }
    return out;
  };
  // Code is delimited, so its edge spaces survive a read: never trimmed.
  const trimmable = (node) =>
    node.type === 'text' && !(node.marks ?? []).some((mark) => mark.type === 'inlineCode');
  const stripBefore = (list, end) => {
    for (let i = end - 1; i >= 0 && trimmable(list[i]); i -= 1) {
      const text = list[i].text.replace(/[ \t]+$/, '');
      list[i] = { ...list[i], text };
      if (text !== '') return;
    }
  };
  nodes = merge(nodes);
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].type === 'hardbreak' && nodes[i].attrs?.isInline === true) stripBefore(nodes, i);
  }
  for (;;) {
    stripBefore(nodes, nodes.length);
    nodes = merge(nodes);
    if (nodes[nodes.length - 1]?.type !== 'hardbreak' || kind === 'cell') break;
    nodes.pop();
  }
  const blank = (node) =>
    node.type === 'hardbreak' || (trimmable(node) && /^[ \t]*$/.test(node.text));
  return kind === 'cell' && nodes.every(blank) ? [] : nodes;
}

/**
 * A paragraph's house-normalized content split at its empty lines (see
 * `houseDocument`): one content array per paragraph it reads as, `[]` for an
 * empty one.
 */
function splitParagraph(content) {
  const isSoft = (node) => node.type === 'hardbreak' && node.attrs?.isInline === true;
  const links = (node) =>
    (node?.marks ?? [])
      .filter((mark) => mark.type === 'link')
      .map(houseMarkKey)
      .sort()
      .join('\u0001');
  const linkEdge = (node, previous) => links(node) !== links(previous);
  const out = [];
  let line = [];
  let blanks = 0;
  let lineEmpty = true;
  let split = false;
  let previous;
  const close = () => {
    const text = houseInline(line, 'paragraph');
    line = [];
    if (text.length === 0) return;
    const empties = out.some((block) => block.length > 0) ? blanks - 1 : blanks;
    for (let i = 0; i < empties; i += 1) out.push([]);
    out.push(text);
    blanks = 0;
  };
  for (const node of content) {
    const empty = lineEmpty && isSoft(node) && !linkEdge(node, previous);
    previous = node;
    if (empty) {
      close();
      split = true;
      blanks += 1;
      continue;
    }
    line.push(node);
    lineEmpty = node.type === 'hardbreak';
  }
  if (!split) return [content];
  close();
  return out.length > 0 ? out : [[]];
}

/** `node` house-normalized: one node, or several for a paragraph split at its empty lines. */
function houseBlocks(node, inCell = false) {
  if (node.type !== 'paragraph' || inCell || !node.content) return [houseNode(node, inCell)];
  return splitParagraph(houseInline(node.content, 'paragraph')).map((content) =>
    houseNode({ ...node, content }, false, true),
  );
}

function houseNode(node, inCell = false, inlineDone = false) {
  const out = { type: node.type };
  if (node.attrs) {
    const dropped = SPELLING_ATTRS[node.type] ?? [];
    const attrs = {};
    for (const key of Object.keys(node.attrs).sort()) {
      if (dropped.includes(key)) continue;
      let value = node.attrs[key];
      if (node.type === 'image' && key === 'title') value = value ?? '';
      if ((node.type === 'frontmatter' || node.type === 'html') && key === 'value')
        value = lf(value);
      if (node.type === 'html' && key === 'value') value = value.replace(/^[ \t]+/, '');
      attrs[key] = value;
    }
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
  }
  if (node.marks?.length) out.marks = houseMarks(node.marks);
  if (node.text !== undefined) out.text = node.text;
  let content = node.content ?? [];
  if (node.type === 'code_block') {
    const text = lf(content.map((child) => child.text ?? '').join(''));
    content = text ? [{ type: 'text', text }] : [];
  } else if ((node.type === 'paragraph' || node.type === 'heading') && !inlineDone) {
    content = houseInline(content, inCell ? 'cell' : node.type);
  }
  const cell = node.type === 'table_header' || node.type === 'table_cell';
  content = content.flatMap((child) => houseBlocks(child, cell));
  if (CONTAINERS.has(node.type)) {
    const item = node.type === 'list_item';
    // After an item's first paragraph that holds text, blank lines are inside the item.
    const leading = !item || (content.length > 0 && isEmptyParagraph(content[0]));
    let start = 0;
    while (leading && start < content.length && isEmptyParagraph(content[start])) start += 1;
    let end = content.length;
    while (end > start && isEmptyParagraph(content[end - 1])) end -= 1;
    const kept = content.slice(start, end);
    // The filler stays only in front of an item whose first block is not a paragraph.
    const filler = item && start > 0 && kept[0]?.type !== 'paragraph';
    content = filler ? [content[0], ...kept] : kept;
  }
  if (node.type === 'list_item' && out.attrs && needsBlankLine(content)) out.attrs.spread = true;
  if (node.type === 'doc') {
    while (content.length > 0 && isEmptyParagraph(content[content.length - 1])) content.pop();
  }
  if (content.length > 0) out.content = content;
  return out;
}

/** The note as `houseNode` compares it: a string, so equality is `===`. */
export function houseDocument(docJson) {
  return JSON.stringify(houseNode(docJson));
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

  /* The two hard gates of the owned serializer (#266). `content_loss` is
   * `doc_mismatch` with only what the house style may change taken out
   * (`houseDocument`): the save dropped or changed something the author wrote.
   * `second_pass_unstable` is the serializer's own fixed point — write, parse
   * with the bare parser, write again — without the editor's load sequence. */
  if (houseDocument(round1.docJson) !== houseDocument(round2.docJson)) flags.content_loss = true;
  if (round1.secondPass !== undefined && round1.secondPass !== round1.markdown) {
    flags.second_pass_unstable = true;
  }
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
  if (hasInsertedReference(body, round1.markdown)) flags.entity_inserted = true;

  /* The one flag here that compares round1 against the ORIGINAL BYTES rather
   * than against round2, and it has to: corrupted front matter is STABLE. With
   * nothing in the parser recognising the construct, `---` parsed as a thematic
   * break and the metadata lines as a setext heading, and `***` + a dash rule
   * round-trips to itself forever — so every stability-based flag above stayed
   * silent while `tags: [a, b]` was being rewritten to `tags: \[a, b]` on disk.
   * That blind spot is why the first census reported "no eaten frontmatter-like
   * content". Byte equality is the right bar for this construct specifically:
   * front matter is not markdown, so there is no re-spelling of it that
   * ADR-0002's normalize-once would accept. */
  const frontMatter = leadingFrontMatter(body);
  if (frontMatter !== null && !round1.markdown.startsWith(frontMatter)) {
    flags.frontmatter_loss = true;
  }

  return flags;
}

export const FLAG_ORDER = [
  'content_loss',
  'second_pass_unstable',
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
  'frontmatter_loss',
  'entity_inserted',
];

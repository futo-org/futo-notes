/**
 * What "the same document" means to the serializer, in two parts.
 *
 * 1. The house style's deliberate normalizations (docs/spec/editor.md
 *    "Markdown house style"), applied to a document before it is written:
 *    whitespace at the end of a line and a line break at the end of a
 *    paragraph or heading are dropped (the parser drops them on every read; a
 *    cell keeps its last `<br>`), a cell holding only line breaks is empty (a
 *    lone `<br>` reads back as one), a heading's line breaks become spaces (an
 *    ATX heading is one line),
 *    a paragraph is split at each empty line inside it (a blank line in the
 *    file ends a paragraph: `splitAtEmptyLines`), empty paragraphs at the
 *    start or end of a quote, list item or footnote are dropped (no markdown
 *    spelling reaches them), as is a list item's empty first paragraph when a
 *    paragraph follows it (the schema's filler, which only an item starting
 *    with another block needs), the CR or CRLF line
 *    endings a code block, HTML or front matter kept from a CRLF file become
 *    LF (a save writes LF only), and an HTML block's indentation before its
 *    first tag is dropped: it is layout, not HTML, and kept it would put the
 *    block in a different container once list indentation is the house style's.
 *    A list item whose blocks need a blank line between them is loose, however
 *    the editor held it: no tight spelling keeps them apart (`needsBlankLine`).
 * 2. The spelling-only attributes, which a parse derives from HOW the file
 *    spelled something rather than from WHAT it holds, so they are left out of
 *    every comparison: `emphasis`/`strong` `marker` (`*` or `_`), `heading`
 *    `id` (a slug of the text), `list_item` `label` and `listType` (derived from
 *    the list and the item's position), a table cell's `colwidth` (markdown has
 *    no column widths) and a body cell's `alignment` (the column's delimiter
 *    row decides it, from the header cell), a link's empty title (`""` and no
 *    title read the same) and an image's missing title (the schema's `''`).
 *
 * `canonical` applies both and is what the serializer's parse check compares.
 * The census `content_loss` detector states the same list independently
 * (`tests/milkdown-census/detectors.mjs`), so a gate never trusts the code it
 * gates.
 */
import { MARK, NODE, isEmptyParagraph, isHtmlBlock, type MarkJson, type NodeJson } from './docJson';

/** The three places inline content lives, which differ in what a line break can be. */
export type InlineKind = 'paragraph' | 'heading' | 'cell';

/** A mark as the house style sees it: type plus the attributes that are content. */
export function markKey(mark: MarkJson): string {
  if (mark.type !== MARK.link) return mark.type;
  const title = (mark.attrs?.title as string | null | undefined) || '';
  return `${mark.type}\u0000${String(mark.attrs?.href ?? '')}\u0000${title}`;
}

export function sameMarks(a?: readonly MarkJson[], b?: readonly MarkJson[]): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  const keys = new Set(left.map(markKey));
  return right.every((mark) => keys.has(markKey(mark)));
}

const isText = (node: NodeJson | undefined): boolean => node?.type === NODE.text;

const lf = (value: string): string => value.replace(/\r\n?/g, '\n');

/**
 * A node whose raw `value` attribute is written verbatim — with LF line endings,
 * and without the indentation before an HTML block's first tag (only a block
 * can start with whitespace: inline HTML starts at its `<`).
 */
function withLfValue(node: NodeJson): NodeJson {
  const value = node.attrs?.value;
  if (typeof value !== 'string') return node;
  let normalized = lf(value);
  if (node.type === NODE.html) normalized = normalized.replace(/^[ \t]+/, '');
  return normalized === value ? node : { ...node, attrs: { ...node.attrs, value: normalized } };
}

const isSoftBreak = (node: NodeJson | undefined): boolean =>
  node?.type === NODE.hardbreak && node.attrs?.isInline === true;

function withText(node: NodeJson, text: string): NodeJson {
  return { ...node, text };
}

/** Adjacent text nodes with the same marks become one; empty ones go. */
function mergeText(nodes: readonly NodeJson[]): NodeJson[] {
  const out: NodeJson[] = [];
  for (const node of nodes) {
    if (isText(node) && (node.text ?? '') === '') continue;
    const last = out[out.length - 1];
    if (last && isText(last) && isText(node) && sameMarks(last.marks, node.marks)) {
      out[out.length - 1] = withText(last, (last.text ?? '') + (node.text ?? ''));
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Code is delimited, so the parser keeps its edge spaces: it is never trimmed. */
const isCode = (node: NodeJson): boolean =>
  (node.marks ?? []).some((mark) => mark.type === MARK.code);

/** Drops spaces and tabs at the end of the text run that ends at `end` (exclusive). */
function stripLineEnd(nodes: NodeJson[], end: number): void {
  for (let index = end - 1; index >= 0; index -= 1) {
    const node = nodes[index] as NodeJson;
    if (!isText(node) || isCode(node)) return;
    const text = (node.text ?? '').replace(/[ \t]+$/, '');
    nodes[index] = withText(node, text);
    if (text !== '') return;
  }
}

/** The house style's inline normalizations (see the module header). */
export function normalizeInline(content: readonly NodeJson[], kind: InlineKind): NodeJson[] {
  let nodes = content.map((node) => {
    if (node.type === NODE.html) return withLfValue(node);
    return kind === 'heading' && node.type === NODE.hardbreak
      ? { type: NODE.text, text: ' ', ...(node.marks ? { marks: node.marks } : {}) }
      : node;
  });
  nodes = mergeText(nodes);
  for (let index = 0; index < nodes.length; index += 1) {
    if (isSoftBreak(nodes[index])) stripLineEnd(nodes, index);
  }
  for (;;) {
    stripLineEnd(nodes, nodes.length);
    nodes = mergeText(nodes);
    const last = nodes[nodes.length - 1];
    // A cell's last `<br>` reads back as a line break; a paragraph's does not.
    if (last?.type !== NODE.hardbreak || kind === 'cell') break;
    nodes.pop();
  }
  return kind === 'cell' && nodes.every(isBlank) ? [] : nodes;
}

/** A line break, or whitespace: a cell holding only these reads back empty. */
const isBlank = (node: NodeJson): boolean =>
  node.type === NODE.hardbreak ||
  (isText(node) && !isCode(node) && /^[ \t]*$/.test(node.text ?? ''));

const INLINE_KIND: Partial<Record<string, InlineKind>> = {
  [NODE.paragraph]: 'paragraph',
  [NODE.heading]: 'heading',
};

/**
 * Empty paragraphs at either end of a container's children, which no spelling
 * reaches. A list item's empty first child is the schema's filler: it is kept
 * when the item's first block is not a paragraph (`- > quote`), and dropped
 * with the rest when it is — such an item is written `- text` and reads back
 * with no filler. After a first paragraph that holds text, empty paragraphs
 * are blank lines inside the item, and are written.
 */
function trimContainer(node: NodeJson, children: NodeJson[]): NodeJson[] {
  const first = children[0];
  const leading = node.type !== NODE.listItem || (first !== undefined && isEmptyParagraph(first));
  let start = 0;
  while (leading && start < children.length && isEmptyParagraph(children[start] as NodeJson)) {
    start += 1;
  }
  let end = children.length;
  while (end > start && isEmptyParagraph(children[end - 1] as NodeJson)) end -= 1;
  const kept = children.slice(start, end);
  // The filler stays in front of an item that starts with another block, or is empty.
  const filler = node.type === NODE.listItem && first !== undefined && start > 0;
  return filler && kept[0]?.type !== NODE.paragraph ? [first, ...kept] : kept;
}

/** The links a node is part of, as `markKey`s. */
const linksOf = (node: NodeJson | undefined): string =>
  (node?.marks ?? [])
    .filter((mark) => mark.type === MARK.link)
    .map(markKey)
    .sort()
    .join('\u0001');

/**
 * Whether a link opens or closes between `previous` and `node`, so the line
 * that ends at `node` holds the link's `[` or its `](…)`.
 */
const linkEdge = (node: NodeJson, previous: NodeJson | undefined): boolean =>
  linksOf(node) !== linksOf(previous);

/**
 * A paragraph with empty lines in it, as the blocks the file reads it as. An
 * empty line is a soft line break that ends a line holding nothing — at the
 * paragraph's start, or right after another line break, and with no link
 * opening or closing on it (`[` then a line break starts a link's text on the
 * next line; a line break then `](…)` ends it on one of its own) — and it is
 * written as an empty line, which ends the paragraph. So `n` empty lines between two
 * lines of text are a paragraph break plus `n - 1` empty paragraphs, `n` at
 * the start are `n` empty paragraphs before it, and the line break before an
 * empty line is at the end of a paragraph, which is not written. A line that
 * held only a hard break before an empty line is left with nothing, so it
 * counts as nothing at all. `content` is already `normalizeInline`d, so a line
 * holding only whitespace is empty.
 */
function splitAtEmptyLines(paragraph: NodeJson, content: NodeJson[]): NodeJson[] {
  const blocks: NodeJson[] = [];
  let run: NodeJson[] = [];
  let split = false;
  let emptyLines = 0;
  let started = false;
  let lineEmpty = true;
  let previous: NodeJson | undefined;
  const endRun = () => {
    const text = normalizeInline(run, 'paragraph');
    run = [];
    if (text.length === 0) return;
    const empties = started ? emptyLines - 1 : emptyLines;
    for (let index = 0; index < empties; index += 1) blocks.push({ ...paragraph, content: [] });
    blocks.push({ ...paragraph, content: text });
    started = true;
    emptyLines = 0;
  };
  for (const node of content) {
    const empty = lineEmpty && isSoftBreak(node) && !linkEdge(node, previous);
    previous = node;
    if (empty) {
      endRun();
      split = true;
      emptyLines += 1;
      continue;
    }
    run.push(node);
    lineEmpty = node.type === NODE.hardbreak;
  }
  if (!split) return [{ ...paragraph, content }];
  endRun();
  return blocks.length > 0 ? blocks : [{ ...paragraph, content: [] }];
}

const CONTAINERS = new Set<string>([NODE.blockquote, NODE.listItem, NODE.footnoteDefinition]);

/**
 * Whether a list item's blocks (trimmed, `trimContainer`) can only be written
 * with a blank line between two of them, which reads the item back loose: two
 * paragraphs in a row (a paragraph cannot interrupt one; the editor makes the
 * pair with Backspace at a nested item's start), or an empty paragraph between
 * two blocks (written as extra blank lines). An HTML block after a paragraph is
 * not such a pair: it may interrupt the paragraph, or sit on a lazy line
 * (`./blocks.ts`). The first child may be the schema's empty filler, which is
 * not written at all.
 */
function needsBlankLine(children: readonly NodeJson[]): boolean {
  return children.some((child, index) => {
    if (index === 0 || child.type !== NODE.paragraph) return false;
    if (isEmptyParagraph(child)) return true;
    const previous = children[index - 1] as NodeJson;
    return previous.type === NODE.paragraph && !isEmptyParagraph(previous) && !isHtmlBlock(child);
  });
}

/**
 * `node` with the house style's structural normalizations, recursively: the
 * blocks the serializer writes for it, which a reparse must reproduce. One
 * block, except a paragraph with empty lines in it (`splitAtEmptyLines`).
 */
export function normalizeBlock(node: NodeJson, inCell = false): NodeJson[] {
  if (node.type === NODE.frontmatter) return [withLfValue(node)];
  if (node.type === NODE.codeBlock) {
    const text = (node.content ?? []).map((child) => child.text ?? '').join('');
    return [/\r/.test(text) ? { ...node, content: [{ type: NODE.text, text: lf(text) }] } : node];
  }
  if (!node.content) return [node];
  const kind = inCell && node.type === NODE.paragraph ? 'cell' : INLINE_KIND[node.type];
  if (kind === 'paragraph') return splitAtEmptyLines(node, normalizeInline(node.content, kind));
  if (kind) return [{ ...node, content: normalizeInline(node.content, kind) }];
  const cell = node.type === NODE.tableHeader || node.type === NODE.tableCell;
  let children = node.content.flatMap((child) => normalizeBlock(child, cell));
  if (CONTAINERS.has(node.type)) children = trimContainer(node, children);
  if (node.type === NODE.listItem && node.attrs?.spread !== true && needsBlankLine(children)) {
    return [{ ...node, attrs: { ...node.attrs, spread: true }, content: children }];
  }
  return [{ ...node, content: children }];
}

/** Attributes left out of a comparison, per node type (see the module header). */
const SPELLING_ATTRS: Partial<Record<string, readonly string[]>> = {
  [NODE.heading]: ['id'],
  [NODE.listItem]: ['label', 'listType'],
  [NODE.tableHeader]: ['colwidth'],
  [NODE.tableCell]: ['colwidth', 'alignment'],
};

/** A node as `canonical` writes it: what a parse check compares. */
export interface CanonicalNode {
  type: string;
  attrs?: Record<string, unknown>;
  /** `markKey`s, sorted. */
  marks?: string[];
  text?: string;
  content?: CanonicalNode[];
}

function canonicalAttrs(type: string, attrs: Readonly<Record<string, unknown>> | undefined) {
  if (!attrs) return undefined;
  const dropped = SPELLING_ATTRS[type] ?? [];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort()) {
    if (dropped.includes(key)) continue;
    let value = attrs[key];
    if (type === NODE.image && key === 'title') value = value ?? '';
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function canonicalMarks(marks: readonly MarkJson[] | undefined): string[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  return marks.map(markKey).sort();
}

function canonicalNode(node: NodeJson): CanonicalNode {
  const out: CanonicalNode = { type: node.type };
  const attrs = canonicalAttrs(node.type, node.attrs);
  if (attrs) out.attrs = attrs;
  const marks = canonicalMarks(node.marks);
  if (marks) out.marks = marks;
  if (node.text !== undefined) out.text = node.text;
  // An emptied paragraph and one that never had content are the same node.
  if (node.content && node.content.length > 0) out.content = node.content.map(canonicalNode);
  return out;
}

/**
 * The comparable form of a run of top-level blocks: normalized (which also
 * merges text runs that differed only in a spelling attribute, `_a_*b*`) and
 * with the spelling attributes dropped. Two runs are the same document exactly
 * when these strings are equal.
 */
export function canonical(blocks: readonly NodeJson[]): string {
  return JSON.stringify(blocks.flatMap((block) => normalizeBlock(block)).map(canonicalNode));
}

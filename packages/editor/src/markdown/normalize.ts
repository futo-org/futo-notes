/**
 * What "the same document" means to the serializer, in two parts.
 *
 * 1. The house style's deliberate normalizations (docs/spec/editor.md
 *    "Markdown house style"), applied to a document before it is written:
 *    whitespace at the end of a line and a line break at the end of a
 *    paragraph, heading or cell are dropped (the parser drops them on every
 *    read), a heading's line breaks become spaces (an ATX heading is one line),
 *    empty paragraphs at the start or end of a quote, list item or footnote
 *    are dropped (no markdown spelling reaches them), the CR or CRLF line
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
import { MARK, NODE, isEmptyParagraph, type MarkJson, type NodeJson } from './docJson';

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
    if (last?.type !== NODE.hardbreak) break;
    nodes.pop();
  }
  return nodes;
}

const INLINE_KIND: Partial<Record<string, InlineKind>> = {
  [NODE.paragraph]: 'paragraph',
  [NODE.heading]: 'heading',
};

/**
 * Empty paragraphs at either end of a container's children, which no spelling
 * reaches. A list item's first child is always kept: it is the schema's filler
 * when empty, and the empty paragraphs after a filler are at the item's start
 * too. After a first paragraph that holds text they are blank lines inside the
 * item, and are written.
 */
function trimContainer(node: NodeJson, children: NodeJson[]): NodeJson[] {
  const keepFirst = node.type === NODE.listItem ? 1 : 0;
  const first = children[0];
  const leading = keepFirst === 0 || (first !== undefined && isEmptyParagraph(first));
  let start = keepFirst;
  while (leading && start < children.length && isEmptyParagraph(children[start] as NodeJson)) {
    start += 1;
  }
  let end = children.length;
  while (end > start && isEmptyParagraph(children[end - 1] as NodeJson)) end -= 1;
  return [...children.slice(0, keepFirst), ...children.slice(start, end)];
}

const CONTAINERS = new Set<string>([NODE.blockquote, NODE.listItem, NODE.footnoteDefinition]);

/** A paragraph that is one block of HTML (the preset wraps HTML blocks in one). */
const isHtmlBlock = (node: NodeJson): boolean =>
  node.content?.length === 1 && node.content[0]?.type === NODE.html;

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
 * `node` with the house style's structural normalizations, recursively. The
 * result is what the serializer writes and what a reparse must reproduce.
 */
export function normalizeBlock(node: NodeJson, inCell = false): NodeJson {
  if (node.type === NODE.frontmatter) return withLfValue(node);
  if (node.type === NODE.codeBlock) {
    const text = (node.content ?? []).map((child) => child.text ?? '').join('');
    return /\r/.test(text) ? { ...node, content: [{ type: NODE.text, text: lf(text) }] } : node;
  }
  if (!node.content) return node;
  const kind = inCell && node.type === NODE.paragraph ? 'cell' : INLINE_KIND[node.type];
  if (kind) return { ...node, content: normalizeInline(node.content, kind) };
  const cell = node.type === NODE.tableHeader || node.type === NODE.tableCell;
  let children = node.content.map((child) => normalizeBlock(child, cell));
  if (CONTAINERS.has(node.type)) children = trimContainer(node, children);
  if (node.type === NODE.listItem && node.attrs?.spread !== true && needsBlankLine(children)) {
    return { ...node, attrs: { ...node.attrs, spread: true }, content: children };
  }
  return { ...node, content: children };
}

/** Attributes left out of a comparison, per node type (see the module header). */
const SPELLING_ATTRS: Partial<Record<string, readonly string[]>> = {
  [NODE.heading]: ['id'],
  [NODE.listItem]: ['label', 'listType'],
  [NODE.tableHeader]: ['colwidth'],
  [NODE.tableCell]: ['colwidth', 'alignment'],
};

type Canon = Record<string, unknown>;

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

function canonicalNode(node: NodeJson): Canon {
  const out: Canon = { type: node.type };
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
  return JSON.stringify(blocks.map((block) => canonicalNode(normalizeBlock(block))));
}

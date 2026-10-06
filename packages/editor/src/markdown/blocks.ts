/**
 * Block nodes as lines of pieces (`./pieces.ts`), following docs/spec/editor.md
 * "Markdown house style". Containers (quotes, list items, footnotes) write
 * their children and prefix every line; inline content goes through
 * `./inline.ts`. Nothing here parses: where a spelling might read differently
 * (a `---` inside a list item), it is offered as a site and `./choose.ts`
 * decides.
 *
 * The input is already normalized (`./normalize.ts` `normalizeBlock`).
 */
import { NODE, UnknownNodeError, attr, isEmptyParagraph, textOf, type NodeJson } from './docJson';
import { writeInline } from './inline';
import { blankLines, prefixLines, type Line, type Sites } from './pieces';

/** The marker a list is written with: `-`/`*` for bullets, `.`/`)` after an ordered number. */
export type ListMarker = '-' | '*' | '.' | ')';

/** What a block's spelling depends on outside the block itself. */
export interface BlockPosition {
  /** The block starts on the file's first line (no front matter or blank line before it). */
  readonly firstLine: boolean;
  /** For a list: the marker to write it with (it alternates with a list it touches). */
  readonly listMarker: ListMarker | null;
}

export const DEFAULT_MARKER = { bullet: '-', ordered: '.' } as const;

/** The marker a list uses after a touching list of the same kind that used `previous`. */
export function alternateMarker(previous: ListMarker): ListMarker {
  return ({ '-': '*', '*': '-', '.': ')', ')': '.' } as const)[previous];
}

export function listKind(node: NodeJson): 'bullet' | 'ordered' | null {
  if (node.type === NODE.bulletList) return 'bullet';
  if (node.type === NODE.orderedList) return 'ordered';
  return null;
}

/** A single line: a heading's or a cell's inline content never spans two. */
function oneLine(lines: readonly Line[]): Line {
  return lines.flatMap((line, index) => (index === 0 ? line : [' ', ...line]));
}

function writeHeading(node: NodeJson, sites: Sites): Line[] {
  const level = Math.min(6, Math.max(1, attr<number>(node, 'level') ?? 1));
  const hashes = '#'.repeat(level);
  const text = oneLine(writeInline(node.content ?? [], 'heading', sites, `${hashes} `));
  return [text.length === 0 ? [hashes] : [`${hashes} `, ...text]];
}

function writeCode(node: NodeJson): Line[] {
  const language = attr<string>(node, 'language') ?? '';
  const text = textOf(node);
  const fenceCharacter = language.includes('`') ? '~' : '`';
  const opening = new RegExp(`^ {0,3}(\\${fenceCharacter}+)`);
  let longest = 0;
  for (const line of text.split('\n')) {
    longest = Math.max(longest, opening.exec(line)?.[1]?.length ?? 0);
  }
  const fence = fenceCharacter.repeat(Math.max(3, longest + 1));
  const body = text === '' ? [] : text.split('\n').map((line): Line => [line]);
  return [[fence + language], ...body, [fence]];
}

function writeFrontmatter(node: NodeJson): Line[] {
  const value = attr<string>(node, 'value') ?? '';
  const body = value === '' ? [] : value.split('\n').map((line): Line => [line]);
  return [['---'], ...body, ['---']];
}

function writeTable(node: NodeJson, sites: Sites): Line[] {
  const [header, ...body] = node.content ?? [];
  if (!header) return [];
  const row = (rowNode: NodeJson): Line => {
    const line: Line = ['|'];
    for (const cell of rowNode.content ?? []) {
      const paragraph = cell.content?.[0];
      const content = oneLine(writeInline(paragraph?.content ?? [], 'cell', sites));
      line.push(' ', ...content, ' |');
    }
    return line;
  };
  const delimiter: Line = ['|'];
  for (const cell of header.content ?? []) {
    const alignment = attr<string | null>(cell, 'alignment');
    const spelling =
      alignment === 'left'
        ? ':--'
        : alignment === 'center'
          ? ':-:'
          : alignment === 'right'
            ? '--:'
            : '---';
    delimiter.push(` ${spelling} |`);
  }
  // A row with no cells is the schema's filler for a table with no body rows
  // (`table_header_row table_row+`); the reread fills it in again.
  const rows = body.filter((rowNode) => (rowNode.content?.length ?? 0) > 0);
  return [row(header), delimiter, ...rows.map(row)];
}

/** A paragraph that is one block of HTML (the preset wraps HTML blocks in one). */
function isHtmlBlock(node: NodeJson): boolean {
  return (
    node.type === NODE.paragraph &&
    node.content?.length === 1 &&
    node.content[0]?.type === NODE.html
  );
}

/**
 * The first lines of blocks that may be written LAZILY — without their list
 * item's indent. An HTML block that cannot interrupt a paragraph (`</grid>`)
 * sits in a tight item after its paragraph only through a lazy line; indented,
 * it would read as more of the paragraph. A parse decides (`writeItem`).
 */
const lazyLines = new WeakSet<Line>();

interface ChildrenOptions {
  /** A tight list item: its blocks are separated by a newline, not a blank line. */
  readonly tight: boolean;
  /** A blockquote (see `touches`). */
  readonly quote?: boolean;
}

/**
 * Whether `next`, written on the line after `previous` in a tight list item,
 * could be read as more of it: a paragraph, HTML or a table cannot interrupt a
 * paragraph, and is a lazy continuation of one ending a list or a quote. The
 * house style still writes the newline a tight item reads with; the blank line
 * the parse may need is offered as a layout site. (Inside a blockquote the
 * parser does not count such a blank line toward looseness, so it is how a
 * quoted tight item holding a list and then a paragraph is written.)
 */
function mayRunOn(previous: NodeJson, next: NodeJson): boolean {
  const opensFlow = next.type === NODE.paragraph || next.type === NODE.table;
  const endsInText =
    previous.type === NODE.paragraph ||
    previous.type === NODE.table ||
    previous.type === NODE.blockquote ||
    listKind(previous) !== null;
  return opensFlow && endsInText;
}

/**
 * Inside a blockquote, a blank `>` line after a tight list makes the parser
 * read that list as LOOSE when a list or a quote follows (measured: never for a
 * heading, paragraph, code, rule, HTML or table). Both can start right under
 * the list, so they are written there and the list stays tight.
 */
function touches(previous: NodeJson, next: NodeJson, options: ChildrenOptions): boolean {
  if (!options.quote || !listKind(previous) || attr(previous, 'spread') === true) return false;
  return listKind(next) !== null || next.type === NODE.blockquote;
}

/**
 * A container's children, separated as the container reads them: a blank line
 * between blocks (a newline in a tight list item), plus one more blank line per
 * empty paragraph between them. Touching lists alternate markers here too.
 */
function writeChildren(
  children: readonly NodeJson[],
  options: ChildrenOptions,
  sites: Sites,
): Line[] {
  const lines: Line[] = [];
  let previous: NodeJson | null = null;
  let emptyBefore = 0;
  let previousList: { kind: string; marker: ListMarker } | null = null;
  for (const child of children) {
    if (isEmptyParagraph(child)) {
      if (previous) emptyBefore += 1;
      continue;
    }
    const kind = listKind(child);
    let listMarker: ListMarker | null = null;
    if (kind) {
      listMarker =
        previousList && previousList.kind === kind
          ? alternateMarker(previousList.marker)
          : DEFAULT_MARKER[kind];
    }
    if (previous) {
      const blank =
        emptyBefore > 0
          ? emptyBefore + 1
          : options.tight || touches(previous, child, options)
            ? 0
            : 1;
      lines.push(...blankLines(blank));
      if (blank === 0 && options.tight && mayRunOn(previous, child))
        lines.push(sites.optionalLine());
    }
    const written = writeBlock(child, { firstLine: false, listMarker }, sites, true);
    if (options.tight && previous?.type === NODE.paragraph && isHtmlBlock(child) && written[0]) {
      lazyLines.add(written[0]);
    }
    lines.push(...written);
    previousList = kind && listMarker ? { kind, marker: listMarker } : null;
    previous = child;
    emptyBefore = 0;
  }
  return lines;
}

function writeItem(item: NodeJson, marker: string, sites: Sites): Line[] {
  const checked = attr<boolean | null>(item, 'checked');
  const box = checked === true ? '[x]' : checked === false ? '[ ]' : null;
  const tight = attr<boolean>(item, 'spread') !== true;
  const children = item.content ?? [];
  const [first, ...rest] = children;
  let lines: Line[];
  if (first && isEmptyParagraph(first)) {
    // The schema's filler in front of an item that starts with a block, or an
    // empty item. Not written: the next block goes on the marker line.
    const after = writeChildren(rest, { tight }, sites);
    if (box === null) lines = after.length > 0 ? after : [[]];
    else lines = after.length > 0 ? [[box], ...blankLines(tight ? 0 : 1), ...after] : [[box]];
  } else {
    lines = writeChildren(children, { tight }, sites);
    if (box !== null) lines[0] = [`${box} `, ...(lines[0] ?? [])];
  }
  const indent = ' '.repeat(marker.length);
  return prefixLines(lines, marker, indent).map((line, index) =>
    index > 0 && lazyLines.has(lines[index] as Line)
      ? [sites.layoutPiece([indent, '']), ...line.slice(1)]
      : line,
  );
}

/**
 * Whether `node` is, or ends in, a list the document holds as loose. Such a
 * list as the last block of a quote or of a tight list's item may have been
 * made loose by a blank line the house style has no other reason to write —
 * inside a quote the parser counts it toward the innermost list — so that
 * blank line is offered as a layout site.
 */
function endsWithLooseList(node: NodeJson | undefined): boolean {
  if (!node) return false;
  if (listKind(node)) {
    return (
      attr(node, 'spread') === true || endsWithLooseList(node.content?.[node.content.length - 1])
    );
  }
  if (node.type !== NODE.listItem) return false;
  const last = node.content?.[node.content.length - 1];
  return last !== undefined && listKind(last) !== null && endsWithLooseList(last);
}

function writeList(node: NodeJson, listMarker: ListMarker | null, sites: Sites): Line[] {
  const ordered = node.type === NODE.orderedList;
  const marker = listMarker ?? (ordered ? DEFAULT_MARKER.ordered : DEFAULT_MARKER.bullet);
  const start = ordered ? (attr<number>(node, 'order') ?? 1) : 0;
  const loose = attr<boolean>(node, 'spread') === true;
  const items = node.content ?? [];
  const lines: Line[] = [];
  items.forEach((item, index) => {
    if (index > 0 && loose) lines.push([]);
    if (index > 0 && !loose && endsWithLooseList(items[index - 1]))
      lines.push(sites.optionalLine());
    const prefix = ordered ? `${start + index}${marker} ` : `${marker} `;
    lines.push(...writeItem(item, prefix, sites));
  });
  return lines;
}

/** One block as lines. `nested` is true inside a quote, list item or footnote. */
export function writeBlock(
  node: NodeJson,
  position: BlockPosition,
  sites: Sites,
  nested = false,
): Line[] {
  switch (node.type) {
    case NODE.paragraph:
      return writeInline(node.content ?? [], 'paragraph', sites);
    case NODE.heading:
      return writeHeading(node, sites);
    case NODE.codeBlock:
      return writeCode(node);
    case NODE.hr:
      // `---` opens front matter on line 1; inside a list item it can be read
      // as a setext underline or as the item's own marker, so a parse decides.
      if (position.firstLine) return [['***']];
      return [[nested ? sites.piece(['---', '***']) : '---']];
    case NODE.blockquote: {
      const children = node.content ?? [];
      const lines = writeChildren(children, { tight: false, quote: true }, sites);
      if (endsWithLooseList(children[children.length - 1])) lines.push(sites.optionalLine());
      return lines.length === 0 ? [['>']] : prefixLines(lines, '> ', '> ', '>');
    }
    case NODE.bulletList:
    case NODE.orderedList:
      return writeList(node, position.listMarker, sites);
    case NODE.table:
      return writeTable(node, sites);
    case NODE.frontmatter:
      return writeFrontmatter(node);
    case NODE.footnoteDefinition: {
      const label = `[^${attr<string>(node, 'label') ?? ''}]: `;
      const lines = writeChildren(node.content ?? [], { tight: false }, sites);
      return lines.length === 0 ? [[label.trimEnd()]] : prefixLines(lines, label, '    ');
    }
    default:
      throw new UnknownNodeError(node.type);
  }
}

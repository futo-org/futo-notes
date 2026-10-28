// The open document as the agent reads it: lines, the way the editor's screen shows them,
// each carrying its real ProseMirror positions. A line is a textblock (a paragraph, a heading,
// a list item's first block, a table cell, a code line) up to a line break; positions are the
// editor's own, so PlaceCaret, Select and every receipt speak the same coordinates the
// editor does, and nothing translates between markdown offsets and the document.
import type { Mark, Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorState } from '@milkdown/kit/prose/state';

import { FRONTMATTER_NODE } from '@futo-notes/editor/milkdown-compat';

import { isLineBreak } from '../../features/editor/milkdown/paragraphLines';
import { tagDecorationsKey } from '../../features/editor/milkdown/tagDecorations';
import { wikilinkDisplay } from '../../features/editor/milkdown/wikilink/display';
import { WIKILINK_NODE } from '../../features/editor/milkdown/wikilink/node';
import type { WikilinkIndex } from '$shared/note/wikilinks';

/** What an inline object with no text of its own and no reading of its own reads as. */
const OBJECT_CHARACTER = '￼';

/** One stretch of a line: a text node, or an inline leaf (a chip, an image). */
interface Piece {
  pos: number;
  /** How many positions it spans: a text node's length, 1 for a leaf. */
  size: number;
  text: string;
  /** Text: a position per character. A leaf is one position, whatever its text reads as. */
  isText: boolean;
  node: ProseNode;
}

export interface ModelLine {
  line: number;
  /** Where the line's text starts: the caret position before its first character. */
  at: number;
  /** Where it ends: the caret position after its last character. */
  end: number;
  /** What the block is: `heading 1`, `task ☐`, `quote > bullet`, `code js`, `cell r2c1`… */
  kind: string;
  /** List nesting below the outermost list, when there is any. */
  indent?: number;
  text: string;
  pieces: Piece[];
  /** The textblock the line belongs to, null for a divider, and which of its lines this is. */
  textblock: ProseNode | null;
  segment: number;
}

const MARK_NAMES: Record<string, string> = {
  strong: 'bold',
  emphasis: 'italic',
  strike_through: 'strikethrough',
  inlineCode: 'code',
};

/**
 * An inline leaf as the screen shows it. A link to a note reads as the words its chip shows,
 * `[[atlas/roadmap]]`, and `[[roadmap]]!broken` when it opens no note (absent or ambiguous), as
 * the chip is drawn muted then. An image reads as `[image photo.png]`. The saved markdown is
 * `doc`'s `md│` line.
 */
function leafText(node: ProseNode, index: WikilinkIndex): string {
  if (node.type.name === WIKILINK_NODE) {
    const { text, resolvedId } = wikilinkDisplay(node.attrs.target as string, index);
    return resolvedId === null ? `[[${text}]]!broken` : `[[${text}]]`;
  }
  if (node.type.name === 'image') {
    const src = String(node.attrs.src ?? '');
    const name = src.split(/[?#]/)[0].split('/').pop() || String(node.attrs.alt ?? '');
    return `[image ${name}]`;
  }
  return node.type.spec.leafText?.(node) ?? OBJECT_CHARACTER;
}

function listMarker(item: ProseNode, list: ProseNode, index: number): string {
  if (item.attrs.checked !== null && item.attrs.checked !== undefined) {
    return item.attrs.checked ? 'task ☑' : 'task ☐';
  }
  if (list.type.name === 'ordered_list') return `${(list.attrs.order as number) + index}.`;
  return 'bullet';
}

/** A node on the way down from the document to a block, and its index in its parent. */
interface Step {
  node: ProseNode;
  index: number;
}

/**
 * The block's kind, read off the walk's own path to it, from the top-level block down to the
 * block itself: no `doc.resolve`, which scans a long note's blocks from the start every time.
 * `continues`: a line below the block's first, which no list marker is drawn on.
 */
function kindAt(path: readonly Step[], continues = false): { kind: string; indent: number } {
  const node = path[path.length - 1].node;
  const parts: string[] = [];
  let lists = 0;
  // `path[depth - 1]` is the ancestor at `depth`; `path[depth].index` where the way down goes in it.
  for (let depth = 1; depth < path.length; depth++) {
    const ancestor = path[depth - 1].node;
    switch (ancestor.type.name) {
      case 'blockquote':
        parts.push('quote');
        break;
      case 'list_item':
        lists++;
        // Only an item's first block carries its marker; a second paragraph continues it.
        if (path[depth].index === 0 && depth > 1 && !continues) {
          parts.push(listMarker(ancestor, path[depth - 2].node, path[depth - 1].index));
        }
        break;
      case 'table_cell':
      case 'table_header':
        parts.push(
          `${ancestor.type.name === 'table_header' ? 'header' : 'cell'} r${path[depth - 2].index + 1}c${path[depth - 1].index + 1}`,
        );
        break;
      case 'bullet_list':
      case 'ordered_list':
      case 'table':
      case 'table_header_row':
      case 'table_row':
        break;
      default:
        parts.push(ancestor.type.name);
    }
  }
  const name = node.type.name;
  if (name === 'heading') parts.push(`heading ${node.attrs.level as number}`);
  else if (name === 'code_block')
    parts.push(node.attrs.language ? `code ${node.attrs.language as string}` : 'code');
  else if (name === 'hr') parts.push('divider');
  else if (name !== 'paragraph') parts.push(name);
  else if (parts.length === 0) parts.push('paragraph');
  return { kind: parts.join(' > '), indent: Math.max(0, lists - 1) };
}

function line(
  kind: { kind: string; indent: number },
  at: number,
  end: number,
  pieces: Piece[],
  textblock: ProseNode | null,
  segment: number,
): Omit<ModelLine, 'line'> {
  return {
    at,
    end,
    kind: kind.kind,
    ...(kind.indent > 0 ? { indent: kind.indent } : {}),
    text: pieces.map((piece) => piece.text).join(''),
    pieces,
    textblock,
    segment,
  };
}

function textblockLines(
  path: readonly Step[],
  node: ProseNode,
  pos: number,
  index: WikilinkIndex,
): Omit<ModelLine, 'line'>[] {
  const [first, continued] = [kindAt(path), kindAt(path, true)];
  const kind = (segment: number) => (segment === 0 ? first : continued);
  const start = pos + 1;
  // Code is one textblock whose text holds its newlines: a line per newline, as on screen. Any
  // other textblock draws a line per line break, whether Enter or a `\` in the file made it.
  if (node.type.spec.code) {
    let offset = 0;
    return node.textContent.split('\n').map((text, segment) => {
      const at = start + offset;
      offset += text.length + 1;
      const pieces = text === '' ? [] : [{ pos: at, size: text.length, text, isText: true, node }];
      return line(kind(segment), at, at + text.length, pieces, node, segment);
    });
  }
  const lines: Omit<ModelLine, 'line'>[] = [];
  let lineStart = start;
  let pieces: Piece[] = [];
  node.forEach((child, offset) => {
    const childPos = start + offset;
    if (isLineBreak(child)) {
      lines.push(line(kind(lines.length), lineStart, childPos, pieces, node, lines.length));
      lineStart = childPos + 1;
      pieces = [];
      return;
    }
    pieces.push({
      pos: childPos,
      size: child.nodeSize,
      text: child.isText ? (child.text ?? '') : leafText(child, index),
      isText: child.isText,
      node: child,
    });
  });
  lines.push(
    line(kind(lines.length), lineStart, start + node.content.size, pieces, node, lines.length),
  );
  return lines;
}

/** A line of one top-level block, its positions counted from the block's own start. */
export type BlockLine = Omit<ModelLine, 'line'>;

// A chip's words follow the vault as well as the document: a note created or renamed elsewhere
// can turn a broken link into a working one, so a block that holds a chip is kept per vault
// index too (null: it holds none, and any index reads it the same).
const linesByBlock = new WeakMap<ProseNode, { index: WikilinkIndex | null; lines: BlockLine[] }>();

/**
 * A top-level block's lines, top to bottom. Kept on the block's node, which ProseMirror shares
 * between documents until an edit touches it: a new version of a long note re-reads only the
 * blocks that changed (puppetNoteLines.ts puts them together).
 */
export function blockLines(block: ProseNode, index: WikilinkIndex): BlockLine[] {
  const cached = linesByBlock.get(block);
  if (cached && (cached.index === null || cached.index === index)) return cached.lines;
  const lines: BlockLine[] = [];
  const visit = (node: ProseNode, pos: number, path: Step[]): void => {
    if (node.isTextblock) lines.push(...textblockLines(path, node, pos, index));
    else if (node.isBlock && node.isLeaf) {
      // One atom, so one line: front matter reads as the value it draws, a divider as nothing.
      const text = node.type.name === FRONTMATTER_NODE ? String(node.attrs.value) : '';
      lines.push({ ...line(kindAt(path), pos, pos + node.nodeSize, [], null, 0), text });
    } else {
      node.forEach((child, offset, childIndex) =>
        visit(child, pos + 1 + offset, [...path, { node: child, index: childIndex }]),
      );
    }
  };
  visit(block, 0, [{ node: block, index: 0 }]);
  const readsIndex = lines.some((entry) =>
    entry.pieces.some((piece) => piece.node.type.name === WIKILINK_NODE),
  );
  linesByBlock.set(block, { index: readsIndex ? index : null, lines });
  return lines;
}

/** The position `offset` characters into a line's text. Inside a chip's text it lands on the chip's edge. */
export function positionInLine(entry: ModelLine, offset: number, side: -1 | 1): number {
  let consumed = 0;
  for (const piece of entry.pieces) {
    const length = piece.text.length;
    if (offset <= consumed + length) {
      const into = offset - consumed;
      if (piece.isText) return piece.pos + into;
      if (into === 0) return piece.pos;
      if (into === length) return piece.pos + piece.size;
      return side < 0 ? piece.pos : piece.pos + piece.size;
    }
    consumed += length;
  }
  return entry.end;
}

/** How many characters of a line's text come before `pos`. */
export function offsetInLine(entry: ModelLine, pos: number): number {
  let consumed = 0;
  for (const piece of entry.pieces) {
    if (pos <= piece.pos) return consumed;
    if (pos < piece.pos + piece.size) {
      return consumed + (piece.isText ? pos - piece.pos : 0);
    }
    consumed += piece.text.length;
  }
  return consumed;
}

/** The lines' text joined by newlines, and where each line starts in it: what an anchor searches. */
export function documentText(lines: readonly ModelLine[]): { text: string; starts: number[] } {
  const starts: number[] = [];
  let length = 0;
  for (const entry of lines) {
    starts.push(length);
    length += entry.text.length + 1;
  }
  return { text: lines.map((entry) => entry.text).join('\n'), starts };
}

/** The position of character `index` of `documentText`. */
export function positionOfTextIndex(
  lines: readonly ModelLine[],
  starts: readonly number[],
  index: number,
  side: -1 | 1,
): number {
  let lineIndex = starts.length - 1;
  while (lineIndex > 0 && starts[lineIndex] > index) lineIndex--;
  const entry = lines[lineIndex];
  const offset = Math.min(index - starts[lineIndex], entry.text.length);
  return positionInLine(entry, offset, side);
}

/** What the screen shows between two positions, lines joined by newlines. */
export function textBetween(lines: readonly ModelLine[], from: number, to: number): string {
  const parts: string[] = [];
  for (const entry of lines) {
    if (entry.end < from || entry.at > to) continue;
    const start = from <= entry.at ? 0 : offsetInLine(entry, from);
    const end = to >= entry.end ? entry.text.length : offsetInLine(entry, to);
    parts.push(entry.text.slice(start, end));
  }
  return parts.join('\n');
}

const markdownByTextblock = new WeakMap<ProseNode, Map<number, string>>();

/**
 * A line's saved markdown: the inline content between its line breaks, through the editor's
 * own serializer, so escapes and normalization show exactly as they will be written. The
 * block's own syntax (`# `, `- [ ] `) is its `kind`. Only the line asked for is serialized,
 * cached per textblock, which ProseMirror shares between documents until it changes.
 */
export function lineMarkdown(
  entry: ModelLine,
  doc: ProseNode,
  serialize: (doc: ProseNode) => string | null,
): string | null {
  const block = entry.textblock;
  if (!block || block.type.spec.code) return null;
  let lines = markdownByTextblock.get(block);
  if (!lines) markdownByTextblock.set(block, (lines = new Map()));
  let markdown = lines.get(entry.segment);
  if (markdown === undefined) {
    const paragraph = block.type.schema.nodes.paragraph.create(
      null,
      entry.pieces.map((piece) => piece.node),
    );
    markdown = serialize(doc.type.create(null, paragraph))?.replace(/\n+$/, '') ?? '';
    lines.set(entry.segment, markdown);
  }
  return markdown;
}

function markName(mark: Mark): string {
  if (mark.type.name === 'link') return `link ${mark.attrs.href as string}`;
  return MARK_NAMES[mark.type.name] ?? mark.type.name;
}

/** A line's runs: each stretch of text with its formatting, and each inline object, at its position. */
export function lineRuns(entry: ModelLine): Record<string, unknown>[] {
  return entry.pieces.map((piece) => {
    if (piece.isText) {
      const marks = piece.node.isText ? piece.node.marks.map(markName) : [];
      return { at: piece.pos, text: piece.text, ...(marks.length ? { marks } : {}) };
    }
    const name = piece.node.type.name;
    const attrs = Object.fromEntries(
      Object.entries(piece.node.attrs).filter(([, value]) => value !== null && value !== ''),
    );
    return { at: piece.pos, node: name, text: piece.text, ...attrs };
  });
}

/** The `#tags` the editor paints on a line — a decoration over plain text, not a mark. */
export function lineTags(state: EditorState, entry: ModelLine): Record<string, unknown>[] {
  const decorations = tagDecorationsKey.getState(state)?.find(entry.at, entry.end) ?? [];
  return decorations.map((decoration) => ({
    from: decoration.from,
    to: decoration.to,
    tag: state.doc.textBetween(decoration.from, decoration.to),
  }));
}

/**
 * Lines as one string, a line per line: `kind│markdown`. What a receipt diffs, so a hunk
 * reads as the line it touched (`task ☐` → `task ☑`, `Sam` → `**Sam**`).
 */
export function linesListing(
  lines: readonly ModelLine[],
  doc: ProseNode,
  serialize: (doc: ProseNode) => string | null,
): string {
  return (
    lines
      // `⏎` for a newline inside a line's markdown, so the listing keeps a line per line.
      .map(
        (entry) =>
          `${entry.kind}│${(lineMarkdown(entry, doc, serialize) ?? entry.text).replace(/\n/g, '⏎')}`,
      )
      .join('\n')
  );
}

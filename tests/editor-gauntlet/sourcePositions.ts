/**
 * Markdown source offset -> a position a rich-text candidate can actually use.
 *
 * The gauntlet's runners speak markdown source offsets, because the source IS
 * the document for a source-mode editor like CM6. A WYSIWYG candidate has no
 * such coordinate: its document is a node tree whose text never contains the
 * syntax characters. This module translates between the two in the only way
 * that survives round-trip normalization — by counting reader-visible
 * characters inside the top-level block that owns the offset.
 *
 * Both coordinates are ordinals the candidate can resolve on its own side:
 * `blockIndex` is the nth top-level block, `textOffset` is a character count
 * into that block's rendered text. Neither depends on the syntax the candidate
 * chose to write.
 */
import { GFM, parser } from '@lezer/markdown';

import { markdownBlockRanges } from './markdownStructure';

export interface ResolvedSourcePosition {
  /** Index of the top-level block that owns the offset. */
  blockIndex: number;
  /** Reader-visible characters between the block's start and the offset. */
  textOffset: number;
}

const markdownParser = parser.configure(GFM);

/**
 * Node names whose source text a reader never sees. `/Mark$/` covers the
 * generated marker nodes (`EmphasisMark`, `ListMark`, `HeaderMark`, …); the
 * explicit set is for the ones lezer-markdown does not name that way.
 */
const INVISIBLE_NODE = new Set([
  'URL',
  'LinkTitle',
  'CodeInfo',
  'TableDelimiter',
  'TaskMarker',
  'CommentBlock',
  'ProcessingInstructionBlock',
]);

function isInvisible(name: string): boolean {
  return name.endsWith('Mark') || INVISIBLE_NODE.has(name);
}

/**
 * Ranges of `source` that carry syntax rather than text, flattened and merged.
 * A marker inside another marker is counted once.
 */
function invisibleRanges(source: string): Array<{ from: number; to: number }> {
  const tree = markdownParser.parse(source);
  const ranges: Array<{ from: number; to: number }> = [];
  const cursor = tree.cursor();
  do {
    if (isInvisible(cursor.name)) ranges.push({ from: cursor.from, to: cursor.to });
  } while (cursor.next());
  ranges.sort((left, right) => left.from - right.from);

  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  for (const range of merged) {
    if (startsTheLine(source, merged, range.from)) range.to = withMarkerPadding(source, range.to);
  }
  return merged;
}

/**
 * Whether only whitespace and other markers precede `from` on its line — i.e.
 * this is a BLOCK marker. An inline closer such as the second `**` of
 * `A **bold** word.` must not swallow the space that follows it.
 */
function startsTheLine(
  source: string,
  merged: Array<{ from: number; to: number }>,
  from: number,
): boolean {
  const lineStart = source.lastIndexOf('\n', from - 1) + 1;
  for (let index = lineStart; index < from; index += 1) {
    if (source[index] === ' ' || source[index] === '\t') continue;
    if (merged.some((range) => index >= range.from && index < range.to)) continue;
    return false;
  }
  return true;
}

/**
 * A block marker owns the whitespace that separates it from its content: the
 * space in `# Heading`, and the newline that ends a fence's info string. lezer
 * leaves both outside the marker node, and a reader sees neither.
 */
function withMarkerPadding(source: string, to: number): number {
  let end = to;
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
  if (source[end] === '\n') end += 1;
  return end;
}

/** Visible characters in `source` between `from` and `to`. */
function visibleLength(
  source: string,
  invisible: Array<{ from: number; to: number }>,
  from: number,
  to: number,
): number {
  let hidden = 0;
  for (const range of invisible) {
    if (range.to <= from) continue;
    if (range.from >= to) break;
    hidden += Math.min(range.to, to) - Math.max(range.from, from);
  }
  return Math.max(0, to - from - hidden);
}

export function resolveSourceOffset(source: string, offset: number): ResolvedSourcePosition {
  const blocks = markdownBlockRanges(source);
  if (blocks.length === 0) return { blockIndex: 0, textOffset: 0 };

  const clamped = Math.max(0, Math.min(offset, source.length));
  // The last block that starts at or before the offset. An offset in the blank
  // space between two blocks belongs to the one it follows, which is where a
  // caret walk over `block.to` lands.
  let blockIndex = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index]!.from <= clamped) blockIndex = index;
    else break;
  }

  const block = blocks[blockIndex]!;
  const invisible = invisibleRanges(source);
  return {
    blockIndex,
    textOffset: visibleLength(source, invisible, block.from, Math.min(clamped, block.to)),
  };
}

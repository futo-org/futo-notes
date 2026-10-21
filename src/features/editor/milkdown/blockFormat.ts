import type { ResolvedPos } from '@milkdown/kit/prose/model';

/**
 * The block kinds a single line can be, plus
 * `code` for the one block whose lines can carry NO markdown prefix at all.
 */
export type BlockKind = 'none' | 'bullet' | 'ordered' | 'task' | 'heading' | 'quote' | 'code';

export interface BlockFormat {
  kind: BlockKind;
  /** Heading level, 1-3. Only meaningful for `kind: 'heading'`. */
  level?: number;
}

const LIST_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(['bullet', 'ordered', 'task']);

export function isListKind(kind: BlockKind): boolean {
  return LIST_KINDS.has(kind);
}

export function sameFormat(a: BlockFormat, b: BlockFormat): boolean {
  return a.kind === b.kind && (a.level ?? 0) === (b.level ?? 0);
}

/** The depth of the innermost ancestor of `at` named `name`, or 0 for none. */
export function ancestorDepth(at: ResolvedPos, name: string): number {
  for (let depth = at.depth; depth > 0; depth -= 1) {
    if (at.node(depth).type.name === name) return depth;
  }
  return 0;
}

/**
 * Whether the textblock containing `at` is a code block.
 *
 * `spec.code` rather than the node NAME, because that flag is the schema's own
 * statement that the node's content is literal text — the property this module
 * actually depends on (the commonmark preset sets it on `code_block`, alongside
 * `marks: ''`).
 */
export function isCodeTextblock(at: ResolvedPos): boolean {
  for (let depth = at.depth; depth >= 0; depth -= 1) {
    const node = at.node(depth);
    if (node.isTextblock) return node.type.spec.code === true;
  }
  return false;
}

/**
 * The block kind at `at`, innermost structure first.
 *
 * List membership takes precedence over the textblock format when converting lists.
 */
export function blockFormatAtPos(at: ResolvedPos): BlockFormat {
  // A code block is read BEFORE any wrapper, because the caret's own textblock
  // is the innermost structure there is: a fence indented under a list item is
  // code, not the bullet the list item would otherwise report.
  if (isCodeTextblock(at)) return { kind: 'code' };

  const itemDepth = ancestorDepth(at, 'list_item');
  if (itemDepth > 0) {
    const item = at.node(itemDepth);
    if (item.attrs.checked !== null && item.attrs.checked !== undefined) return { kind: 'task' };
    const list = itemDepth > 1 ? at.node(itemDepth - 1) : null;
    return { kind: list?.type.name === 'ordered_list' ? 'ordered' : 'bullet' };
  }

  const block = at.node(at.depth);
  if (block.type.name === 'heading') {
    return { kind: 'heading', level: Number(block.attrs.level ?? 1) };
  }

  return ancestorDepth(at, 'blockquote') > 0 ? { kind: 'quote' } : { kind: 'none' };
}

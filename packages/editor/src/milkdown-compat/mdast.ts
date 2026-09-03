/**
 * The slice of mdast this package's compat transforms actually touch.
 *
 * Deliberately structural rather than an `mdast` type import: `@types/mdast`
 * reaches this workspace only as a transitive dependency of Milkdown's own
 * remark stack, and the fields below are the whole surface the transforms read
 * or write. It is kept assignable FROM the real `Root`, so a remark transformer
 * typed against it needs no cast — `pnpm run check:svelte` resolves the real
 * mdast types and will say so if that stops being true.
 */
export interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  data?: { isInline?: boolean };
  /** Source lines (1-based), as mdast-util-from-markdown records them. */
  position?: { start: { line: number }; end: { line: number } };
}

/** Depth-first walk that hands each node its immediate parent. */
export function walk(
  node: MdastNode,
  visit: (node: MdastNode, parent: MdastNode | null) => void,
  parent: MdastNode | null = null,
): void {
  visit(node, parent);
  const children = node.children;
  if (!children) return;
  // Iterate a copy: `visit` is allowed to splice the live children array.
  for (const child of children.slice()) walk(child, visit, node);
}

/*
 * Small reads of the document structure AROUND the caret, shared by the
 * toolbar commands (`toolbarExec.ts`), the native toolbar's active-state
 * (`formatState.ts`) and the editor component itself.
 *
 * They all walk `$from`'s ancestors rather than looking at the DOM: the DOM is
 * a projection ProseMirror may re-render at any time, the node tree is what the
 * commands actually act on.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

/**
 * A GFM task-list item. Milkdown models it as an ordinary `list_item` carrying
 * a non-null `checked` attribute — a plain bullet item has `checked: null`.
 */
export function isTaskItem(node: ProseNode): boolean {
  return (
    node.type.name === 'list_item' &&
    node.attrs.checked !== null &&
    node.attrs.checked !== undefined
  );
}

/** The innermost `list_item` containing the caret, with its position. */
export function enclosingListItem(view: ProseView): { node: ProseNode; pos: number } | null {
  // `$from` would be the natural ProseMirror name, but Svelte reserves the `$`
  // prefix in the component that consumes this.
  const at = view.state.doc.resolve(view.state.selection.from);
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name === 'list_item') return { node, pos: at.before(depth) };
  }
  return null;
}

/** The heading level at the caret, or 0 when the caret is not in a heading. */
export function currentHeadingLevel(view: ProseView): number {
  const at = view.state.doc.resolve(view.state.selection.from);
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name === 'heading') return Number(node.attrs.level ?? 0);
  }
  return 0;
}

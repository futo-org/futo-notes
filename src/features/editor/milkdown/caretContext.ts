/*
 * Small reads of the document structure AROUND the caret, shared by the
 * toolbar commands (`toolbarExec.ts`), the native toolbar's active-state
 * (`formatState.ts`) and the editor component itself.
 *
 * They all walk `$from`'s ancestors rather than looking at the DOM: the DOM is
 * a projection ProseMirror may re-render at any time, the node tree is what the
 * commands actually act on.
 */
import { editorViewCtx, type Editor } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

/**
 * The live ProseMirror view, or null before the editor finishes building (and
 * after it is destroyed) — `ctx.get` throws for a slice that is not there yet,
 * which every caller here treats as "no view".
 */
export function editorView(editor: Editor | null): ProseView | null {
  if (!editor) return null;
  try {
    return editor.ctx.get(editorViewCtx);
  } catch {
    return null;
  }
}

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

/**
 * The innermost `list_item` containing `selection`, with its position.
 *
 * Walks the selection's OWN resolved position rather than re-resolving one
 * against `view.state.doc`, for the reason `formatState.ts` spells out:
 * Milkdown's `selectionUpdated` listener runs from inside
 * `EditorState.apply(tr)`, so `view.state` there is a whole transaction behind
 * — and after a doc-changing transaction its doc is behind too, which makes
 * re-resolving actively wrong rather than merely stale.
 */
export function enclosingListItem(
  selection: ProseSelection,
): { node: ProseNode; pos: number } | null {
  // `$from` would be the natural ProseMirror name, but Svelte reserves the `$`
  // prefix in the component that consumes this.
  const at = selection.$from;
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name === 'list_item') return { node, pos: at.before(depth) };
  }
  return null;
}

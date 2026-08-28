/*
 * Which toolbar-manifest commands are ACTIVE at the caret.
 *
 * Drives the Notion-style highlight on the native keyboard toolbar (bridge
 * `formatState` — see packages/editor/src/bridge.ts). Kept out of the editor
 * component because it is pure document logic: given a selection it answers
 * with toolbar ids, with no DOM and no editor lifecycle involved.
 */
import type { Mark as ProseMark } from '@milkdown/kit/prose/model';
import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { isTaskItem } from './caretContext';

/**
 * Whether `markName` is active for `selection` on `view`'s doc: for an empty
 * selection, the marks that would apply to text typed next (`storedMarks` when
 * given, falling back to the resolved position's own marks); for a range,
 * whether the mark occurs ANYWHERE in it.
 *
 * "Anywhere" rather than "everywhere" on purpose — it has to agree with what
 * the button will DO. prosemirror-commands' `toggleMark`, which every mark
 * command here wraps, also branches on `doc.rangeHasMark`: a selection that is
 * partly bold toggles OFF. Reporting it inactive would light the button up
 * only after the tap that removed the formatting.
 *
 * `storedMarks` is threaded in rather than read off `view.state` because the
 * caller may be reporting a NEWER selection than `view.state` reflects (see
 * `computeActiveFormats`).
 */
function markActive(
  /** Only the schema is read from the view; the document comes from `selection`. */
  view: ProseView,
  selection: ProseSelection,
  storedMarks: readonly ProseMark[] | null,
  markName: string,
): boolean {
  const markType = view.state.schema.marks[markName];
  if (!markType) return false;
  const { from, to, empty } = selection;
  if (empty) {
    const marks = storedMarks ?? selection.$from.marks();
    return markType.isInSet(marks) !== undefined;
  }
  // The SELECTION's own document, never `view.state.doc`. When `selection` is
  // newer than `view.state` (see this module's doc comment) and the
  // transaction changed the document too — a toolbar block command over a
  // multi-block selection does exactly that — `from`/`to` index the new
  // document while `view.state.doc` is still the old one. That read is wrong
  // whenever the two differ, and throws outright once the range runs past the
  // end of the old document. A resolved position carries the document it was
  // resolved against, so this is always the right one.
  return selection.$from.doc.rangeHasMark(from, to, markType);
}

/**
 * The toolbar-manifest ids (`TOOLBAR_EXEC_IDS` in packages/editor/src/toolbar.ts)
 * that cover `selection`.
 *
 * Node checks walk `selection.$from`'s ancestors, resolved against the
 * SELECTION PASSED IN rather than `view.state.selection` — Milkdown's
 * `selectionUpdated` listener runs from inside `EditorState.apply(tr)`, before
 * the view has adopted the new state, so `view.state.selection` there still
 * reports where the caret USED to be.
 *
 * A task-list item is schema-nested inside a bullet_list, so it reports
 * `'task-list'` and deliberately NOT `'bullet-list'` — otherwise both toolbar
 * buttons would light up together.
 */
export function computeActiveFormats(
  view: ProseView,
  selection: ProseSelection,
  storedMarks: readonly ProseMark[] | null,
): string[] {
  const active = new Set<string>();

  if (markActive(view, selection, storedMarks, 'strong')) active.add('bold');
  if (markActive(view, selection, storedMarks, 'emphasis')) active.add('italic');
  if (markActive(view, selection, storedMarks, 'strike_through')) active.add('strikethrough');
  if (markActive(view, selection, storedMarks, 'link')) active.add('link');

  const at = selection.$from;
  let inHeading = false;
  let inBlockquote = false;
  let inBulletList = false;
  let inOrderedList = false;
  let inTaskItem = false;
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name === 'heading') inHeading = true;
    else if (node.type.name === 'blockquote') inBlockquote = true;
    else if (node.type.name === 'bullet_list') inBulletList = true;
    else if (node.type.name === 'ordered_list') inOrderedList = true;
    else if (node.type.name === 'list_item' && isTaskItem(node)) inTaskItem = true;
  }
  if (inHeading) active.add('heading');
  if (inBlockquote) active.add('quote');
  if (inOrderedList) active.add('ordered-list');
  if (inTaskItem) active.add('task-list');
  else if (inBulletList) active.add('bullet-list');

  return Array.from(active);
}

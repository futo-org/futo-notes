/*
 * Which toolbar-manifest commands are ACTIVE at the caret, and which are
 * DISABLED outright.
 *
 * Drives the Notion-style highlight (and the Undo/Redo grey-out) on the
 * native keyboard toolbar (bridge `formatState` — see
 * packages/editor/src/bridge.ts). Kept out of the editor component because it
 * is pure document logic: given a view/selection it answers with toolbar ids,
 * with no DOM and no editor lifecycle involved.
 */
import type { Mark as ProseMark } from '@milkdown/kit/prose/model';
import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
import { redoDepth, undoDepth } from '@milkdown/kit/prose/history';
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
  /* The SELECTION's own document, never `view.state.doc`.
   *
   * `view.state` may be one transaction behind `selection` (see
   * `computeActiveFormats`). For a pure selection move that is harmless — same
   * doc — but a transaction that ALSO changes the document leaves `from`/`to`
   * indexing the new one while `view.state.doc` is still the old: the marks
   * read back are then simply the wrong document's, and once the range runs
   * past the end of the old doc `rangeHasMark` THROWS rather than returning
   * false. Both paths are real. Progressive open appending content behind the
   * caret crashed the editor on 78 of the 31k corpus notes here, and a toolbar
   * block command over a multi-block selection does the same thing.
   *
   * A resolved position carries the document it was resolved against, so this
   * is by construction the document those positions belong to — in range, and
   * holding the marks the caller is actually asking about. */
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
  let headingLevel: number | null = null;
  let inBlockquote = false;
  let inBulletList = false;
  let inOrderedList = false;
  let inTaskItem = false;
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (node.type.name === 'heading') headingLevel = Number(node.attrs.level);
    else if (node.type.name === 'blockquote') inBlockquote = true;
    else if (node.type.name === 'bullet_list') inBulletList = true;
    else if (node.type.name === 'ordered_list') inOrderedList = true;
    else if (node.type.name === 'list_item' && isTaskItem(node)) inTaskItem = true;
  }
  if (headingLevel !== null) active.add(`heading-${headingLevel}`);
  if (inBlockquote) active.add('quote');
  if (inOrderedList) active.add('ordered-list');
  if (inTaskItem) active.add('task-list');
  else if (inBulletList) active.add('bullet-list');

  return Array.from(active);
}

/**
 * The toolbar-manifest ids that are currently INERT — `'undo'`/`'redo'` when
 * prosemirror-history's own depth counters say there is nothing to undo/redo.
 * Not selection-dependent (unlike {@link computeActiveFormats}), so this only
 * needs the view, and reads `view.state` directly: every caller emits this
 * alongside `active` on the same triggers, and the one caller where
 * `view.state` can be a transaction stale (`selectionUpdated`, mid-`apply`)
 * self-corrects within one debounced change notification — the same
 * tolerance `formatState` already accepts for that path.
 */
export function computeDisabledFormats(view: ProseView): string[] {
  const disabled: string[] = [];
  if (undoDepth(view.state) === 0) disabled.push('undo');
  if (redoDepth(view.state) === 0) disabled.push('redo');
  return disabled;
}

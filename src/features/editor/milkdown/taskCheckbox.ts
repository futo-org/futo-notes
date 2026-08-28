/*
 * Task-list checkboxes for the Milkdown editor.
 *
 * A GFM task item is an ordinary `list_item` carrying a non-null `checked`
 * attribute (see caretContext.ts `isTaskItem`), and nothing in Milkdown's
 * presets draws it. This paints one widget per task item and owns the toggle.
 *
 * The contract is the CodeMirror editor's, because it is the one
 * docs/spec/editor.md describes and the one users already have: a real
 * `<input type="checkbox">` inside a font-independent {@link CHECKBOX_SIZE_PX}
 * tap target, `mousedown` defaultPrevented so tapping it neither moves the
 * caret nor raises the phone keyboard ("no cursor placement needed"), and the
 * toggle rewriting `[ ]`/`[x]` through a normal transaction — so it is one undo
 * step and it reaches the host's autosave like any other edit.
 *
 * Why a widget rather than the `::before` glyph it replaces: a CSS glyph is
 * about one em wide (17px here), well under the 44pt/48dp minimum, and a tap on
 * it focuses the editor before the click handler ever runs.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import {
  changedRanges,
  decorateAllBlocks,
  repaintBlocks,
  type PositionedBlock,
} from './blockDecorations';
import { isTaskItem } from './caretContext';

/**
 * Tap-target edge, in CSS pixels rather than `em`: the point of a minimum tap
 * target is that it does NOT shrink with the editor's font size. Matches the
 * CodeMirror editor's `CHECKBOX_SLOT`.
 */
export const CHECKBOX_SIZE_PX = 28;

export const TASK_CHECKBOX_CLASS = 'futo-task-checkbox';

export const taskCheckboxKey = new PluginKey<DecorationSet>('FUTO_TASK_CHECKBOX');

/**
 * Where a task item's checkbox goes: just inside the item's first textblock, so
 * it rides with that line. An item whose first child is not a textblock (a bare
 * nested list) gets it just inside the item itself.
 */
function checkboxPos(item: ProseNode, itemPos: number): number {
  const first = item.firstChild;
  return first?.isTextblock ? itemPos + 2 : itemPos + 1;
}

/**
 * The `list_item` that encloses `pos`, with its position — resolved at CLICK
 * time from the widget's live position, never from a position captured when the
 * widget was built.
 */
function taskItemAt(view: ProseView, pos: number): { node: ProseNode; pos: number } | null {
  const at = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
  for (let depth = at.depth; depth > 0; depth -= 1) {
    const node = at.node(depth);
    if (isTaskItem(node)) return { node, pos: at.before(depth) };
  }
  return null;
}

/** Flip one task item's `checked` attribute. */
export function toggleTaskItem(view: ProseView, pos: number): boolean {
  const item = taskItemAt(view, pos);
  if (!item) return false;
  view.dispatch(
    view.state.tr.setNodeMarkup(item.pos, undefined, {
      ...item.node.attrs,
      checked: !item.node.attrs.checked,
    }),
  );
  return true;
}

function renderCheckbox(checked: boolean, view: ProseView, getPos: () => number | undefined) {
  const wrapper = document.createElement('span');
  wrapper.className = TASK_CHECKBOX_CLASS;
  wrapper.contentEditable = 'false';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  // Not a tab stop: Tab in a list is the toolbar's indent, and a checkbox that
  // steals it would break that before the user ever reached the box.
  input.tabIndex = -1;
  wrapper.appendChild(input);

  // The one line that keeps the phone keyboard down: the browser focuses the
  // editable and places a caret on mousedown, long before click fires.
  wrapper.addEventListener('mousedown', (event) => event.preventDefault());
  wrapper.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const pos = getPos();
    if (pos !== undefined) toggleTaskItem(view, pos);
  });

  return wrapper;
}

/** Every task item in `[from, to]`, with its position. */
export function taskItemsIn(doc: ProseNode, from: number, to: number): PositionedBlock[] {
  const out: PositionedBlock[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    // Keep descending: a task list nests inside its parent item.
    if (isTaskItem(node)) out.push({ node, pos });
    return true;
  });
  return out;
}

/** The checkbox widget for one task item. */
function decorateTaskItem(node: ProseNode, pos: number): Decoration[] {
  const checked = node.attrs.checked === true;
  return [
    Decoration.widget(
      checkboxPos(node, pos),
      (view, getPos) => renderCheckbox(checked, view, getPos),
      {
        // `side: -1` puts it before the item's first character. The key
        // carries the state so ProseMirror redraws the widget when it flips
        // instead of reusing a box with the wrong tick in it.
        side: -1,
        key: `futo-task-${checked}`,
        // Events inside the widget are the widget's, never the document's.
        stopEvent: () => true,
        ignoreSelection: true,
      },
    ),
  ];
}

export function taskCheckboxDecorations(doc: ProseNode): DecorationSet {
  return decorateAllBlocks(doc, taskItemsIn, decorateTaskItem);
}

export function createTaskCheckboxPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: taskCheckboxKey,
    state: {
      init: (_config, state) => taskCheckboxDecorations(state.doc),
      // Rebuilt, not mapped: a widget's rendered state is its item's `checked`
      // attribute, and `setNodeMarkup` changes that WITHOUT moving a single
      // position, so a mapped set would keep showing the old tick. Rebuilt only
      // for the items the transaction's own steps touched, though — the toggle
      // step's range covers the item it retyped, so nothing needs a walk of the
      // whole document (AGENTS.md M5).
      apply: (tr, set) =>
        tr.docChanged
          ? repaintBlocks(
              set.map(tr.mapping, tr.doc),
              tr.doc,
              changedRanges(tr),
              taskItemsIn,
              decorateTaskItem,
            )
          : set,
    },
    props: {
      decorations(state) {
        return taskCheckboxKey.getState(state);
      },
    },
  });
}

/** The Milkdown plugin: `.use(taskCheckbox)`. */
export const taskCheckbox = $prose(() => createTaskCheckboxPlugin());

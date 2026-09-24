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
  expandToBlocks,
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

/**
 * The OUTERMOST task items in `[from, to]`, with their positions — never one
 * inside another.
 *
 * Used for the initial decoration build. The incremental path below rebuilds
 * individual widgets, since rebuilding an outer item would walk every nested
 * task on a keystroke.
 */
export function taskItemsIn(doc: ProseNode, from: number, to: number): PositionedBlock[] {
  const out: PositionedBlock[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!isTaskItem(node)) return true;
    out.push({ node, pos });
    // Stop: anything nested inside belongs to this item, not beside it.
    return false;
  });
  return out;
}

/** One task item's checkbox widget. */
function checkboxFor(node: ProseNode, pos: number): Decoration {
  const checked = node.attrs.checked === true;
  return Decoration.widget(
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
  );
}

/**
 * Checkbox widgets for a task item AND every task item nested inside it — the
 * counterpart to `taskItemsIn` returning only outermost items in the initial
 * whole-document build.
 */
function decorateTaskItem(node: ProseNode, pos: number): Decoration[] {
  const out = [checkboxFor(node, pos)];
  node.descendants((child, offset) => {
    // `offset` is relative to the start of this item's CONTENT, so the child
    // sits at `pos + 1 + offset` in the document.
    if (isTaskItem(child)) out.push(checkboxFor(child, pos + 1 + offset));
    return true;
  });
  return out;
}

export function taskCheckboxDecorations(doc: ProseNode): DecorationSet {
  return decorateAllBlocks(doc, taskItemsIn, decorateTaskItem);
}

function repaintTaskCheckboxes(
  set: DecorationSet,
  doc: ProseNode,
  ranges: Array<[number, number]>,
): DecorationSet {
  let next = set;
  const rebuild = new Map<number, ProseNode>();
  for (const [from, to] of ranges) {
    const [start, end] = expandToBlocks(doc, from, to);
    // Clear widgets left at a former item position after a lift or deletion.
    next = next.remove(
      next.find(start, end).filter((widget) => widget.from >= start && widget.to <= end),
    );
    doc.nodesBetween(start, end, (node, pos) => {
      if (node.type.name !== 'list_item') return true;
      const checkbox = checkboxPos(node, pos);
      const openingChanged = from <= pos + 1 && to >= pos;
      const closingChanged = from <= pos + node.nodeSize && to >= pos + node.nodeSize - 1;
      if ((checkbox >= start && checkbox <= end) || openingChanged || closingChanged) {
        rebuild.set(pos, node);
      }
      return true;
    });
  }
  for (const [pos, node] of rebuild) {
    const checkbox = checkboxPos(node, pos);
    next = next.remove(
      next
        .find(checkbox, checkbox)
        .filter((widget) => widget.from === checkbox && widget.to === checkbox),
    );
    if (isTaskItem(node)) next = next.add(doc, [checkboxFor(node, pos)]);
  }
  return next;
}

export function createTaskCheckboxPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: taskCheckboxKey,
    state: {
      init: (_config, state) => taskCheckboxDecorations(state.doc),
      // Map existing widgets, then rebuild only the changed item's widget.
      // `setNodeMarkup` can change checked state without moving a position,
      // so mapping alone would leave the old tick visible (AGENTS.md M5).
      apply: (tr, set) =>
        tr.docChanged
          ? repaintTaskCheckboxes(set.map(tr.mapping, tr.doc), tr.doc, changedRanges(tr))
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

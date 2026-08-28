// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { Decoration, DecorationSet, EditorView as ProseView } from '@milkdown/kit/prose/view';

import { changedRanges } from './blockDecorations';
import {
  CHECKBOX_SIZE_PX,
  createTaskCheckboxPlugin,
  TASK_CHECKBOX_CLASS,
  taskCheckboxDecorations,
  taskCheckboxKey,
  taskItemsIn,
  toggleTaskItem,
} from './taskCheckbox';
import { testSchema as s } from './__fixtures__/schema';

function item(checked: boolean | null, text: string): ProseNode {
  return s.nodes.list_item.create({ checked }, s.nodes.paragraph.create(null, s.text(text)));
}

function list(...items: ProseNode[]): ProseNode {
  return s.nodes.bullet_list.create(null, items);
}

function doc(...blocks: ProseNode[]): ProseNode {
  return s.nodes.doc.create(null, blocks);
}

/** A stub view: everything under test reads `state` and calls `dispatch`. */
function stubView(d: ProseNode) {
  const dispatched: Transaction[] = [];
  let state = EditorState.create({ doc: d, plugins: [createTaskCheckboxPlugin()] });
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: Transaction) => {
      dispatched.push(tr);
      state = state.apply(tr);
    },
    isDestroyed: false,
  } as unknown as ProseView;
  return {
    view,
    dispatched,
    get state() {
      return state;
    },
  };
}

function checkedFlags(d: ProseNode): Array<boolean | null> {
  const out: Array<boolean | null> = [];
  d.descendants((node) => {
    if (node.type.name === 'list_item') out.push(node.attrs.checked as boolean | null);
    return true;
  });
  return out;
}

describe('taskCheckboxDecorations', () => {
  it('gives every task item one widget, and a plain bullet none', () => {
    const d = doc(list(item(false, 'todo'), item(true, 'done'), item(null, 'plain')));
    expect(taskCheckboxDecorations(d).find()).toHaveLength(2);
  });

  it('puts the widget inside the item, before its first character', () => {
    const d = doc(list(item(false, 'todo')));
    const [widget] = taskCheckboxDecorations(d).find();
    // list at 0, item at 1, paragraph at 2, first character at 3.
    expect(widget.from).toBe(3);
  });

  it('keys the widget on the checked state, so a toggle redraws it', () => {
    const keyOf = (d: ProseNode) =>
      (taskCheckboxDecorations(d).find()[0] as Decoration & { type: { spec: { key: string } } })
        .type.spec.key;
    expect(keyOf(doc(list(item(false, 'x'))))).not.toBe(keyOf(doc(list(item(true, 'x')))));
  });

  it('gives a task item nested inside another one its own widget', () => {
    const parent = s.nodes.list_item.create({ checked: false }, [
      s.nodes.paragraph.create(null, s.text('parent')),
      s.nodes.bullet_list.create(null, item(true, 'child')),
    ]);
    expect(taskCheckboxDecorations(doc(list(parent))).find()).toHaveLength(2);
  });

  it('reports only the OUTERMOST task item, so no block contains another', () => {
    // repaintBlocks clears a block's whole range; overlapping blocks would make
    // the parent's rebuild delete the child's checkbox (see blockDecorations).
    const parent = s.nodes.list_item.create({ checked: false }, [
      s.nodes.paragraph.create(null, s.text('parent')),
      s.nodes.bullet_list.create(null, item(true, 'child')),
    ]);
    const d = doc(list(parent));
    const found = taskItemsIn(d, 0, d.content.size);
    expect(found).toHaveLength(1);
    expect(found[0].node.textContent).toContain('parent');
  });
});

describe('the rendered checkbox', () => {
  function render(d: ProseNode): HTMLElement {
    const { view } = stubView(d);
    const [widget] = taskCheckboxDecorations(d).find();
    const toDOM = (widget.type as unknown as { toDOM: unknown }).toDOM;
    const build = typeof toDOM === 'function' ? toDOM : () => toDOM;
    return (build as (v: ProseView, getPos: () => number) => HTMLElement)(view, () => widget.from);
  }

  it('is a real checkbox input reflecting the item state', () => {
    const on = render(doc(list(item(true, 'done')))).querySelector('input');
    const off = render(doc(list(item(false, 'todo')))).querySelector('input');
    expect(on?.type).toBe('checkbox');
    expect(on?.checked).toBe(true);
    expect(off?.checked).toBe(false);
  });

  it('is not a tab stop', () => {
    expect(render(doc(list(item(false, 'todo')))).querySelector('input')?.tabIndex).toBe(-1);
  });

  it('is not editable, so the caret cannot land in it', () => {
    expect(render(doc(list(item(false, 'todo')))).contentEditable).toBe('false');
  });

  it('carries the class the stylesheet sizes to the tap target', () => {
    expect(render(doc(list(item(false, 'todo')))).className).toBe(TASK_CHECKBOX_CLASS);
    // The size itself is a CSS custom property set from this constant; the
    // rendered pixels are asserted against the real bundle in
    // tests/editor-embed-milkdown.spec.ts.
    expect(CHECKBOX_SIZE_PX).toBeGreaterThanOrEqual(28);
  });

  it('cancels mousedown, which is what stops the caret and the phone keyboard', () => {
    const wrapper = render(doc(list(item(false, 'todo'))));
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    wrapper.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('toggles the item on click, and stops the click reaching the document', () => {
    const d = doc(list(item(false, 'todo')));
    const { view, dispatched } = stubView(d);
    const [widget] = taskCheckboxDecorations(d).find();
    const toDOM = (widget.type as unknown as { toDOM: unknown }).toDOM as (
      v: ProseView,
      getPos: () => number,
    ) => HTMLElement;
    const wrapper = toDOM(view, () => widget.from);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    wrapper.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(checkedFlags(dispatched[0].doc)).toEqual([true]);
  });
});

describe('toggleTaskItem', () => {
  it('flips an unchecked item', () => {
    const { view, dispatched } = stubView(doc(list(item(false, 'todo'))));
    expect(toggleTaskItem(view, 3)).toBe(true);
    expect(checkedFlags(dispatched[0].doc)).toEqual([true]);
  });

  it('flips a checked item back', () => {
    const { view, dispatched } = stubView(doc(list(item(true, 'done'))));
    toggleTaskItem(view, 3);
    expect(checkedFlags(dispatched[0].doc)).toEqual([false]);
  });

  it('touches only the item asked about', () => {
    const d = doc(list(item(false, 'one'), item(false, 'two')));
    const { view, dispatched } = stubView(d);
    const second = 1 + d.firstChild!.firstChild!.nodeSize + 2;
    toggleTaskItem(view, second);
    expect(checkedFlags(dispatched[0].doc)).toEqual([false, true]);
  });

  it('is one undoable step, not a document rewrite', () => {
    const { view, dispatched } = stubView(doc(list(item(false, 'todo'))));
    toggleTaskItem(view, 3);
    expect(dispatched[0].steps).toHaveLength(1);
  });

  it('refuses a position that is not in a task item', () => {
    const { view, dispatched } = stubView(doc(list(item(null, 'plain'))));
    expect(toggleTaskItem(view, 3)).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it('survives a position past the end of the document', () => {
    const { view } = stubView(doc(list(item(false, 'todo'))));
    expect(toggleTaskItem(view, 9_999)).toBe(false);
  });
});

describe('the plugin', () => {
  function decorationsOf(state: EditorState): DecorationSet {
    const set = taskCheckboxKey.getState(state);
    if (!set) throw new Error('plugin state missing');
    return set;
  }

  it('redraws after a toggle, even though no position moved', () => {
    // `setNodeMarkup` changes an attribute without moving a single position,
    // so a decoration set that was merely MAPPED would keep the old tick.
    const keyOf = (state: EditorState) =>
      (decorationsOf(state).find()[0] as { type: { spec: { key: string } } }).type.spec.key;
    const app = stubView(doc(list(item(false, 'todo'))));
    const before = keyOf(app.state);
    toggleTaskItem(app.view, 3);
    expect(keyOf(app.state)).not.toBe(before);
  });

  it('rebuilds one item per keystroke, whatever the document size', () => {
    // The M5 assertion. A toggle retypes ONE node, and typing in an item's text
    // touches only that item, so neither costs a walk of the document — the
    // shape this diff rejected two published highlight plugins for.
    const items = Array.from({ length: 500 }, (_, i) => item(false, `task ${i}`));
    const d = doc(list(...items));
    const state = EditorState.create({ doc: d, plugins: [createTaskCheckboxPlugin()] });
    const middle = state.doc.resolve(Math.floor(d.content.size / 2)).start();

    // Distinct items: `setNodeMarkup` is one step with two map ranges (the
    // node's open and close), so the same item is reported by both — rebuilding
    // it twice is wasted work, never wrong work.
    const touched = (tr: Transaction) =>
      new Set(changedRanges(tr).flatMap(([f, t]) => taskItemsIn(tr.doc, f, t).map((i) => i.pos)));

    expect(touched(state.tr.insertText('!', middle)).size).toBe(1);

    const last = taskItemsIn(d, 0, d.content.size)[499];
    expect(touched(state.tr.setNodeMarkup(last.pos, undefined, { checked: true })).size).toBe(1);

    expect(taskItemsIn(d, 0, d.content.size)).toHaveLength(500);
  });

  it("keeps a nested task item's checkbox when the parent item is edited", () => {
    // A task item's range CONTAINS any task item nested inside it, and
    // repaintBlocks clears a block's whole range before rebuilding it — so a
    // child whose own position is outside the edited range is cleared and
    // never re-added. Same class as the abutting-fence bug, one level down.
    const child = s.nodes.bullet_list.create(null, item(false, 'child'));
    const parent = s.nodes.list_item.create({ checked: false }, [
      s.nodes.paragraph.create(null, s.text('parent')),
      child,
    ]);
    let state = EditorState.create({
      doc: doc(s.nodes.bullet_list.create(null, parent)),
      plugins: [createTaskCheckboxPlugin()],
    });
    expect(decorationsOf(state).find()).toHaveLength(2);

    // Type in the PARENT's own paragraph — the child is untouched by the edit.
    state = state.apply(state.tr.insertText('!', 4));

    expect(decorationsOf(state).find()).toHaveLength(2);
  });

  it('adds a widget when an edit turns a bullet into a task', () => {
    let state = EditorState.create({
      doc: doc(list(item(null, 'plain'))),
      plugins: [createTaskCheckboxPlugin()],
    });
    expect(decorationsOf(state).find()).toHaveLength(0);
    state = state.apply(state.tr.setNodeMarkup(1, undefined, { checked: false }));
    expect(decorationsOf(state).find()).toHaveLength(1);
  });
});

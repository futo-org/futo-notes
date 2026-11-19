// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { EditorView } from './view';
import { Engine } from './engine';
import { loadEngineBuild } from './__test__/loadEngineBuild';
import type { TableGripsState } from './tableGrips';
import { TableLayouts } from './tableLayouts';
import { drawnLineDrift } from './lineDrift';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TABLE = 'above\n| a | b |\n|---|---|\n| c | d |\n| e | f |\nbelow';

async function openTable(source = TABLE): Promise<{
  view: EditorView;
  engine: Engine;
  grips: () => TableGripsState | null;
}> {
  await loadEngineBuild();
  // jsdom lays nothing out: a range measures no boxes.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  let grips: TableGripsState | null = null;
  const wrap = document.createElement('div');
  document.body.replaceChildren(wrap);
  const view = new EditorView(wrap, {
    edited() {},
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
    openLink() {},
    noteId: () => null,
    tableGrips: (state) => (grips = state),
  });
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  view.open(engine);
  // jsdom focuses no contenteditable element, only one with a tab index.
  view.dom.tabIndex = 0;
  view.focus();
  return { view, engine, grips: () => grips };
}

function caretAt(view: EditorView, text: string, after = 0): number {
  const at = view.currentEngine()!.draftText().indexOf(text) + after;
  view.selection.selectRange(at, at);
  return at;
}

/** Move the pointer over the cell that holds `text`, as a mouse does: no button held. */
function hoverCell(view: EditorView, text: string): void {
  const cell = [...view.dom.querySelectorAll('.table-cell')].find(
    (element) => element.textContent?.trim() === text,
  );
  cell!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
}

it('runs a grip menu item as the engine’s command on the hovered cell, one Undo step, the caret where the engine puts it', async () => {
  const { view, engine } = await openTable();
  caretAt(view, 'c');
  hoverCell(view, 'c');
  view.tables.run('InsertRowBelow');
  expect(engine.draftText()).toBe(
    'above\n| a | b |\n|---|---|\n| c | d |\n|  |  |\n| e | f |\nbelow',
  );
  const c = engine.draftText().indexOf('c');
  expect(view.selection.range()).toEqual({ start: c, end: c });
  view.run((current) => current.undo());
  expect(engine.draftText()).toBe(TABLE);
  // Deleting the hovered column takes the cell to its right.
  caretAt(view, 'c');
  hoverCell(view, 'c');
  view.tables.run('DeleteColumn');
  expect(engine.draftText()).toBe('above\n| b |\n|---|\n| d |\n| f |\nbelow');
  const d = engine.draftText().indexOf('d');
  expect(view.selection.range()!.start).toBeGreaterThanOrEqual(d - 1);
  expect(view.selection.range()!.end).toBeLessThanOrEqual(d + 1);
  view.run((current) => current.undo());
  expect(engine.draftText()).toBe(TABLE);
  view.destroy();
  engine.free();
});

it('reads what a menu allows on the hovered cell from the engine: the header row is neither deleted nor inserted above', async () => {
  const { view, engine } = await openTable();
  caretAt(view, 'above');
  hoverCell(view, 'a');
  expect(view.tables.controls()).toMatchObject({
    insert_row_above: false,
    insert_row_below: true,
    delete_row: false,
    delete_column: true,
  });
  view.dom.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  expect(view.tables.controls()).toBeNull();
  view.destroy();
  engine.free();
});

it('shows the grips for the hovered cell wherever the caret is, until the pointer leaves or an edit', async () => {
  const { view, engine, grips } = await openTable();
  caretAt(view, 'below', 2);
  view.tables.paint();
  expect(grips()).toBeNull();
  hoverCell(view, 'd');
  view.tables.paint();
  expect(grips()).toMatchObject({ row: expect.any(Object) });
  // A selection reaching into the table hides them: the selection toolbar may be where the
  // column's grip goes.
  const at = caretAt(view, 'f');
  view.selection.selectRange(at, at + 1);
  view.tables.paint();
  expect(grips()).toBeNull();
  caretAt(view, 'below', 2);
  view.tables.paint();
  expect(grips()).not.toBeNull();
  view.dom.parentElement!.dispatchEvent(new MouseEvent('mouseleave'));
  view.tables.paint();
  expect(grips()).toBeNull();
  // An edit takes them away until the pointer next moves over a cell.
  hoverCell(view, 'd');
  view.tables.paint();
  expect(grips()).not.toBeNull();
  view.run((current) => current.replace({ start: at, end: at }, 'x', 'Typing'));
  view.tables.paint();
  expect(grips()).toBeNull();
  view.destroy();
  engine.free();
});

it('drops the hovered cell when the note becomes read-only', async () => {
  const { view, engine, grips } = await openTable();
  view.tables.paint();
  hoverCell(view, 'd');
  view.tables.paint();
  expect(grips()).not.toBeNull();
  view.setReadonly(true);
  expect(view.tables.controls()).toBeNull();
  view.tables.run('DeleteRow');
  expect(engine.draftText()).toBe(TABLE);
  view.tables.paint();
  expect(grips()).toBeNull();
  view.setReadonly(false);
  view.tables.paint();
  expect(grips()).toBeNull();
  view.destroy();
  engine.free();
});

it('keeps the hovered cell while a menu pins it', async () => {
  const { view, engine } = await openTable();
  caretAt(view, 'below', 2);
  hoverCell(view, 'c');
  view.tables.pinHoveredCell(true);
  hoverCell(view, 'f');
  view.dom.parentElement!.dispatchEvent(new MouseEvent('mouseleave'));
  view.tables.run('DeleteRow');
  expect(engine.draftText()).toBe('above\n| a | b |\n|---|---|\n| e | f |\nbelow');
  view.destroy();
  engine.free();
});

it('runs a command on the hovered cell with the selection outside the table, the editor focused', async () => {
  const { view, engine } = await openTable();
  caretAt(view, 'below', 2);
  view.dom.blur();
  hoverCell(view, 'd');
  view.tables.run('InsertColumnRight');
  expect(engine.draftText()).toBe(
    'above\n| a | b |  |\n|---|---| --- |\n| c | d |  |\n| e | f |  |\nbelow',
  );
  expect(document.activeElement).toBe(view.dom);
  // The caret leaves its place outside the table for the hovered cell's start, as the engine
  // keeps the cell it was given.
  const d = engine.draftText().indexOf('d');
  expect(view.selection.range()).toEqual({ start: d, end: d });
  view.destroy();
  engine.free();
});

it('moves Shift+Enter in a cell to the cell below, the row kept', async () => {
  const { view, engine } = await openTable();
  caretAt(view, 'c', 1);
  view.dom.dispatchEvent(
    new InputEvent('beforeinput', {
      inputType: 'insertLineBreak',
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(engine.draftText()).toBe(TABLE);
  const e = TABLE.indexOf('| e') + 2;
  expect(view.selection.range()).toEqual({ start: e, end: e + 1 });
  view.destroy();
  engine.free();
});

it('takes Home and End in a row to its first cell’s start and last cell’s end', async () => {
  const { view, engine } = await openTable();
  const at = caretAt(view, 'd');
  const line = view.displayLines()[view.lineAt(at)];
  expect(view.hitTest.rowEdge(at, false, false).offset).toBe(line.start + 1);
  expect(view.hitTest.rowEdge(at, false, true).offset).toBe(line.start + line.text.length - 1);
  view.destroy();
  engine.free();
});

it('scrolls a table sideways only as far as its columns pass the row, whatever its cells hold', async () => {
  const { view, engine } = await openTable('| a | b |\n|---|---|\n| a long cell | d |\nafter');
  const rows = view.lineElements().filter((row) => row.classList.contains('table-row'));
  const widen = (width: number) =>
    rows.forEach((row) =>
      Object.defineProperty(row, 'clientWidth', { value: width, configurable: true }),
    );
  // jsdom lays out no grid: the columns' resolved widths as WebKit computes them.
  let tracks = '200px 200px';
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () => ({ gridTemplateColumns: tracks }) as CSSStyleDeclaration,
  );
  widen(400);
  const layouts = new TableLayouts(
    () => view.lineElements(),
    () => view.displayLines(),
  );
  // Equal shares of the row: no room, however long a cell's text.
  expect(layouts.scrollBy(2, 50)).toBe(false);
  // Six columns at their 80px minimum pass a 400px row by 80px.
  tracks = '80px 80px 80px 80px 80px 80px';
  expect(layouts.scrollBy(2, 500)).toBe(true);
  expect(layouts.scrollAt(0)).toBe(80);
  layouts.apply(0, 3);
  expect(rows.map((row) => row.style.getPropertyValue('--table-scroll'))).toEqual(['80px', '80px']);
  // A wider window brings the scroll back as the rows are written again.
  widen(480);
  layouts.apply(0, 3);
  expect(layouts.scrollAt(2)).toBe(0);
  expect(rows.map((row) => row.style.getPropertyValue('--table-scroll'))).toEqual(['', '']);
  // The layout is the page's: Puppet's drift check reads the rows as their lines draw them.
  vi.restoreAllMocks();
  expect(drawnLineDrift(view.lineElements(), view.displayLines())).toBeNull();
  view.destroy();
  engine.free();
});

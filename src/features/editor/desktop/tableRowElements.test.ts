// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { LineModel } from './lineModel';
import { chunked, drawLine, offsetOf, pointInLine } from './lineElements';
import { atomElementsOf } from './atomElements';
import { emptyCellStopRect, tableColumnParts, tableFillerOf } from './tableRowElements';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

const SOURCE = 'p\n| a | **b** |\n|:--|--:|\n| é \\| x |  |\n| f | g | h\nq';

async function drawnNote(source = SOURCE): Promise<{
  model: LineModel;
  elements: HTMLElement[];
  editor: HTMLElement;
}> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const model = LineModel.from(engine.projectAll());
  engine.free();
  const elements = model.lines.map((line) => {
    const element = document.createElement('div');
    drawLine(element, line);
    return element;
  });
  const editor = document.createElement('div');
  editor.append(...chunked(elements));
  document.body.replaceChildren(editor);
  return { model, elements, editor };
}

const partsOf = (element: HTMLElement): string[] =>
  [...element.children].map((part) => `${part.className}:${part.textContent}`);

it('draws each row as its cells between undrawn pipes, padded to the widest row', async () => {
  const { model, elements } = await drawnNote();
  expect(model.lines.map((line) => line.table?.role ?? null)).toEqual([
    null,
    'header',
    'delimiter',
    'row',
    'row',
    null,
  ]);
  expect(elements[1].className).toBe('line table-row header');
  expect(elements[1].style.getPropertyValue('--table-columns')).toBe('3');
  expect(partsOf(elements[1])).toEqual([
    'table-pipe:|',
    'table-cell: a ',
    'table-pipe:|',
    'table-cell right: b ',
    'table-pipe:|',
    'table-filler:',
  ]);
  // An escaped pipe is a cell's text; an empty cell keeps its padding; a row with no closing
  // pipe ends in its last cell.
  expect(partsOf(elements[3]).filter((part) => !part.startsWith('table-pipe'))).toEqual([
    'table-cell: é | x ',
    'table-cell right:  ',
    'table-filler:',
  ]);
  // A filler stands for the column after the row's cells: the header's lacks the third.
  const filler = tableFillerOf(elements[1].lastChild);
  expect(filler && tableColumnParts(elements[1]).indexOf(filler)).toBe(2);
  expect(partsOf(elements[4]).slice(-1)).toEqual(['table-cell: h']);
  expect(elements[2].className).toBe('line table-delimiter');
  for (const [index, line] of model.lines.entries()) {
    expect(elements[index].textContent).toBe(line.text);
  }
});

/** Every offset of rows `indexes` read back through the DOM point it draws at: a pipe stands at
 *  the end of the cell before it, the row's leading pipe at its first cell's start. */
async function readsBackEveryOffset(source: string, indexes: number[]): Promise<void> {
  const { model, elements, editor } = await drawnNote(source);
  for (const index of indexes) {
    const line = model.lines[index];
    const table = line.table!;
    if (table.role === 'delimiter') throw new Error('a row was expected');
    for (let at = 0; at <= line.text.length; at++) {
      const cell = table.cells.find((span) => span.start <= at && at <= span.end);
      const previous = [...table.cells].reverse().find((span) => span.end <= at);
      const expected = cell ? at : (previous?.end ?? table.cells[0].start);
      const [node, offset] = pointInLine(elements[index], at);
      expect(offsetOf(editor, model, node, offset) - line.start).toBe(expected);
    }
  }
}

it('reads back every offset of a row, a pipe standing at the cell before it', async () => {
  await readsBackEveryOffset(SOURCE, [1, 3, 4]);
  // Empty cells: none, one and two padding spaces.
  await readsBackEveryOffset('| a || |  |\n|---|---|---|---|\n|| x |', [0, 2]);
});

it("finds an image in a cell as its row's atom", async () => {
  const { model, elements } = await drawnNote('| ![i](a.png) | b |\n|---|---|');
  expect(model.lines[0].atoms).toHaveLength(1);
  expect(atomElementsOf(elements[0]).map((atom) => atom.parentElement!.className)).toEqual([
    'table-cell',
  ]);
});

it('stands a caret in a cell that draws no text where its text would start, by its alignment', async () => {
  // Header "| a || c |": its second cell holds nothing. Columns: left, centre, right.
  const { elements } = await drawnNote('| a || c |\n|---|:-:|--:|\n| l |||');
  const cellsOf = (element: HTMLElement): HTMLElement[] =>
    [...element.children].filter((part): part is HTMLElement =>
      part.classList.contains('table-cell'),
    );
  // jsdom lays nothing out: each cell 100px wide from 0, 24px tall, 6px of padding a side.
  for (const element of [elements[0], elements[2]]) {
    cellsOf(element).forEach((cell, column) => {
      cell.getBoundingClientRect = (): DOMRect => new DOMRect(column * 100, 0, 100, 24);
      cell.style.padding = '0 6px';
    });
  }
  const at = (element: HTMLElement, offset: number): number | undefined => {
    const [node] = pointInLine(element, offset);
    return emptyCellStopRect(node)?.left;
  };
  // "| a |" then the empty cell at 5.
  expect(at(elements[0], 5)).toBe(106);
  // A cell with text, and a pipe, are no such stop.
  expect(at(elements[0], 2)).toBeUndefined();
  // "| l |||": the centre column's empty cell at 5, the right column's at 6.
  cellsOf(elements[2])[1].style.textAlign = 'center';
  cellsOf(elements[2])[2].style.textAlign = 'right';
  expect(at(elements[2], 5)).toBe(150);
  expect(at(elements[2], 6)).toBe(294);
});

it("hangs a cell's wrapped rows by its leading padding, redrawn as the padding changes", async () => {
  const padding = (element: HTMLElement): string[] =>
    [...element.children]
      .filter((part) => part.classList.contains('table-cell'))
      .map((cell) => (cell as HTMLElement).style.getPropertyValue('--table-padding'));
  const { elements } = await drawnNote('| a |x|  b |\n|---|---|---|');
  expect(padding(elements[0])).toEqual(['1', '', '2']);
  // Typing a space before "x" draws the same element again with one.
  const { model } = await drawnNote('| a | x|  b |\n|---|---|---|');
  drawLine(elements[0], model.lines[0]);
  expect(padding(elements[0])).toEqual(['1', '1', '2']);
});

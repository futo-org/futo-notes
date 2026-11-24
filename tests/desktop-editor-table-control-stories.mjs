// The desktop editor's table controls (docs/spec/editor/desktop/tables.md, "Row and column
// grips"): with the pointer over a cell, a row grip and a column grip, each a menu of the
// engine's row or column commands on that cell, one Undo step each; Shift+Enter in a cell; and
// the caret in a cell that holds no characters. The caret stays outside the table for the grips,
// so only the pointer can show them. Content comes in
// through Paste. `node tests/desktop-editor-table-control-stories.mjs [filter]` runs the
// stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
  pasted,
  read,
  selection,
  story,
  until,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

const TABLE = 'above\n| item | qty |\n|:-----|----:|\n| milk | 2 |\n| eggs | 12 |\nbelow';

async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

/** Where `text` starts in the note's display text. */
const offsetOf = (text) => {
  for (const line of read('doc').lines) {
    const at = line.text.indexOf(text);
    if (at >= 0) return line.at + at;
  }
  throw new Error(`no "${text}" in the note`);
};

/** The control on screen labelled `text`, or undefined. */
const control = (text) => read('elements').elements.find((element) => element.text === text);
const ROW = 'Row options';
const COLUMN = 'Column options';
const grips = () => control(ROW) && control(COLUMN);

/** The table pasted, the caret put on the line below it. */
function tableWithCaretBelow() {
  pasted(TABLE);
  act('do', 'PlaceCaret', { at: offsetOf('below') + 2 });
}

/** Move the pointer over `text`'s cell and wait for its grips. */
async function hoverCell(text) {
  act('hover', { text });
  return until(grips, `the grips for "${text}"`);
}

/** Open `grip`'s menu with a click and click its item `item`. */
async function pick(grip, item) {
  act('click', { ref: (await until(() => control(grip), `the ${grip} grip`)).ref });
  act('click', { ref: (await until(() => control(item), `the ${item} item`)).ref });
}

const undo = () => act('press', { key: 'Mod-z' });

const middle = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

/** The grips of `text`'s cell centred, within 1px: the row's on its row, the column's on its
 *  column. */
async function assertGripsCentred(text) {
  await hoverCell(text);
  const stack = read('at', middle(read('show', { text }).rect)).stack;
  const cell = stack.find((element) => element.role === 'span' && element.text?.trim() === text);
  const row = stack.find((element) => element.role === 'div' && element.text?.startsWith('|'));
  const rowOffset = middle(control(ROW).rect).y - middle(row.rect).y;
  const columnOffset = middle(control(COLUMN).rect).x - middle(cell.rect).x;
  assert.ok(
    Math.abs(rowOffset) <= 1,
    `${text}: the row grip is ${rowOffset}px off its row's middle`,
  );
  assert.ok(Math.abs(columnOffset) <= 1, `${text}: the column grip is ${columnOffset}px off`);
}

await story('the grips show for the cell under the pointer, with the caret elsewhere', () =>
  inScratchNote(async () => {
    pasted(TABLE);
    // A caret in a cell, the pointer off the table: no grips.
    act('hover', { text: 'above' });
    act('do', 'PlaceCaret', { at: offsetOf('eggs') + 1 });
    assert.ok(!control(ROW) && !control(COLUMN), 'a caret alone shows no grips');
    act('do', 'PlaceCaret', { at: offsetOf('below') + 2 });
    const caret = selection();
    const before = read('show', { text: 'milk' }).rect;
    await hoverCell('milk');
    // The grips move no text and no caret.
    assert.deepEqual(read('show', { text: 'milk' }).rect, before);
    assert.deepEqual(selection(), caret);
    for (const text of ['milk', '12', 'item', 'qty']) await assertGripsCentred(text);
    // Off the table, and out of the editor, they go.
    act('hover', { text: 'above' });
    await until(() => !control(ROW) && !control(COLUMN), 'the grips go over a paragraph');
    await hoverCell('milk');
    const sidebar = read('elements').elements.find((element) => element.text === 'Search').rect;
    act('hover', { x: sidebar.x + sidebar.w / 2, y: sidebar.y + sidebar.h / 2 });
    await until(() => !control(ROW) && !control(COLUMN), 'the grips go out of the editor');
  }),
);

await story('the pointer travels from a cell over the gap onto each grip and opens its menu', () =>
  inScratchNote(async () => {
    tableWithCaretBelow();
    // Between the grip's edge and the row's (or the header's), from both boxes.
    const cellOf = (text) =>
      read('at', middle(read('show', { text }).rect)).stack.find(
        (element) => element.role === 'span' && element.text?.trim() === text,
      ).rect;
    for (const [grip, text, gap] of [
      [
        ROW,
        'milk',
        (rect, cell) => ({ x: (rect.x + rect.w + cell.x) / 2, y: rect.y + rect.h / 2 }),
      ],
      [
        COLUMN,
        'item',
        (rect, cell) => ({ x: rect.x + rect.w / 2, y: (rect.y + rect.h + cell.y) / 2 }),
      ],
    ]) {
      await hoverCell(text);
      const { rect, ref } = control(grip);
      const point = gap(rect, cellOf(text));
      assert.equal(
        read('at', point).stack[0].component,
        'TableGrips.svelte',
        "the gap is the grip's",
      );
      act('hover', point);
      assert.deepEqual(control(grip)?.rect, rect, `the ${grip} grip stays over its gap`);
      act('hover', { ref });
      assert.deepEqual(control(grip)?.rect, rect, `the ${grip} grip stays under the pointer`);
      act('click', { ref });
      await until(() => control('Insert after'), `the ${grip} menu`);
      act('press', { key: 'Escape' });
      await until(() => !control('Insert after'), 'the menu closes');
    }
  }),
);

await story("a row's grip inserts a row before and after the hovered row and deletes it", () =>
  inScratchNote(async (noteId) => {
    tableWithCaretBelow();
    await hoverCell('milk');
    await pick(ROW, 'Insert before');
    assert.match(await saved(noteId), /\|:-----\|----:\|\n\| {2}\| {2}\|\n\| milk \| 2 \|/);
    // The caret leaves the line below for the hovered cell, at its start.
    assert.deepEqual(selection(), [offsetOf('milk'), offsetOf('milk')]);
    undo();
    assert.equal(await saved(noteId), TABLE);
    await hoverCell('milk');
    await pick(ROW, 'Insert after');
    assert.match(await saved(noteId), /\| milk \| 2 \|\n\| {2}\| {2}\|\n\| eggs/);
    undo();
    assert.equal(await saved(noteId), TABLE);
    await hoverCell('milk');
    await pick(ROW, 'Delete');
    assert.equal(
      await saved(noteId),
      'above\n| item | qty |\n|:-----|----:|\n| eggs | 12 |\nbelow',
    );
    // The caret goes to the start of the cell below.
    assert.deepEqual(selection(), [offsetOf('eggs'), offsetOf('eggs')]);
    undo();
    assert.equal(await saved(noteId), TABLE);
  }),
);

await story(
  "a column's grip inserts a column left and right of the hovered one and deletes it",
  () =>
    inScratchNote(async (noteId) => {
      tableWithCaretBelow();
      await hoverCell('milk');
      await pick(COLUMN, 'Insert before');
      assert.match(await saved(noteId), /\n\| {2}\| item \| qty \|\n\| --- \|:-----\|----:\|\n/);
      undo();
      assert.equal(await saved(noteId), TABLE);
      await hoverCell('milk');
      await pick(COLUMN, 'Insert after');
      assert.match(await saved(noteId), /\n\| item \| {2}\| qty \|\n\|:-----\| --- \|----:\|\n/);
      undo();
      assert.equal(await saved(noteId), TABLE);
      await hoverCell('milk');
      await pick(COLUMN, 'Delete');
      assert.equal(await saved(noteId), 'above\n| qty |\n|----:|\n| 2 |\n| 12 |\nbelow');
      // The caret goes to the cell on the right.
      const [at] = selection();
      assert.ok(Math.abs(at - offsetOf('2')) <= 1, `the caret is at ${at}`);
      undo();
      assert.equal(await saved(noteId), TABLE);
    }),
);

await story("the header row's menu disables Delete and Insert before", () =>
  inScratchNote(async () => {
    tableWithCaretBelow();
    await hoverCell('item');
    act('click', { ref: control(ROW).ref });
    const flags = async (item) =>
      (await until(() => control(item), `the ${item} item`)).flags ?? [];
    assert.ok((await flags('Delete')).includes('disabled'), 'Delete is enabled');
    assert.ok((await flags('Insert before')).includes('disabled'), 'Insert before is enabled');
    assert.ok(!(await flags('Insert after')).includes('disabled'), 'Insert after is disabled');
    act('press', { key: 'Escape' });
    await until(() => !control('Insert after'), 'the menu closes');
  }),
);

await story('an open menu pins its cell: the pointer crossing other rows retargets nothing', () =>
  inScratchNote(async (noteId) => {
    tableWithCaretBelow();
    await hoverCell('milk');
    const row = control(ROW).rect;
    act('click', { ref: control(ROW).ref });
    await until(() => control('Delete'), 'the row menu');
    act('hover', { text: '12' });
    act('hover', { text: 'below' });
    assert.deepEqual(control(ROW)?.rect, row, 'the row grip stays on the hovered row');
    act('click', { ref: control('Delete').ref });
    assert.equal(
      await saved(noteId),
      'above\n| item | qty |\n|:-----|----:|\n| eggs | 12 |\nbelow',
    );
  }),
);

await story('Shift+Enter in a cell selects the cell below, the row unbroken', () =>
  inScratchNote(async (noteId) => {
    pasted(TABLE);
    act('do', 'PlaceCaret', { at: offsetOf('milk') + 2 });
    act('press', { key: 'Shift-Enter' });
    assert.deepEqual(selection(), [offsetOf('eggs'), offsetOf('eggs') + 4]);
    assert.equal(await saved(noteId), TABLE);
  }),
);

await story(
  'a caret in a cell holding nothing stands where its text starts, placed or clicked',
  () =>
    inScratchNote(async (noteId) => {
      // "Editor demo"'s table: a body row of one cell with no characters, `||`.
      pasted('above\n| askmdkasmd | asdmmasdmkms |\n|-|\n||');
      const editor = read('elements').elements.find(
        (element) => element.role === 'textbox' && element.component === 'DesktopEditor.svelte',
      ).rect;
      const header = read('show', { text: 'askmdkasmd' }).rect;
      // The `||` row is the line under the header (the delimiter row draws nothing).
      const rowAt = { x: header.x, y: header.y + header.h + 12 };
      const row = read('at', rowAt).stack.find((entry) => entry.text === '||').rect;
      const at = offsetOf('||') + 1;
      const caretX = () => editor.x + read('state').editor.caret.left;
      act('do', 'PlaceCaret', { at });
      const placed = caretX();
      // Inside the cell's padding, not on the row's left rule.
      assert.ok(placed >= row.x + 3 && placed < header.x, `the caret is at ${placed}`);
      act('do', 'PlaceCaret', { at: 0 });
      act('click', { x: row.x + row.w / 4, y: row.y + row.h / 2 });
      assert.deepEqual(selection(), [at, at]);
      assert.ok(Math.abs(caretX() - placed) <= 1, `a click's caret is at ${caretX()}`);
      // What is typed there lands in that cell, where the caret stood.
      act('type', { text: 'x' });
      const typed = read('show', { text: 'x' }).rect;
      assert.ok(
        Math.abs(typed.x - placed) <= 1,
        `x draws at ${typed.x}, the caret was at ${placed}`,
      );
      assert.ok(typed.y >= row.y && typed.y < row.y + row.h, 'x is on the row');
      assert.match(await saved(noteId), /\n\|x\|$/);
    }),
);

finish('table control stories');

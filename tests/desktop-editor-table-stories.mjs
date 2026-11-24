// The desktop editor's tables (docs/spec/editor/desktop/tables.md): drawn from the engine's table
// description as a grid whose columns line up across rows, the pipes and the delimiter row not
// drawn; the engine's keys in a cell (Tab, Shift+Tab, Enter, Mod+Enter), a multiline paste kept
// in its cell, and the caret, clicks (one on a cell a short row lacks too) and Up and Down in
// the grid. A cell's wrapped text and a
// table wider than the text column are in desktop-editor-table-wrap-stories.mjs, the grips'
// menus in desktop-editor-table-control-stories.mjs. Content comes in through Paste.
// `node tests/desktop-editor-table-stories.mjs [filter]` runs the stories whose name holds it.
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

/** Each line as [kind, text]. */
const kinds = () => read('doc').lines.map((line) => [line.kind, line.text]);

async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

const shown = (text) => read('show', { text }).rect;
/** The highlight's bands under viewport `x`, `y` (they pass the pointer through). */
const bandsUnder = (point) =>
  read('at', point).stack.filter((entry) => entry.flags.includes('passes') && entry.rect.h < 100);
/** Where `text` starts in the note's display text. */
const offsetOf = (text) => {
  for (const line of read('doc').lines) {
    const at = line.text.indexOf(text);
    if (at >= 0) return line.at + at;
  }
  throw new Error(`no "${text}" in the note`);
};
/** The selected text, as the display shows it. */
function selectedText() {
  const [from, to] = selection();
  let text = '';
  for (const line of read('doc').lines) {
    const start = Math.max(from, line.at) - line.at;
    const end = Math.min(to, line.end) - line.at;
    if (end > start) text += line.text.slice(start, end);
  }
  return text;
}

const TABLE = 'above\n| item | qty |\n|:-----|----:|\n| milk | 2 |\n| eggs | 12 |\nbelow';

await story('typing the delimiter row under a pipe line makes it a table', () =>
  inScratchNote(async (noteId) => {
    pasted('| item | qty |');
    assert.deepEqual(kinds()[0], ['paragraph', '| item | qty |']);
    act('press', { key: 'Enter' });
    // The row shows, muted, only while it is being typed, the caret on it.
    act('type', { text: '|---|---' });
    assert.equal(kinds()[1][0], 'table delimiter');
    await until(() => shown('|---|---').h > 10, 'the row being typed shows');
    // The closing pipe finishes it: a blank body row is written and the caret is in its first
    // cell, the delimiter row no longer drawn or reachable.
    act('type', { text: '|' });
    assert.deepEqual(kinds().slice(0, 3), [
      ['table header', '| item | qty |'],
      ['table delimiter', '|---|---|'],
      ['table row', '|  |  |'],
    ]);
    act('type', { text: 'milk' });
    assert.equal(await saved(noteId), '| item | qty |\n|---|---|\n| milk |  |');
    await until(() => shown('milk').y - shown('item').y < 40, 'the delimiter row takes no room');
  }),
);

await story("a table's columns line up across its rows, its alignment drawn", () =>
  inScratchNote(async () => {
    pasted(TABLE);
    assert.deepEqual(
      kinds().map(([kind]) => kind),
      ['paragraph', 'table header', 'table delimiter', 'table row', 'table row', 'paragraph'],
    );
    // Left column left-aligned: its texts start at one x.
    assert.ok(Math.abs(shown('item').x - shown('milk').x) <= 1, 'the left column is not aligned');
    // Right column right-aligned: its texts end at one x.
    const right = (text) => shown(text).x + shown(text).w;
    assert.ok(Math.abs(right('qty') - right('12')) <= 1, 'the right column is not right-aligned');
    // Every row is one line unit; the delimiter row is not drawn and takes none.
    assert.equal(shown('milk').y - shown('item').y, 24);
    // `selection()` fails on Puppet's drift error, which compares the page with the engine.
    selection();
  }),
);

await story(
  'Tab and Shift+Tab select the next and previous cell; Tab in the last cell adds a row',
  () =>
    inScratchNote(async (noteId) => {
      pasted(TABLE);
      act('do', 'PlaceCaret', { at: offsetOf('milk') + 2 });
      act('press', { key: 'Tab' });
      assert.equal(selectedText(), '2');
      act('press', { key: 'Tab' });
      assert.equal(selectedText(), 'eggs');
      act('press', { key: 'Shift-Tab' });
      assert.equal(selectedText(), '2');
      act('do', 'PlaceCaret', { at: offsetOf('12') + 2 });
      act('press', { key: 'Tab' });
      act('type', { text: 'tea' });
      assert.equal(
        await saved(noteId),
        'above\n| item | qty |\n|:-----|----:|\n| milk | 2 |\n| eggs | 12 |\n| tea |  |\nbelow',
      );
    }),
);

await story('Enter selects the cell below in its column, and on the last row adds one', () =>
  inScratchNote(async (noteId) => {
    pasted(TABLE);
    act('do', 'PlaceCaret', { at: offsetOf('qty') });
    act('press', { key: 'Enter' });
    assert.equal(selectedText(), '2');
    act('press', { key: 'Enter' });
    assert.equal(selectedText(), '12');
    act('press', { key: 'Enter' });
    act('type', { text: '7' });
    assert.match(await saved(noteId), /\| eggs \| 12 \|\n\| {2}\| 7 \|\nbelow$/);
  }),
);

await story('Mod+Enter in a table that ends the note puts the caret on a line after it', () =>
  inScratchNote(async (noteId) => {
    pasted('| a | b |\n|---|---|\n| c | d |');
    act('do', 'PlaceCaret', { at: offsetOf('c') });
    act('press', { key: 'Mod-Enter' });
    act('type', { text: 'after' });
    assert.equal(await saved(noteId), '| a | b |\n|---|---|\n| c | d |\nafter');
    assert.equal(kinds()[3][0], 'paragraph');
  }),
);

await story('a multiline paste in a cell stays in that cell', () =>
  inScratchNote(async (noteId) => {
    pasted(TABLE);
    act('do', 'PlaceCaret', { at: offsetOf('milk') + 4 });
    pasted(' and\noat\nmilk');
    assert.match(await saved(noteId), /\n\| milk and oat milk \| 2 \|\n/);
    selection();
  }),
);

await story('a typed pipe in a cell adds a column to every row', () =>
  inScratchNote(async () => {
    pasted(TABLE);
    act('do', 'PlaceCaret', { at: offsetOf('milk') + 4 });
    act('type', { text: ' | x' });
    // Puppet's drift check compares every row's columns with a fresh read of the engine.
    selection();
    // The row's new cell is the table's second column, right-aligned under `qty` as that
    // column is; its `2` is now the third, after that column.
    const [x, qty, two] = [shown('x'), shown('qty'), shown('2')];
    assert.ok(Math.abs(x.x + x.w - (qty.x + qty.w)) <= 1, 'the new cell is not in qty’s column');
    assert.ok(qty.x + qty.w < two.x, 'the columns did not narrow to three');
  }),
);

await story('a click in a cell puts the caret there, and Up and Down keep the column', () =>
  inScratchNote(async () => {
    pasted(TABLE);
    const eggs = shown('eggs');
    act('click', { x: eggs.x + 1, y: eggs.y + eggs.h / 2 });
    assert.deepEqual(selection(), [offsetOf('eggs'), offsetOf('eggs')]);
    act('press', { key: 'ArrowUp' });
    assert.deepEqual(selection(), [offsetOf('milk'), offsetOf('milk')]);
    // Up from the first row passes the delimiter row, onto the header.
    act('press', { key: 'ArrowUp' });
    assert.deepEqual(selection(), [offsetOf('item'), offsetOf('item')]);
    // Right from a cell's end goes to the next cell's start, past the pipe.
    act('do', 'PlaceCaret', { at: offsetOf('milk') + 4 });
    act('press', { key: 'ArrowRight' });
    const [at] = selection();
    assert.ok(at > offsetOf('milk') + 4 && at <= offsetOf('2'), `the caret is at ${at}`);
  }),
);

await story('a selection inside one cell is highlighted in its column alone', () =>
  inScratchNote(async () => {
    pasted('| a | long words here |\n|---|---|\n| b | c |');
    const from = offsetOf('long');
    act('do', 'Select', { from, to: from + 4 });
    const long = shown('long');
    const middle = long.y + long.h / 2;
    await until(() => bandsUnder({ x: long.x + 10, y: middle }).length > 0, 'the highlight');
    assert.equal(bandsUnder({ x: shown('a').x + 2, y: middle }).length, 0, 'column one lit');
  }),
);

/** The box of the table row that shows `text`. */
const rowOf = (text) => {
  const box = shown(text);
  const point = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  return read('at', point).stack.find(
    (entry) => entry.role === 'div' && entry.text?.startsWith('|'),
  ).rect;
};

await story('a drag from the first cell to an empty last cell highlights every cell whole', () =>
  inScratchNote(async () => {
    pasted('above\n| first | second |\n|---|---|\n| third |  |\nbelow');
    const header = rowOf('first');
    const last = rowOf('third');
    const first = shown('first');
    act('drag', {
      x: first.x + 1,
      y: first.y + first.h / 2,
      x2: last.x + last.w - 10,
      y2: last.y + last.h / 2,
    });
    // Each row's band covers the row's box, border to border, its left padding and the empty
    // cell included.
    for (const row of [header, last]) {
      for (const x of [row.x + 2, row.x + row.w - 2]) {
        const point = { x, y: row.y + row.h / 2 };
        const band = await until(() => bandsUnder(point)[0], `a band at ${x},${point.y}`);
        for (const side of ['x', 'y', 'w', 'h']) {
          assert.ok(
            Math.abs(band.rect[side] - row[side]) <= 1,
            `band ${side} ${band.rect[side]} against the row's ${row[side]}`,
          );
        }
      }
    }
  }),
);

await story('Backspace over a selection of every cell removes the table, one Undo', () =>
  inScratchNote(async (noteId) => {
    const table = 'above\n| first | second |\n|---|---|\n| third |  |\nbelow';
    pasted(table);
    const first = shown('first');
    const last = rowOf('third');
    // A real drag from the first cell's text to the empty last cell.
    act('drag', {
      x: first.x + 1,
      y: first.y + first.h / 2,
      x2: last.x + last.w - 10,
      y2: last.y + last.h / 2,
    });
    act('press', { key: 'Backspace' });
    assert.equal(await saved(noteId), 'above\n\nbelow');
    // The caret is on the empty line the table left.
    assert.deepEqual(selection(), [offsetOf('above') + 6, offsetOf('above') + 6]);
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), table);
    // One cell short, the table stays (a plain deletion).
    act('do', 'Select', { from: offsetOf('first'), to: offsetOf('third') + 5 });
    act('press', { key: 'Backspace' });
    assert.notEqual(await saved(noteId), 'above\n\nbelow');
  }),
);

await story("a cell's text starts after its padding, which a click and Left reach", () =>
  inScratchNote(async () => {
    pasted('| a | first second |\n|---|---|\n| b | c |');
    const first = shown('first');
    act('click', { x: first.x + 1, y: first.y + first.h / 2 });
    const start = offsetOf('first');
    assert.deepEqual(selection(), [start, start]);
    const caretLeft = async () =>
      (await until(() => read('state').editor.caret, 'the caret draws')).left;
    const atText = await caretLeft();
    act('press', { key: 'ArrowLeft' });
    assert.deepEqual(selection(), [start - 1, start - 1]);
    assert.ok(atText - (await caretLeft()) > 2, 'the caret before the padding is at the text');
  }),
);

await story('Backspace right after a pipe keeps it', () =>
  inScratchNote(async (noteId) => {
    pasted(TABLE);
    // The cell's first character, its padding space, is right after the pipe.
    act('do', 'PlaceCaret', { at: offsetOf('2') - 1 });
    act('press', { key: 'Backspace' });
    assert.equal(await saved(noteId), TABLE);
    selection();
  }),
);

await story(
  'Left and Right cross between the header and the first row, never onto the delimiter',
  () =>
    inScratchNote(async () => {
      pasted(TABLE);
      const delimiter = read('doc').lines.find((line) => line.kind === 'table delimiter');
      const onDelimiter = () => {
        const [at] = selection();
        return at >= delimiter.at && at <= delimiter.end;
      };
      act('do', 'PlaceCaret', { at: offsetOf('milk') - 1 });
      for (let presses = 0; presses < 3 && selection()[0] >= delimiter.at; presses++) {
        act('press', { key: 'ArrowLeft' });
        assert.ok(!onDelimiter(), `Left put the caret on the delimiter row at ${selection()[0]}`);
      }
      assert.ok(selection()[0] < delimiter.at, 'Left never reached the header');
      for (let presses = 0; presses < 3 && selection()[0] <= delimiter.end; presses++) {
        act('press', { key: 'ArrowRight' });
        assert.ok(!onDelimiter(), `Right put the caret on the delimiter row at ${selection()[0]}`);
      }
      assert.ok(selection()[0] > delimiter.end, 'Right never reached the first row');
    }),
);

await story('a click on the box a short row lacks gives the row that cell, the caret in it', () =>
  inScratchNote(async (noteId) => {
    const SHORT_ROWS =
      '| askmdkasmd | asdmmasdmkms |\n|-|\n||\n\n| one | two | three |\n|-|-|-|\n||';
    pasted(SHORT_ROWS);
    // The body row under a header cell: the delimiter row takes no room.
    const below = (text) => ({ x: shown(text).x + 2, y: shown(text).y + shown(text).h / 2 + 24 });
    const rowOf = async (index) => (await saved(noteId)).split('\n')[index];
    act('click', below('asdmmasdmkms'));
    const entered = await rowOf(2);
    assert.notEqual(entered, '||', 'the click gave the row no cell');
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), SHORT_ROWS, 'one Undo did not take the cell away');
    act('click', below('asdmmasdmkms'));
    act('type', { text: 'x' });
    const typed = await rowOf(2);
    assert.equal(typed.replace('x', ''), entered);
    assert.deepEqual(
      typed.split('|').map((cell) => cell.trim()),
      ['', '', 'x', ''],
    );
    // A row lacking two cells: a click on the last box lands in that column.
    act('click', below('three'));
    act('type', { text: 'y' });
    assert.deepEqual(
      (await rowOf(6)).split('|').map((cell) => cell.trim()),
      ['', '', '', 'y', ''],
    );
  }),
);

finish('table stories');

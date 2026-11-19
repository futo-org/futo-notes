// The desktop editor's pointer (pointer.ts): real mouse input through `just puppet`, every
// gesture checked against the engine's selection, which the page must agree with.
// `node tests/desktop-editor-pointer-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inNewNote,
  inScratchNote,
  pasted,
  read,
  scrollAtRest,
  selection,
  story,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

// Lines: "one, two three" 0..14, "" 15, "last line here" 16..30.
const TEXT = 'one, two three\n\nlast line here';

const shown = (text) => read('show', { text }).rect;
const editorBox = () =>
  read('elements').elements.find((element) => element.component === 'DesktopEditor.svelte').rect;
/** The vertical middle of the row `text` is on. */
const rowOf = (text) => {
  const rect = shown(text);
  return rect.y + rect.h / 2;
};
/** Just inside the left edge of `text`'s first character. */
const before = (text) => ({ x: shown(text).x + 1, y: rowOf(text) });

await story('a click places the caret, a double click selects the word, a triple the line', () =>
  inNewNote(async () => {
    act('type', { text: TEXT });
    act('click', before('two'));
    assert.deepEqual(selection(), [5, 5]);
    act('click', { text: 'two', count: 2 });
    assert.deepEqual(selection(), [5, 8]);
    // The whole line, without its break.
    act('click', { text: 'two', count: 3 });
    assert.deepEqual(selection(), [0, 14]);
  }),
);

await story('a press off the text lands on the row beside it, or below on the last one', () =>
  inNewNote(async () => {
    act('type', { text: TEXT });
    const box = editorBox();
    const last = rowOf('last');
    act('click', { x: box.x + 4, y: last });
    assert.deepEqual(selection(), [16, 16], 'left of a row is its start');
    act('click', { x: box.x + box.w - 4, y: rowOf('two') });
    assert.deepEqual(selection(), [14, 14], 'right of a row is its end');
    const line = before('line');
    act('click', { x: line.x, y: last + 30 });
    assert.deepEqual(selection(), [21, 21], 'just below the last row is its column');
    act('click', { x: line.x, y: last + 100 });
    assert.deepEqual(selection(), [30, 30], 'further down is the end of the note');
    // A double click off the text is the one on it: past a line's end, its last word.
    act('click', { x: box.x + box.w - 4, y: rowOf('two'), count: 2 });
    assert.deepEqual(selection(), [9, 14]);
  }),
);

await story(
  "a press on a row's top or bottom pixel lands at its column, on every kind of line",
  () =>
    inScratchNote(async () => {
      pasted(
        'a paragraph with `inline code`\n# Heading one\n- a list item\n```js\nlet code = 1\n```\nend',
      );
      const at = () => read('state').editor.selection.from;
      for (const text of ['a paragraph', 'Heading one', 'a list item', 'let code = 1']) {
        const glyphs = shown(text);
        const line = read('at', { x: glyphs.x + 2, y: rowOf(text) }).stack[0].rect;
        const x = glyphs.x + glyphs.w / 2;
        act('click', { x, y: rowOf(text) });
        const column = at();
        // The line's first whole pixel and its last: on a block's last code line, its skirt's.
        for (const y of [line.y + 1, line.y + line.h - 1]) {
          act('click', { x, y });
          assert.equal(at(), column, `${text} at y ${y}`);
        }
      }
    }),
);

await story('Shift+click extends the selection from its anchor', () =>
  inNewNote(async () => {
    act('type', { text: TEXT });
    act('click', before('one'));
    act('click', { ...before('three'), shift: true });
    assert.deepEqual(selection(), [0, 9]);
    act('click', { ...before('two'), shift: true });
    assert.deepEqual(selection(), [0, 5]);
    // Without focus (a press on the chrome above took it), from the engine's start.
    act('click', before('two'));
    const box = editorBox();
    act('click', { x: box.x + box.w / 2, y: box.y - 4 });
    act('click', { ...before('last'), shift: true });
    assert.deepEqual(selection(), [5, 16]);
  }),
);

await story('a drag selects, and coming back past the press deselects at once', () =>
  inNewNote(async () => {
    act('type', { text: TEXT });
    const two = before('two');
    const last = before('last');
    act('drag', { x: two.x, y: two.y, x2: last.x, y2: last.y });
    assert.deepEqual(selection(), [5, 16]);
    // Out to the last line and back onto the press point: nothing selected.
    act('drag', { x: two.x, y: two.y, path: [[last.x, last.y]], x2: two.x, y2: two.y });
    assert.deepEqual(selection(), [5, 5]);
    // On past it, backward from the press.
    const one = before('one');
    act('drag', { x: two.x, y: two.y, path: [[last.x, last.y]], x2: one.x, y2: one.y });
    assert.deepEqual(selection(), [0, 5]);
  }),
);

await story('a double-click drag extends by words, keeping the first word', () =>
  inNewNote(async () => {
    act('type', { text: TEXT });
    act('click', { text: 'two', count: 2 });
    const two = shown('two');
    const three = shown('three');
    act('drag', {
      x: two.x + two.w / 2,
      y: rowOf('two'),
      x2: three.x + 3,
      y2: rowOf('three'),
      count: 2,
    });
    assert.deepEqual(selection(), [5, 14]);
  }),
);

await story('a drag past the bottom of the pane scrolls it and selects on', () =>
  inNewNote(async () => {
    const many = Array.from({ length: 60 }, (_, index) => `row ${index + 1}`).join('\n');
    act('type', { text: many });
    await untilIdle();
    act('do', 'PlaceCaret', { at: 0 });
    const box = editorBox();
    await scrollAtRest({ x: box.x + box.w / 2, y: 300, dy: -3000 });
    const start = before('row 1');
    const below = read('elements').viewport.h + 40;
    // Held below the pane for two of the three seconds.
    act('drag', {
      x: start.x,
      y: start.y,
      path: [[start.x, below]],
      x2: start.x,
      y2: below + 1,
      duration: 3,
    });
    const [from, to] = selection();
    assert.equal(from, 0);
    const lastRow = read('doc').lines.at(-1);
    assert.ok(to > read('doc').lines[30].at, `selected to ${to}, not past row 31`);
    assert.ok(to <= lastRow.end);
  }),
);

await story('a press in a scrolled note without focus leaves the scroll where it is', () =>
  inNewNote(async () => {
    const many = Array.from({ length: 60 }, (_, index) => `row ${index + 1}`).join('\n');
    act('type', { text: many });
    await untilIdle();
    act('do', 'PlaceCaret', { at: 0 });
    await scrollAtRest({ x: editorBox().x + 20, y: 300, dy: -3000 });
    const box = editorBox();
    // A press on the chrome just above the body takes focus away, the caret kept at 0.
    act('click', { x: box.x + box.w / 2, y: box.y - 4 });
    assert.equal(read('state').editor.focused, false);
    await scrollAtRest({ x: box.x + box.w / 2, y: 300, dy: 500 });
    const scrolled = editorBox().y;
    assert.ok(scrolled < box.y, 'the wheel scrolled the pane');
    act('click', before('row 25'));
    assert.equal(editorBox().y, scrolled, 'the press did not scroll the pane');
    const row = read('doc').lines[24];
    assert.deepEqual(selection(), [row.at, row.at]);
  }),
);

await story('Up and Down keep the column across a short line, and stop at the ends', () =>
  inNewNote(async () => {
    act('type', { text: 'a long first line\nab\na long third line' });
    act('click', before('first'));
    assert.deepEqual(selection(), [7, 7]);
    // Through "ab", which is too short to hold the column, and on at the same column.
    act('press', { key: 'ArrowDown' });
    assert.deepEqual(selection(), [20, 20]);
    act('press', { key: 'ArrowDown' });
    assert.deepEqual(selection(), [28, 28]);
    act('press', { key: 'Shift-ArrowUp', count: 2 });
    assert.deepEqual(selection(), [7, 28]);
    // Down from the last row is the note's end; Up from the first its start.
    act('press', { key: 'ArrowDown', count: 2 });
    assert.deepEqual(selection(), [38, 38]);
    act('press', { key: 'ArrowUp', count: 3 });
    assert.deepEqual(selection(), [0, 0]);
  }),
);

// Soft-wrapped lines: a wrap at a space, an unbreakable run longer than a row, and a CJK
// line with no space. A wrap's two rows share one offset, so the drawn caret's top tells
// which row the caret is on.
// The row's start and end: Cmd+Left and Cmd+Right on Apple, Home and End elsewhere.
const [ROW_START, ROW_END] =
  process.platform === 'darwin' ? ['Mod-ArrowLeft', 'Mod-ArrowRight'] : ['Home', 'End'];

const WRAPPED = [
  'the quick brown fox jumps over the lazy dog and runs on and on past the end of the row',
  `done ${'abcdefghij'.repeat(12)}`,
  '这是一个没有空格的很长的中文句子它会在行尾换行'.repeat(3),
].join('\n');

await story('a caret at a soft wrap stays on the row it was put on', () =>
  inNewNote(async () => {
    act('clipboard', { text: WRAPPED });
    act('do', 'Paste');
    await untilIdle();
    const end = read('doc').lines.at(-1).end;
    const caret = () => read('state').editor.caret;
    // A row end is measured from its text, a row start as a collapsed caret: a fraction apart.
    const sameRow = (top, row, message) =>
      assert.ok(Math.abs(top - row) < 1, `${message}: ${top} ≠ ${row}`);
    const right = editorBox().x + editorBox().w - 4;
    for (const text of ['quick', 'abcdefghij', '这是']) {
      // A click right of a wrapped row's end puts the caret on that row.
      act('click', before(text));
      const row = caret().top;
      act('click', { x: right, y: rowOf(text) });
      sameRow(caret().top, row, `right of the "${text}" row`);
      // Cmd+Right stays on the row; Cmd+Left after it goes to that row's start.
      act('click', before(text));
      const [start] = selection();
      act('press', { key: ROW_START });
      const [rowStart] = selection();
      act('click', before(text));
      act('press', { key: ROW_END });
      sameRow(caret().top, row, `Cmd+Right on the "${text}" row`);
      assert.ok(selection()[0] > start, `Cmd+Right on the "${text}" row moves right`);
      act('press', { key: ROW_START });
      sameRow(caret().top, row, `Cmd+Left back on the "${text}" row`);
      assert.deepEqual(selection(), [rowStart, rowStart]);
    }
    // From the end of the first (wrapped) row, the kept x at the right margin: every Down
    // goes a row lower until the note's end, every Up a row higher until its start.
    act('click', { x: right, y: rowOf('quick') });
    for (const [key, goal, lower] of [
      ['ArrowDown', end, true],
      ['ArrowUp', 0, false],
    ]) {
      for (let press = 0; selection()[0] !== goal; press++) {
        assert.ok(press < 20, `${key} reached ${selection()[0]}, not ${goal}`);
        const top = caret().top;
        act('press', { key });
        const moved = caret().top;
        // Only the last press may stay on its row: from the last row, the note's end.
        if (selection()[0] !== goal || Math.abs(moved - top) >= 1) {
          assert.ok(
            lower ? moved > top + 1 : moved < top - 1,
            `${key} from top ${top} drew at ${moved}`,
          );
        }
      }
    }
  }),
);

await story('Up and Down past the pane scroll it one row a press', () =>
  inNewNote(async () => {
    const many = Array.from({ length: 60 }, (_, index) => `row ${index + 1}.`).join('\n');
    act('type', { text: many });
    await untilIdle();
    act('do', 'PlaceCaret', { at: 0 });
    const box = editorBox();
    await scrollAtRest({ x: box.x + box.w / 2, y: 300, dy: -3000 });
    // The pane: the first box under the body that is shorter than the note, the one it scrolls in.
    const pane = read('at', { x: box.x + 10, y: 300 }).stack.find(
      (element) => element.rect.h < editorBox().h,
    ).rect;
    const [paneTop, paneBottom] = [pane.y, pane.y + pane.h];
    // Far enough down that a tall pane still has rows to scroll back up through.
    act('press', { key: 'ArrowDown', count: 52 });
    const row53 = read('doc').lines[52].at;
    assert.deepEqual(selection(), [row53, row53]);
    const rowHeight = shown('row 53.').y - shown('row 52.').y;
    /** Press `key` once, `count` times: each press scrolls the pane by exactly one row. */
    const scrollsOneRowEachPress = (key, count, sign) => {
      for (let press = 0; press < count; press++) {
        const before = editorBox().y;
        act('press', { key });
        const moved = editorBox().y - before;
        assert.ok(
          Math.abs(moved - sign * rowHeight) <= 1,
          `${key} ${press + 1} scrolled ${moved}px`,
        );
        const row = shown(`row ${read('state').editor.selection.line}.`);
        assert.ok(
          row.y >= paneTop && row.y + row.h <= paneBottom,
          `${key} ${press + 1}: row at ${row.y}`,
        );
      }
    };
    scrollsOneRowEachPress('ArrowDown', 3, -1);
    // Up until the pane first scrolls. Its height need not be whole rows, so that press brings
    // the row above in by what it lacks: more than nothing, no more than a row.
    let moved = 0;
    for (let press = 0; press < 60 && moved === 0; press++) {
      const before = editorBox().y;
      act('press', { key: 'ArrowUp' });
      moved = editorBox().y - before;
    }
    assert.ok(
      moved > 0 && moved <= rowHeight + 1,
      `the first ArrowUp that scrolled moved ${moved}px`,
    );
    scrollsOneRowEachPress('ArrowUp', 6, 1);
  }),
);

await story('dragging selected text moves it, selected, and one Undo puts it back', () =>
  inNewNote(async (noteId) => {
    // Pasted, so the stars are Markdown (typed ones stay characters).
    act('clipboard', { text: 'one **two** three' });
    act('do', 'Paste');
    act('click', { text: 'two', count: 2 });
    const two = shown('two');
    const end = shown('three');
    act('drag', {
      x: two.x + two.w / 2,
      y: rowOf('two'),
      x2: end.x + end.w + 1,
      y2: rowOf('three'),
    });
    assert.deepEqual(
      read('doc').lines.map((line) => line.text),
      ['one  threetwo'],
    );
    assert.deepEqual(selection(), [10, 13]);
    await untilIdle();
    assert.equal(read('file', { noteId, save: false }).lines[0].text, 'one  three**two**');
    act('press', { key: 'Mod-z' });
    assert.deepEqual(
      read('doc').lines.map((line) => line.text),
      ['one two three'],
    );
    // A press on selected text that does not move places the caret.
    act('click', { text: 'two', count: 2 });
    act('click', before('wo'));
    assert.deepEqual(selection(), [5, 5]);
  }),
);

finish('desktop editor pointer stories');

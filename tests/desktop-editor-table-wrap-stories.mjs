// The desktop editor's table widths (docs/spec/editor/desktop/tables.md): a table as wide as the
// text column, its columns equal shares of it, a cell's text wrapping inside its column; the
// caret, clicks, Up and Down, a selection and find on a cell's wrapped rows; and a table whose
// columns at their minimum pass the text column, which scrolls sideways with the caret, the
// highlight and find following it. Content comes in through Paste.
// `node tests/desktop-editor-table-wrap-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  appleStory,
  finish,
  inScratchNote,
  pasted,
  read,
  selection,
  story,
  until,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

const shown = (text) => read('show', { text }).rect;
const centre = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
/** The highlight's bands under viewport `x`, `y`: the editor's, which pass the pointer through
 *  (a toast passes it too). */
const bandsUnder = (point) =>
  read('at', point).stack.filter(
    (entry) =>
      entry.component === 'DesktopEditor.svelte' &&
      entry.flags.includes('passes') &&
      entry.rect.h < 100,
  );
/** Where `text` starts in the note's display text. */
const offsetOf = (text) => {
  for (const line of read('doc').lines) {
    const at = line.text.indexOf(text);
    if (at >= 0) return line.at + at;
  }
  throw new Error(`no "${text}" in the note`);
};
/** The box of the table row that shows `text`. */
const rowOf = (text) =>
  read('at', centre(shown(text))).stack.find(
    (entry) => entry.role === 'div' && entry.text?.startsWith('|'),
  ).rect;
/** The editor's box: the caret's `left` and `top` are relative to it. */
const editorBox = () =>
  read('elements').elements.find(
    (element) => element.role === 'textbox' && element.component === 'DesktopEditor.svelte',
  ).rect;
/** A paragraph that wraps, so its box is the text column's. */
const COLUMN_TEXT = 'column '.repeat(60).trim();
const column = () => {
  const text = shown('column');
  const line = read('at', centre(text)).stack.find((entry) => entry.text?.startsWith('column'));
  return { left: line.rect.x, right: line.rect.x + line.rect.w };
};

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike';
/** A two-column table whose second cell holds a paragraph, between two lines. */
const LONG = `${COLUMN_TEXT}\n| name | notes |\n|---|---|\n| short | ${WORDS} |\nbelow`;

/** The first word of the long cell that stands on a row under its first word's. */
function secondRowWord() {
  const words = WORDS.split(' ');
  const top = shown(words[0]).y;
  const word = words.find((each) => shown(each).y > top + 10);
  assert.ok(word, 'the cell did not wrap');
  return word;
}

await story('long text in one cell wraps, the table as wide as the text column, no scroll', () =>
  inScratchNote(async () => {
    pasted(LONG);
    const { left, right } = column();
    const row = rowOf('short');
    assert.ok(row.h > 24, `the row is ${row.h}px tall`);
    assert.ok(Math.abs(row.x - left) <= 1, `the table starts at ${row.x}, the column at ${left}`);
    assert.ok(Math.abs(row.x + row.w - right) <= 1, `the table ends at ${row.x + row.w}`);
    const last = shown('mike');
    assert.ok(last.x + last.w <= right, 'the cell runs past the text column');
    // A sideways wheel over it moves nothing.
    act('scroll', { ...centre(row), dx: 400 });
    assert.deepEqual(shown('mike'), last);
    selection();
  }),
);

await story(
  'the caret, a click, Up and Down, a selection and find on a wrapped row of a cell',
  () =>
    inScratchNote(async () => {
      pasted(LONG);
      const editor = editorBox();
      const word = secondRowWord();
      const box = shown(word);
      // The wrapped row starts where the first row's text does, after the cell's padding.
      const first = shown('alpha');
      assert.ok(Math.abs(box.x - first.x) <= 1, `${word} is at ${box.x}, alpha at ${first.x}`);
      // The caret stands on that row, by the word.
      act('do', 'PlaceCaret', { at: offsetOf(word) });
      const caret = read('state').editor.caret;
      assert.ok(Math.abs(editor.y + caret.top - box.y) <= 1, `the caret is at y ${caret.top}`);
      assert.ok(Math.abs(editor.x + caret.left - box.x) <= 1, `the caret is at x ${caret.left}`);
      // A click on the word lands in it.
      act('click', centre(box));
      const [clicked] = selection();
      assert.ok(clicked >= offsetOf(word) && clicked <= offsetOf(word) + word.length, `${clicked}`);
      // Up goes to the cell's first row, then out to the header's cell in the column.
      act('do', 'PlaceCaret', { at: offsetOf(word) + 1 });
      act('press', { key: 'ArrowUp' });
      const [up] = selection();
      assert.ok(up >= offsetOf('alpha') && up < offsetOf(word), `Up landed at ${up}`);
      act('press', { key: 'ArrowUp' });
      const [header] = selection();
      assert.ok(header >= offsetOf('notes') - 1 && header <= offsetOf('notes') + 6, `${header}`);
      act('press', { key: 'ArrowDown' });
      act('press', { key: 'ArrowDown' });
      const [down] = selection();
      assert.ok(down >= offsetOf(word) && down <= offsetOf(word) + word.length + 1, `${down}`);
      // A selection of the word is highlighted on its row inside its column alone.
      act('do', 'Select', { from: offsetOf(word), to: offsetOf(word) + word.length });
      await until(() => bandsUnder(centre(box)).length > 0, 'the highlight');
      const beside = bandsUnder({ x: shown('short').x + 2, y: box.y + box.h / 2 });
      assert.equal(beside.length, 0, `a band beside it: ${JSON.stringify(beside)}`);
      // Find's match is drawn there.
      act('do', 'PlaceCaret', { at: 0 });
      act('press', { key: 'Mod-f' });
      act('do', 'SetFindQuery', { query: word });
      await until(() => read('state').editor.find.total === 1, 'find counts the match');
      act('do', 'StepFind', { direction: 1 });
      await until(() => bandsUnder(centre(shown(word))).length > 0, 'the match is drawn');
      act('do', 'CloseFind');
    }),
);

await story('typing at the end of a wrapping cell grows its row', () =>
  inScratchNote(async (noteId) => {
    pasted(LONG);
    const before = rowOf('short').h;
    act('do', 'PlaceCaret', { at: offsetOf('mike') + 4 });
    act('type', { text: ' november oscar papa quebec romeo sierra tango uniform victor' });
    await until(() => rowOf('short').h > before && rowOf('short'), 'the row grows');
    const { right } = column();
    const last = shown('victor');
    assert.ok(last.x + last.w <= right, 'the typed text runs past the text column');
    assert.match(await saved(noteId), /mike november .* victor \|/);
  }),
);

await story('an empty cell beside a wrapped one takes the caret on the row’s first line', () =>
  inScratchNote(async () => {
    pasted(`${COLUMN_TEXT}\n| name | notes |\n|---|---|\n|| ${WORDS} |\nbelow`);
    const editor = editorBox();
    act('do', 'PlaceCaret', { at: offsetOf(`|| ${WORDS}`) + 1 });
    const caret = read('state').editor.caret;
    const first = shown('alpha');
    assert.ok(Math.abs(editor.y + caret.top - first.y) <= 1, `the caret is at y ${caret.top}`);
  }),
);

await story(
  'the row grip of a tall row stands at its middle, and the pointer reaches it from any row',
  () =>
    inScratchNote(async () => {
      pasted(LONG);
      const row = rowOf('short');
      const first = shown('short');
      act('hover', centre(first));
      const grip = await until(
        () => read('elements').elements.find((element) => element.text === 'Row options'),
        'the row grip',
      );
      const middle = grip.rect.y + grip.rect.h / 2;
      assert.ok(Math.abs(middle - (row.y + row.h / 2)) <= 1, `the grip's middle is at ${middle}`);
      // Straight left from the cell's first row, over the gap, the grip stays.
      act('hover', { x: (grip.rect.x + grip.rect.w + row.x) / 2, y: first.y + first.h / 2 });
      assert.ok(read('elements').elements.some((element) => element.text === 'Row options'));
    }),
);

/** A table of 24 columns: at their minimum (5em each) they pass the text column at any window size
 *  the stories run in, the default 1200x800 included, so the story needs no narrow pane. */
const FILLER = Array.from({ length: 16 }, (_, index) => `p${index + 8}`);
const MANY = [
  COLUMN_TEXT,
  `| ${['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', ...FILLER, 'far'].join(' | ')} |`,
  `|${'---|'.repeat(24)}`,
  `| ${['near', 'b', 'c', 'd', 'e', 'f', 'g', ...FILLER.map(() => 'x'), 'zebra'].join(' | ')} |`,
  'below',
].join('\n');
/** A sideways wheel of `dx` over the middle of the table's body row, wherever it is scrolled. */
function scrollTable(dx) {
  const { left, right } = column();
  const row = shown('near');
  act('scroll', { x: (left + right) / 2, y: row.y + row.h / 2, dx });
}

await story('a table whose columns pass the text column scrolls sideways, not the page', () =>
  inScratchNote(async () => {
    pasted(MANY);
    const { left, right } = column();
    const far = shown('zebra');
    assert.ok(far.x > right, `the far column is at ${far.x}, inside the column (${right})`);
    scrollTable(4000);
    const moved = await until(() => shown('zebra').x < far.x - 50 && shown('zebra'), 'scroll');
    assert.ok(moved.x + moved.w <= right, 'the far column is not in view');
    // The header's far cell moved as far, and the lines around the table did not.
    assert.ok(Math.abs(shown('far').x - moved.x) <= 1, 'the header lags');
    assert.equal(shown('below').x, left);
    selection();
  }),
);

await story('the caret, a selection and a find match in a far column follow the scroll', () =>
  inScratchNote(async (noteId) => {
    pasted(MANY);
    const { left, right } = column();
    // The text's start shows (the caret's reveal keeps a line unit in from the row's sides).
    const inView = (rect) => rect.x >= left - 1 && rect.x <= right - 10;
    act('do', 'PlaceCaret', { at: offsetOf('zebra') + 2 });
    await until(() => inView(shown('zebra')), 'the caret is revealed');
    await until(() => read('state').editor.caret, 'the caret draws');
    // Scrolling the table back hides the caret with its cell; typing brings both back.
    scrollTable(-4000);
    await until(() => !inView(shown('zebra')), 'the table scrolls back');
    await until(() => read('state').editor.caret === null, 'the caret hides');
    act('type', { text: 'Q' });
    await until(() => inView(shown('zeQbra')), 'typing reveals the cell');
    // A selection there is highlighted where the text is drawn, and nowhere once scrolled away.
    const from = offsetOf('zeQbra');
    act('do', 'Select', { from, to: from + 6 });
    await until(() => bandsUnder(centre(shown('zeQbra'))).length > 0, 'the highlight');
    scrollTable(-4000);
    await until(() => !inView(shown('zeQbra')), 'the table scrolls back');
    const row = shown('near');
    assert.equal(bandsUnder({ x: right - 2, y: row.y + row.h / 2 }).length, 0, 'a band shows');
    // Find steps onto a match in the far column and brings it into view.
    act('do', 'PlaceCaret', { at: offsetOf('below') });
    act('press', { key: 'Mod-f' });
    act('do', 'SetFindQuery', { query: 'zeQbra' });
    await until(() => read('state').editor.find.total === 1, 'find counts the match');
    act('do', 'StepFind', { direction: 1 });
    await until(() => inView(shown('zeQbra')), 'find reveals the match');
    await until(() => bandsUnder(centre(shown('zeQbra'))).length > 0, 'the match is drawn');
    act('do', 'CloseFind');
    assert.match(await saved(noteId), /\| zeQbra \|/);
  }),
);

await appleStory(
  "Cmd+Left and Cmd+Right go to the row's first and last cell, however scrolled",
  () =>
    inScratchNote(async () => {
      pasted(MANY);
      act('do', 'PlaceCaret', { at: offsetOf('d |') });
      act('press', { key: 'Mod-ArrowRight' });
      const end = offsetOf('zebra') + 'zebra '.length;
      assert.deepEqual(selection(), [end, end]);
      await until(() => shown('zebra').x + shown('zebra').w <= column().right, 'End reveals');
      act('press', { key: 'Mod-ArrowLeft' });
      const start = offsetOf('near') - 1;
      assert.deepEqual(selection(), [start, start]);
      await until(() => shown('near').x >= column().left, 'Home reveals');
    }),
);

finish('table wrap stories');

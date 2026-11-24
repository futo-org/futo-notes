// The side of a format's edge the desktop editor's caret is on (caretSide.ts): the side it
// came from, two stops at inline code's edge, drawn inside or outside the code's box, a
// press's side, Shift+Arrow, deletions and the moves that land on an edge. Each story reads
// the selection, the flag (`state.editor.flag`: the formats the next character takes) and,
// at code, the caret's drawn x (`state.editor.caret`, measured even in a background window
// that draws none), then types and reads the saved Markdown.
// `node tests/desktop-editor-caret-side-stories.mjs [filter]` runs the stories whose name
// holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
  pasted,
  read,
  selection,
  story,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

const apple = process.platform === 'darwin';
const caret = () => read('state').editor.caret;
const flag = () => read('state').editor.flag;
const press = (key, count = 1) => act('press', { key, count });
const placeAt = (at) => act('do', 'PlaceCaret', { at });

/** The caret's offset and flag, as one value to compare. */
const where = () => [selection()[0], flag()];

/** The saved note's lines, once every edit is written. */
async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false }).lines.map((line) => line.text);
}

/** Type `text` and check the saved line `index` reads `expected`. */
async function typedReads(noteId, text, index, expected) {
  act('type', { text });
  assert.equal((await saved(noteId))[index], expected);
}

/** The code box holding `text` (padding included), its x in the caret's coordinates. */
function codeBox(text) {
  const shown = read('show', { text }).rect;
  const box = read('at', { x: shown.x + 1, y: shown.y + shown.h / 2 }).stack[0].rect;
  placeAt(0);
  const origin = read('show', { text: read('doc').lines[0].text.slice(0, 1) }).rect.x;
  return { left: box.x - origin + caret().left, right: box.x + box.w - origin + caret().left, box };
}

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} ≠ ${expected}`);

await story('at a bold edge the caret takes the side it came from, one stop a character', () =>
  inScratchNote(async (noteId) => {
    // Display: "x bold y" 0..8: 2 is plain|bold, 6 bold|plain.
    pasted('x **bold** y');
    // A word move is a move past characters: the side it came from.
    placeAt(0);
    press(apple ? 'Alt-ArrowRight' : 'Ctrl-ArrowRight', 2);
    assert.deepEqual(where(), [6, ['B']]);
    press(apple ? 'Alt-ArrowLeft' : 'Ctrl-ArrowLeft');
    assert.deepEqual(where(), [2, ['B']]);
    placeAt(1);
    press('ArrowRight');
    assert.deepEqual(where(), [2, []]);
    press('ArrowRight');
    assert.deepEqual(where(), [3, ['B']]);
    press('ArrowLeft');
    assert.deepEqual(where(), [2, ['B']]);
    press('ArrowLeft');
    assert.deepEqual(where(), [1, []]);
    placeAt(5);
    press('ArrowRight');
    assert.deepEqual(where(), [6, ['B']]);
    await typedReads(noteId, 'Q', 0, 'x **boldQ** y');
    // "x boldQ y" 0..9: from 8 Left passes the space, onto the plain side of 7.
    placeAt(8);
    press('ArrowLeft');
    assert.deepEqual(where(), [7, []]);
    await typedReads(noteId, 'R', 0, 'x **boldQ**R y');
  }),
);

await story('inline code has two stops at each edge, drawn inside and outside its box', () =>
  inScratchNote(async (noteId) => {
    // Display: "a code b" 0..8, "whole" 9..14 (a line that is all code).
    pasted('a `code` b\n`whole`');
    const code = codeBox('code');
    const stops = [];
    placeAt(1);
    for (let index = 0; index < 7; index++) {
      press('ArrowRight');
      stops.push([...where(), caret().left]);
    }
    assert.deepEqual(
      stops.map(([at, marks]) => [at, marks]),
      [
        [2, []],
        [2, ['<>']],
        [3, ['<>']],
        [4, ['<>']],
        [5, ['<>']],
        [6, ['<>']],
        [6, []],
      ],
    );
    near(stops[0][2], code.left, 'outside the start, at the box');
    assert.ok(stops[1][2] >= code.left + 2, `inside the start: ${stops[1][2]}`);
    near(stops[6][2], code.right, 'outside the end, at the box');
    assert.ok(stops[5][2] <= code.right - 2, `inside the end: ${stops[5][2]}`);
    press('ArrowRight');
    assert.deepEqual(where(), [7, []]);
    // Back with Left: outside, inside, then into the code.
    press('ArrowLeft');
    assert.deepEqual(where(), [6, []]);
    press('ArrowLeft');
    assert.deepEqual(where(), [6, ['<>']]);
    press('ArrowLeft');
    assert.deepEqual(where(), [5, ['<>']]);
    // The line that is all code: out of it at its end, into it at its start.
    const whole = codeBox('whole');
    placeAt(13);
    press('ArrowRight');
    assert.deepEqual([...where(), caret().left <= whole.right - 2], [14, ['<>'], true]);
    press('ArrowRight');
    assert.deepEqual(where(), [14, []]);
    near(caret().left, whole.right, 'outside the end of the line');
    await typedReads(noteId, 'Z', 1, '`whole`Z');
    // From the line above's end: outside the code, then inside it.
    placeAt(8);
    press('ArrowRight');
    assert.deepEqual(where(), [9, []]);
    near(caret().left, whole.left, 'outside the start of the line');
    press('ArrowRight');
    assert.deepEqual(where(), [9, ['<>']]);
    assert.ok(caret().left >= whole.left + 2, 'inside the start of the line');
    press('ArrowLeft');
    assert.deepEqual(where(), [9, []]);
    await typedReads(noteId, 'Y', 1, 'Y`whole`Z');
    // From inside the code's start, Left goes outside it first.
    placeAt(3);
    press('ArrowLeft', 2);
    assert.deepEqual(where(), [2, []]);
    await typedReads(noteId, 'W', 0, 'a W`code` b');
  }),
);

await story('a format toggled at a code edge leaves the arrows their stops', () =>
  inScratchNote(async (noteId) => {
    // Display: "a code b" 0..8. Inside the code's end, Code toggled off: the caret would
    // type plain, so it draws outside, and Left still moves into the code.
    pasted('a `code` b');
    placeAt(5);
    press('ArrowRight');
    const inside = caret().left;
    press('Mod-e');
    assert.deepEqual(where(), [6, []]);
    assert.ok(caret().left > inside + 2, 'drawn outside the box');
    press('ArrowLeft');
    assert.deepEqual(where(), [5, ['<>']]);
    // Toggled off again, Right steps outside, then moves on.
    press('ArrowRight');
    press('Mod-e');
    press('ArrowRight');
    assert.deepEqual(where(), [6, []]);
    press('ArrowRight');
    assert.deepEqual(where(), [7, []]);
    await typedReads(noteId, 'X', 0, 'a `code` Xb');
  }),
);

await story("at a soft wrap just before code, both stops draw on the code's row", () =>
  inScratchNote(async () => {
    // The fewest words that push the code onto a second row.
    let words = 10;
    for (; ; words++) {
      act('do', 'Select', { from: 0, to: read('doc').lines[0].end });
      pasted(`${'w '.repeat(words)}\`code\``);
      if (read('show', { text: 'code' }).rect.y > read('show', { text: 'w' }).rect.y + 5) break;
    }
    placeAt(2 * words - 1);
    press('ArrowRight');
    const outside = caret();
    assert.deepEqual(where(), [2 * words, []]);
    press('ArrowRight');
    assert.deepEqual(where(), [2 * words, ['<>']]);
    near(caret().top, outside.top, 'the same row');
    assert.ok(caret().left >= outside.left + 2, 'inside is right of outside');
    placeAt(0);
    assert.ok(outside.top > caret().top + 5, "the code's row is the second");
  }),
);

await story('a press takes the side under the pointer: the code box, padding included', () =>
  inScratchNote(async (noteId) => {
    // Display: "a code b x bold" 0..15 (11 is plain|bold), "all bold" 16..24.
    pasted('a `code` b x **bold**\n**all bold**');
    const code = codeBox('code');
    const { box } = code;
    const y = box.y + box.h / 2;
    act('click', { x: box.x + 1, y });
    assert.deepEqual(where(), [2, ['<>']]);
    assert.ok(caret().left >= code.left + 2, 'inside the box');
    act('click', { x: box.x - 1, y });
    assert.deepEqual(where(), [2, []]);
    near(caret().left, code.left, 'at the box edge');
    act('click', { x: box.x + box.w - 1, y });
    assert.deepEqual(where(), [6, ['<>']]);
    act('click', { x: box.x + box.w + 1, y });
    assert.deepEqual(where(), [6, []]);
    near(caret().left, code.right, 'at the box edge');
    await typedReads(noteId, 'Q', 0, 'a `code`Q b x **bold**');
    // Bold, now 12..16: the left half of its first letter, the right half of the space.
    const bold = read('show', { text: 'bold' }).rect;
    const space = read('show', { text: 'x ' }).rect;
    act('click', { x: bold.x + 1, y });
    assert.deepEqual(where(), [12, ['B']]);
    act('click', { x: space.x + space.w - 1, y });
    assert.deepEqual(where(), [12, []]);
    await typedReads(noteId, 'P', 0, 'a `code`Q b x P**bold**');
    // A line all bold, "all bold" 18..26: off its text on either side the press is outside.
    const all = read('show', { text: 'all bold' }).rect;
    const row = all.y + all.h / 2;
    act('click', { x: all.x + all.w + 20, y: row });
    assert.deepEqual(where(), [26, []]);
    await typedReads(noteId, 'Z', 1, '**all bold**Z');
    act('click', { x: all.x - 3, y: row });
    assert.deepEqual(where(), [18, []]);
    await typedReads(noteId, 'Y', 1, 'Y**all bold**Z');
  }),
);

await story('Shift+Arrow passes a character a press, with no stop for the side', () =>
  inScratchNote(async () => {
    // Display: "a code b" 0..8.
    pasted('a `code` b');
    placeAt(1);
    press('ArrowRight');
    assert.deepEqual(where(), [2, []]);
    press('Shift-ArrowRight');
    assert.deepEqual(selection(), [2, 3]);
    placeAt(5);
    press('ArrowRight');
    assert.deepEqual(where(), [6, ['<>']]);
    press('Shift-ArrowRight');
    assert.deepEqual(selection(), [6, 7]);
    press('Shift-ArrowLeft', 2);
    assert.deepEqual(selection(), [5, 6]);
  }),
);

// The engine's rule today, not the side the caret was on: after Backspace the character
// before the caret supplies the formats, after Delete the one after it.
await story('Backspace and Delete at a code edge leave the side the engine gives', () =>
  inScratchNote(async (noteId) => {
    // Display: "ab cd ef" 0..8: "cd" is code.
    pasted('ab `cd` ef');
    placeAt(5);
    press('ArrowRight');
    assert.deepEqual(where(), [5, []]);
    press('Backspace');
    assert.deepEqual(where(), [4, ['<>']]);
    await typedReads(noteId, 'X', 0, 'ab `cX` ef');
    placeAt(3);
    assert.deepEqual(where(), [3, []]);
    press('Delete');
    assert.deepEqual(where(), [3, ['<>']]);
    await typedReads(noteId, 'Y', 0, 'ab `YX` ef');
  }),
);

await story('Up, Down and the row ends land on the side of the character before', () =>
  inScratchNote(async (noteId) => {
    // Display: "abcdef" 0..6, "abcdef" 7..13 ("cd" bold), "code x" 14..20 ("code" code),
    // "x code" 21..27 ("code" code).
    pasted('abcdef\nab**cd**ef\n`code` x\nx `code`');
    placeAt(2);
    press('ArrowDown');
    assert.deepEqual(where(), [9, []]);
    await typedReads(noteId, 'Q', 1, 'abQ**cd**ef');
    // Now "abQcdef" 7..14, "code x" 15..21, "x code" 22..28. A line's start: its first
    // character's side; its end: the last one's.
    placeAt(20);
    press(apple ? 'Mod-ArrowLeft' : 'Home');
    assert.deepEqual(where(), [15, ['<>']]);
    placeAt(25);
    press(apple ? 'Mod-ArrowRight' : 'End');
    assert.deepEqual(where(), [28, ['<>']]);
    await typedReads(noteId, 'Z', 3, 'x `codeZ`');
  }),
);

finish('desktop editor caret side stories');

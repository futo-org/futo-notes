// A list item's marker as one unit of the text (blocks.md, portable-core/lists.md): a real
// element holding the unit's character (atomElements.ts), selected whole by a click, a drag or
// Shift+arrow, highlighted over its box, and acting as its Markdown when typed over, deleted
// or copied. `doc`'s `at` for an item is before its marker; its text starts one offset on.
// `node tests/desktop-editor-marker-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  appleStory,
  finish,
  inNewNote,
  pasted,
  read,
  selection,
  story,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

/** The first line whose text is `text`, with `start`, where its text starts (after a marker). */
function lineOf(text) {
  const line = read('doc').lines.find((entry) => entry.text === text);
  assert.ok(line, `no line "${text}"`);
  return { ...line, start: line.end - line.text.length };
}

const kinds = () => read('doc').lines.map((line) => [line.kind, line.text]);

async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

/** A point on the row of `text`, `gap` px left of the right edge of the marker drawn just
 *  left of its first character (the marker's box ends 0.35em, about 6 px, before the text). */
function besideMarker(text, gap) {
  const rect = read('show', { text }).rect;
  return { x: rect.x - 6 - gap, y: rect.y + rect.h / 2 };
}

/** The highlight's bands under viewport `x`, `y` (they pass the pointer through). */
const bandsUnder = (point) =>
  read('at', point).stack.filter((entry) => entry.flags.includes('passes') && entry.rect.h < 100);

/** The selection's band over the marker before `text`: from the marker's left edge up to the
 *  item's text start, with no gap before the text. */
function assertMarkerBand(text, onMarker) {
  const [band] = bandsUnder(onMarker);
  assert.ok(band, 'the selected marker is not highlighted');
  const start = read('show', { text }).rect.x;
  const right = band.rect.x + band.rect.w;
  assert.ok(Math.abs(right - start) <= 1, `band ends at ${right}, the text starts at ${start}`);
  assert.ok(band.rect.x < onMarker.x, `band ${JSON.stringify(band.rect)}`);
}

await story('a click on a marker places the caret on its nearer side and selects nothing', () =>
  inNewNote(async () => {
    pasted('9. nine\n10. ten\n- dot');
    const ten = lineOf('ten');
    act('click', besideMarker('ten', 30));
    assert.deepEqual(selection(), [ten.at, ten.at], 'left of the number');
    act('click', besideMarker('ten', 16));
    assert.deepEqual(selection(), [ten.at, ten.at], "the number's left half");
    act('click', besideMarker('ten', 3));
    assert.deepEqual(selection(), [ten.start, ten.start], "the number's right half");
    const dot = lineOf('dot');
    act('click', besideMarker('dot', 8));
    assert.deepEqual(selection(), [dot.at, dot.at], "the dot's left half");
    act('click', besideMarker('dot', 2));
    assert.deepEqual(selection(), [dot.start, dot.start], "the dot's right half");
  }),
);

await story(
  'a double click on a marker selects it, highlighted to the text; a triple its line',
  () =>
    inNewNote(async () => {
      pasted('9. nine\n10. ten\n- dot');
      const ten = lineOf('ten');
      const onTen = besideMarker('ten', 10);
      act('click', { ...onTen, count: 2 });
      assert.deepEqual(selection(), [ten.at, ten.start]);
      assertMarkerBand('ten', onTen);
      const dot = lineOf('dot');
      act('click', { ...besideMarker('dot', 4), count: 3 });
      assert.deepEqual(selection(), [dot.at, dot.end]);
    }),
);

await story('a press on a marker and a drag selects from the side pressed', () =>
  inNewNote(async () => {
    pasted('intro\n10. ten things');
    const ten = lineOf('ten things');
    const word = read('show', { text: 'things' }).rect;
    const end = { x2: word.x + word.w - 1, y2: word.y + word.h / 2 };
    const left = besideMarker('ten things', 16);
    act('drag', { ...left, ...end });
    assert.deepEqual(selection(), [ten.at, ten.end]);
    // One band, from the marker's left edge through the text.
    const [band] = bandsUnder(left);
    assert.ok(band && band.rect.x < left.x, `band ${JSON.stringify(band?.rect)}`);
    assert.ok(band.rect.x + band.rect.w >= end.x2, `band ${JSON.stringify(band.rect)}`);
    // A press on selected text would drag the text: start from a caret.
    act('do', 'PlaceCaret', { at: 0 });
    act('drag', { ...besideMarker('ten things', 3), ...end });
    assert.deepEqual(selection(), [ten.start, ten.end]);
  }),
);

await story('a double click on a checkbox toggles it once and selects nothing', () =>
  inNewNote(async () => {
    pasted('- [ ] task\nbelow');
    act('do', 'PlaceCaret', { at: lineOf('below').end });
    const caret = selection();
    const box = read('elements').elements.find((element) => element.role === 'checkbox');
    act('click', { ref: box.ref, count: 2 });
    assert.deepEqual(kinds()[0], ['task ☑', 'task']);
    assert.deepEqual(selection(), caret);
  }),
);

await story(
  'ticking a box leaves a caret before a marker, and a selected marker, as they were',
  () =>
    inNewNote(async () => {
      pasted('- [ ] one\n- [ ] two');
      const two = lineOf('two');
      const boxes = () =>
        read('elements').elements.filter((element) => element.role === 'checkbox');
      act('do', 'PlaceCaret', { at: two.at });
      act('click', { ref: boxes()[1].ref });
      assert.deepEqual(kinds()[1], ['task ☑', 'two']);
      assert.deepEqual(selection(), [two.at, two.at]);
      act('do', 'Select', { from: two.at, to: two.start });
      act('click', { ref: boxes()[0].ref });
      assert.deepEqual(kinds()[0], ['task ☑', 'one']);
      assert.deepEqual(selection(), [two.at, two.start]);
    }),
);

await story('typing 5. over a selected 10. changes the number', () =>
  inNewNote(async (noteId) => {
    pasted('10. ten');
    const ten = lineOf('ten');
    act('do', 'Select', { from: ten.at, to: ten.start });
    act('type', { text: '5. ' });
    assert.deepEqual(kinds()[0], ['5.', 'ten']);
    assert.equal(await saved(noteId), '5. ten');
  }),
);

await story('Backspace right after a marker takes it off, and the line stays', () =>
  inNewNote(async (noteId) => {
    pasted('- a\n- b');
    act('do', 'PlaceCaret', { at: lineOf('b').start });
    act('press', { key: 'Backspace' });
    assert.deepEqual(kinds(), [
      ['bullet', 'a'],
      ['paragraph', 'b'],
    ]);
    assert.equal(await saved(noteId), '- a\nb');
  }),
);

await story('Backspace on an empty item and Delete before a marker take the marker off', () =>
  inNewNote(async (noteId) => {
    pasted('a\n- \n- b');
    act('do', 'PlaceCaret', { at: read('doc').lines[1].end });
    act('press', { key: 'Backspace' });
    act('do', 'PlaceCaret', { at: lineOf('b').at });
    act('press', { key: 'Delete' });
    assert.deepEqual(kinds(), [
      ['paragraph', 'a'],
      ['gap', ''],
      ['paragraph', 'b'],
    ]);
    assert.equal(await saved(noteId), 'a\n\nb');
  }),
);

await story("typing at an item's text start types into the item", () =>
  inNewNote(async (noteId) => {
    pasted('- **a**');
    act('click', besideMarker('a', -7));
    assert.deepEqual(selection(), [lineOf('a').start, lineOf('a').start]);
    act('type', { text: 'z' });
    assert.deepEqual(kinds(), [['bullet', 'za']]);
    assert.equal(await saved(noteId), '- **za**');
  }),
);

await appleStory("Cmd+Left and Cmd+Backspace keep to an item's text, its marker staying", () =>
  inNewNote(async (noteId) => {
    pasted('- abc def');
    const item = lineOf('abc def');
    act('do', 'PlaceCaret', { at: item.end - 2 });
    act('press', { key: 'Mod-ArrowLeft' });
    assert.deepEqual(selection(), [item.start, item.start]);
    act('do', 'PlaceCaret', { at: item.end - 3 });
    act('press', { key: 'Mod-Backspace' });
    assert.deepEqual(kinds(), [['bullet', 'def']]);
    assert.equal(await saved(noteId), '- def');
  }),
);

await story('a triple click on an item selects its whole line, and typing replaces it', () =>
  inNewNote(async (noteId) => {
    pasted('intro\n- milk and eggs\n10. ten things');
    const milk = lineOf('milk and eggs');
    act('click', { text: 'milk', count: 3 });
    assert.deepEqual(selection(), [milk.at, milk.end]);
    act('type', { text: 'tea' });
    assert.deepEqual(kinds()[1], ['paragraph', 'tea']);
    const ten = lineOf('ten things');
    act('click', { text: 'things', count: 3 });
    assert.deepEqual(selection(), [ten.at, ten.end]);
    act('type', { text: 'x' });
    assert.equal(await saved(noteId), 'intro\ntea\nx');
  }),
);

await story('typing before a marker makes the line plain text', () =>
  inNewNote(async (noteId) => {
    pasted('1. a');
    act('do', 'PlaceCaret', { at: lineOf('a').at });
    act('type', { text: 'x' });
    assert.deepEqual(kinds(), [['paragraph', 'x1. a']]);
    assert.equal(await saved(noteId), 'x1. a');
  }),
);

await story('Shift+Arrow across a marker takes it whole', () =>
  inNewNote(async () => {
    pasted('above\n- item');
    const item = lineOf('item');
    act('do', 'PlaceCaret', { at: item.start });
    act('press', { key: 'Shift-ArrowLeft' });
    assert.deepEqual(selection(), [item.at, item.start]);
    act('press', { key: 'Shift-ArrowLeft' });
    assert.deepEqual(selection(), [item.at - 1, item.start]);
    act('do', 'PlaceCaret', { at: item.at });
    act('press', { key: 'Shift-ArrowRight' });
    assert.deepEqual(selection(), [item.at, item.start]);
  }),
);

await story('a drag onto a marker takes it whole', () =>
  inNewNote(async () => {
    pasted('- item text');
    const item = lineOf('item text');
    const word = read('show', { text: 'text' }).rect;
    // The marker's left half: past it, the drag takes it.
    const marker = besideMarker('item text', 8);
    act('drag', { x: word.x + 2, y: word.y + word.h / 2, x2: marker.x, y2: marker.y });
    const [from, to] = selection();
    assert.deepEqual([from, to], [item.at, item.start + 'item '.length]);
  }),
);

await story('a copy of a selected marker is its Markdown', () =>
  inNewNote(async () => {
    pasted('10. ten\n- [ ] task');
    const ten = lineOf('ten');
    act('do', 'Select', { from: ten.at, to: ten.start });
    act('do', 'Copy');
    assert.equal(read('clipboard').clipboard.text, '10. ');
    const task = lineOf('task');
    act('do', 'Select', { from: task.at, to: task.start });
    act('do', 'Copy');
    assert.equal(read('clipboard').clipboard.text, '- [ ] ');
  }),
);

await story("Left from an item's text start stops before its marker, then the line above", () =>
  inNewNote(async () => {
    pasted('above\n12. item');
    const item = lineOf('item');
    act('do', 'PlaceCaret', { at: item.start });
    const textCaret = read('state').editor.caret;
    act('press', { key: 'ArrowLeft' });
    assert.deepEqual(selection(), [item.at, item.at]);
    // Drawn at the marker's left edge, on the item's row, as tall as at its text.
    const markerCaret = read('state').editor.caret;
    assert.ok(markerCaret.left < textCaret.left - 10, `caret at ${markerCaret.left}`);
    assert.equal(Math.round(markerCaret.top), Math.round(textCaret.top));
    assert.equal(Math.round(markerCaret.height), Math.round(textCaret.height));
    act('press', { key: 'ArrowLeft' });
    assert.deepEqual(selection(), [lineOf('above').end, lineOf('above').end]);
    act('press', { key: 'ArrowRight' });
    assert.deepEqual(selection(), [item.at, item.at]);
    act('press', { key: 'ArrowRight' });
    assert.deepEqual(selection(), [item.start, item.start]);
  }),
);

finish('desktop editor marker stories');

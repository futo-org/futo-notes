// The desktop editor's inline formats (bold, italic, strike, inline code): the caret and a
// selection across a format's edge, read back through `show {"text"}`'s `formats`, which come
// from the page; the format shortcuts, the selection toolbar, the caret's flag
// (`state.editor.flag`) and the side a caret at a format's edge joins. Formatted text comes
// in through Paste or the shortcuts; typed markers pair (desktop-editor-pairing-stories.mjs).
// How the formats draw in body text and headings, and a heading's rows:
// desktop-editor-heading-stories.mjs.
// `node tests/desktop-editor-format-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  assertNear,
  finish,
  FORMATS_NOTE,
  inScratchNote,
  lineAndBandsAt,
  lines,
  pasted,
  read,
  rowMiddleOf,
  selection,
  SHIFTED_FORMAT_KEY,
  shownText,
  story,
  until,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

const before = (text) => ({ x: shownText(text).rect.x + 1, y: rowMiddleOf(text) });
const caretAt = (at) => {
  act('do', 'PlaceCaret', { at });
  return read('state').editor.caret;
};

await story('the caret stands at the insertion point, a row tall, in every format', () =>
  inScratchNote(async () => {
    pasted(FORMATS_NOTE);
    const lineStart = caretAt(23);
    const originX = shownText('plain').rect.x - lineStart.left;
    // Each word's start, a point inside it (after `prefix`) and, but for code, whose padding
    // follows it, its end. A placed caret at code's start is outside its box, at the box's edge.
    for (const [word, at, prefix] of [
      ['bold', 29, 'bo'],
      ['ital', 34, 'it'],
      ['code', 44, 'co'],
      ['both', 53, 'bot'],
    ]) {
      const rect = shownText(word).rect;
      const inside = shownText(prefix).rect;
      const start =
        word === 'code'
          ? read('at', { x: rect.x + 1, y: rowMiddleOf(word) }).stack[0].rect.x
          : rect.x;
      for (const [offset, x] of [
        [at, start],
        [at + prefix.length, inside.x + inside.w],
        ...(word === 'code' ? [] : [[at + word.length, rect.x + rect.w]]),
      ]) {
        const caret = caretAt(offset);
        assertNear(caret.left + originX, x, `the caret's x at ${offset} in "${word}"`);
        assertNear(caret.top, lineStart.top, `the caret's top at ${offset}`);
        assertNear(caret.height, lineStart.height, `the caret's height at ${offset}`);
      }
    }
    // In a heading, as tall as the heading's text beside the code.
    const heading = caretAt(2);
    for (const at of [9, 19, 22]) {
      assertNear(caretAt(at).height, heading.height, `the heading caret's height at ${at}`);
      assertNear(caretAt(at).top, heading.top, `the heading caret's top at ${at}`);
    }
  }),
);

await story('a selection across format edges is one band per row', () =>
  inScratchNote(async () => {
    pasted(FORMATS_NOTE);
    // From inside "plain" to inside "code": plain, bold, italic, strike and code text.
    act('do', 'Select', { from: 25, to: 46 });
    const y = rowMiddleOf('plain');
    const bands = new Set();
    for (const word of ['ain', 'bold', 'ital', 'gone']) {
      const rect = shownText(word).rect;
      for (const x of [rect.x + 1, rect.x + rect.w / 2, rect.x + rect.w - 1]) {
        const found = lineAndBandsAt(x, y).bands;
        assert.equal(found.length, 1, `one band under "${word}" at x ${x}`);
        bands.add(found[0]);
      }
    }
    assert.equal(bands.size, 1, `the row's bands: ${[...bands].join(' ')}`);
    const band = JSON.parse([...bands][0]);
    assertNear(band.x, shownText('ain').rect.x, "the band's left edge");
  }),
);

await story('a click, double and triple click, Shift+click and a drag land the same', () =>
  inScratchNote(async () => {
    // "x unbolded y": the word crosses a format's edge.
    pasted(`${FORMATS_NOTE}\nx un**bold**ed *y*`);
    act('click', before('ital'));
    assert.deepEqual(selection(), [34, 34]);
    act('click', before('code'));
    assert.deepEqual(selection(), [44, 44]);
    act('click', { text: 'bold', count: 2 });
    assert.deepEqual(selection(), [29, 33]);
    act('click', { text: 'ital', count: 3 });
    assert.deepEqual(selection(), [23, 61]);
    act('click', before('bold'));
    act('click', { ...before('both'), shift: true });
    assert.deepEqual(selection(), [29, 53]);
    // A drag from unselected text (a press on selected text would move it).
    act('click', before('a plain'));
    const ital = before('ital');
    const both = before('both');
    act('drag', { x: ital.x, y: ital.y, x2: both.x, y2: both.y });
    assert.deepEqual(selection(), [34, 53]);
    // The engine's word, across the edge. Last: the selection toolbar above this word reaches
    // up over the lines above.
    act('click', { text: 'unbolded', count: 2 });
    assert.deepEqual(selection(), [77, 85]);
  }),
);

await story('Up and Down keep the column, and a row end stays at a wrap on a format edge', () =>
  inScratchNote(async () => {
    // Every other word bold: a soft wrap lands between a plain space and a bold word.
    const words = Array.from({ length: 40 }, (_, index) =>
      index % 2 ? `p${index}` : `**w${index}**`,
    ).join(' ');
    pasted(`plain **bold** *ital*\nab\nplain **bold** *ital*\n${words}`);
    act('click', before('ital'));
    assert.deepEqual(selection(), [11, 11]);
    act('press', { key: 'ArrowDown' });
    assert.deepEqual(selection(), [18, 18]);
    act('press', { key: 'ArrowDown' });
    assert.deepEqual(selection(), [30, 30]);
    // Right of the wrapped line's first row: the caret on that row, and Cmd+Right keeps it.
    const box = read('elements').elements.find(
      (element) => element.component === 'DesktopEditor.svelte',
    ).rect;
    act('click', before('w0'));
    const row = read('state').editor.caret.top;
    act('click', { x: box.x + box.w - 4, y: rowMiddleOf('w0') });
    assertNear(read('state').editor.caret.top, row, 'right of the first row');
    const rowEnd = selection()[0];
    act('click', before('w0'));
    act('press', { key: process.platform === 'darwin' ? 'Mod-ArrowRight' : 'End' });
    assertNear(read('state').editor.caret.top, row, 'Cmd+Right on the first row');
    assert.deepEqual(selection(), [rowEnd, rowEnd]);
  }),
);

await story('typing, deleting, pasting, Undo and a moved run keep the formats', () =>
  inScratchNote(async (noteId) => {
    pasted(FORMATS_NOTE);
    act('do', 'PlaceCaret', { at: 31 });
    act('type', { text: 'XY' });
    assert.deepEqual(shownText('boXYld').formats, ['bold']);
    act('press', { key: 'Backspace' });
    assert.deepEqual(shownText('boXld').formats, ['bold']);
    act('clipboard', { text: 'Z' });
    act('do', 'Paste');
    assert.deepEqual(shownText('boXZld').formats, ['bold']);
    await untilIdle();
    assert.equal(
      read('file', { noteId, save: false }).lines[1].text,
      'plain **boXZld** *ital* ~~gone~~ `code` and ***both*** end',
    );
    act('press', { key: 'Mod-z' });
    act('press', { key: 'Mod-z' });
    act('press', { key: 'Mod-z' });
    assert.deepEqual(shownText('bold').formats, ['bold']);
    act('press', { key: 'Shift-Mod-z' });
    assert.deepEqual(shownText('boXYld').formats, ['bold']);
    // Dragged to the end of the line, the italic word stays italic.
    act('click', { text: 'ital', count: 2 });
    const ital = shownText('ital').rect;
    const end = shownText(' end').rect;
    act('drag', {
      x: ital.x + ital.w / 2,
      y: rowMiddleOf('ital'),
      x2: end.x + end.w + 1,
      y2: rowMiddleOf('end'),
    });
    assert.deepEqual(shownText('ital').formats, ['italic']);
    assert.deepEqual(shownText('gone').formats, ['strike']);
  }),
);

const formatsOf = (text) => shownText(text).formats;
const flag = () => read('state').editor.flag;
const saved = async (noteId) => {
  await untilIdle();
  return read('file', { noteId, save: false }).lines.map((line) => line.text);
};

await story('the format shortcuts toggle a selection, and at a caret what is typed next', () =>
  inScratchNote(async (noteId) => {
    // Display: "one two three four" 0..18, "five code six" 19..32.
    pasted('one two three four\nfive `code` six');
    act('do', 'Select', { from: 4, to: 7 });
    act('press', { key: 'Mod-b' });
    assert.deepEqual(formatsOf('two'), ['bold']);
    assert.deepEqual(selection(), [4, 7]);
    act('press', { key: 'Mod-i' });
    assert.deepEqual(formatsOf('two'), ['bold+italic']);
    // On again is off.
    act('press', { key: 'Mod-b' });
    assert.deepEqual(formatsOf('two'), ['italic']);
    // Real keys: Option turns X into ≈, and the key's place still names the shortcut.
    act('do', 'Select', { from: 8, to: 13 });
    act('press', { key: 'Mod-Alt-x' });
    assert.deepEqual(formatsOf('three'), ['strike']);
    act('do', 'Select', { from: 14, to: 18 });
    act('press', { key: 'Mod-e' });
    assert.deepEqual(formatsOf('four'), ['code']);
    // Held with Shift it is no shortcut.
    act('do', 'Select', { from: 0, to: 3 });
    act('press', { key: SHIFTED_FORMAT_KEY });
    assert.deepEqual(formatsOf('one'), ['plain']);
    // Inside inline code no other format applies.
    act('do', 'Select', { from: 25, to: 27 });
    act('press', { key: 'Mod-b' });
    assert.deepEqual(formatsOf('code'), ['code']);
    // At a caret: the next character, nothing written before it; a move drops it.
    const before = await saved(noteId);
    act('do', 'PlaceCaret', { at: 3 });
    act('press', { key: 'Mod-b' });
    assert.deepEqual(flag(), ['B']);
    assert.deepEqual(await saved(noteId), before);
    act('type', { text: 'X' });
    assert.deepEqual(formatsOf('oneX'), ['plain', 'bold']);
    act('do', 'PlaceCaret', { at: 0 });
    act('press', { key: 'Mod-i' });
    assert.deepEqual(flag(), ['I']);
    act('do', 'PlaceCaret', { at: 1 });
    assert.deepEqual(flag(), []);
    act('type', { text: 'Y' });
    assert.deepEqual(formatsOf('oYne'), ['plain']);
    // Headings by level, and back to body text.
    act('press', { key: 'Mod-Alt-2' });
    assert.equal(lines()[0][0], 'heading2');
    act('press', { key: 'Mod-Alt-0' });
    assert.equal(lines()[0][0], 'paragraph');
    assert.deepEqual(await saved(noteId), ['oYne**X** *two* ~~three~~ `four`', 'five `code` six']);
  }),
);

const toolbarButtons = () =>
  read('elements').elements.filter((element) => element.component === 'FormatToolbar.svelte');
/** The shown toolbar's buttons: each one's label and whether it is lit or disabled. */
const toolbar = async () =>
  Object.fromEntries(
    (await until(() => toolbarButtons().length > 0 && toolbarButtons(), 'the toolbar shows')).map(
      (button) => [
        button.text,
        button.flags.filter((flag) => flag === 'pressed' || flag === 'disabled').join(),
      ],
    ),
  );
const button = (text) => ({ ref: toolbarButtons().find((found) => found.text === text).ref });
/** The block buttons, unlit on these plain lines (tests/desktop-editor-toolbar-stories.mjs). */
const BLOCKS = { 'Heading 1': '', 'Heading 2': '', 'Heading 3': '', 'Block quote': '' };

await story('the selection toolbar lights what all the selection has and keeps the selection', () =>
  inScratchNote(async () => {
    // Display: "plain bold ital code end" 0..24, "   " 25..28.
    pasted('plain **bold** *ital* `code` end\n   ');
    act('do', 'Select', { from: 6, to: 10 });
    assert.deepEqual(await toolbar(), {
      ...BLOCKS,
      Bold: 'pressed',
      Italic: '',
      Strikethrough: '',
      Code: '',
      Link: '',
    });
    // Above the selected row, never over it.
    const bar = toolbarButtons()[0].rect;
    assert.ok(bar.y + bar.h <= shownText('bold').rect.y, 'the toolbar is above the selection');
    act('do', 'Select', { from: 17, to: 19 });
    assert.deepEqual(await toolbar(), {
      ...BLOCKS,
      Bold: 'disabled',
      Italic: 'disabled',
      Strikethrough: 'disabled',
      Code: 'pressed',
      Link: '',
    });
    // A mixed selection is unlit; a real click makes all of it bold and keeps the selection.
    act('do', 'Select', { from: 0, to: 10 });
    assert.deepEqual(await toolbar(), {
      ...BLOCKS,
      Bold: '',
      Italic: '',
      Strikethrough: '',
      Code: '',
      Link: '',
    });
    act('click', button('Bold'));
    assert.deepEqual(formatsOf('plain bold'), ['bold']);
    assert.deepEqual(selection(), [0, 10]);
    assert.equal(read('state').editor.focused, true);
    await until(
      () =>
        (toolbarButtons().find((found) => found.text === 'Bold')?.flags ?? []).includes('pressed'),
      'Bold lights',
    );
    // A lit button turns its format off.
    act('click', button('Bold'));
    assert.deepEqual(formatsOf('plain bold'), ['plain']);
    assert.deepEqual(selection(), [0, 10]);
    // None for a caret, or for a selection of only whitespace.
    act('do', 'PlaceCaret', { at: 3 });
    await until(() => toolbarButtons().length === 0, 'the toolbar hides at a caret');
    act('do', 'Select', { from: 24, to: 28 });
    await until(() => toolbarButtons().length === 0, 'the toolbar hides for whitespace');
  }),
);

await story(
  'a format the engine says would change nothing is disabled, and a click does nothing',
  () =>
    inScratchNote(async (noteId) => {
      // Display: "Plain text, then sadasdasdasdbold, then plain.", the bold "asdasdbold" at
      // 23..33 starting mid-word: no spelling opens a strike there.
      const source = 'Plain text, then sadasd**asdasdbold**, then plain.';
      pasted(source);
      act('do', 'Select', { from: 23, to: 33 });
      assert.equal((await toolbar()).Strikethrough, 'disabled');
      act('click', button('Strikethrough'));
      await untilIdle();
      assert.equal(read('file', { noteId }).lines[0].text, source);
      // Over the whole word it is enabled and strikes it.
      act('do', 'Select', { from: 17, to: 33 });
      await until(() => {
        const strike = toolbarButtons().find((found) => found.text === 'Strikethrough');
        return strike && !strike.flags.includes('disabled');
      }, 'Strikethrough enabled');
      act('click', button('Strikethrough'));
      await untilIdle();
      assert.match(read('file', { noteId }).lines[0].text, /~~/);
    }),
);

/** Choose an item of the debug section of the note's ⋮ menu (development builds). */
async function debugItem(label) {
  // `elements` shortens a long label with an ellipsis.
  const find = (text) =>
    read('elements').elements.find(
      (element) => element.text && text.startsWith(element.text.replace(/…$/, '')),
    );
  if (!find(label)) act('click', { ref: find('Note options').ref });
  act('click', { ref: (await until(() => find(label), `"${label}" in the menu`)).ref });
}

await story('the caret flag shows the heading level and the formats typed next', () =>
  inScratchNote(async () => {
    // Display: "Head big" 0..8, "x bold both code" 9..25.
    pasted('# Head **big**\nx **bold** ***both*** `code`');
    for (const [at, marks] of [
      [2, ['H1']],
      [6, ['H1', 'B']],
      [10, []],
      [13, ['B']],
      [18, ['B', 'I']],
      [23, ['<>']],
    ]) {
      act('do', 'PlaceCaret', { at });
      assert.deepEqual(flag(), marks, `the flag at ${at}`);
    }
    act('do', 'PlaceCaret', { at: 10 });
    act('press', { key: 'Mod-Alt-x' });
    assert.deepEqual(flag(), ['S']);
    // A selection has no flag.
    act('do', 'Select', { from: 11, to: 15 });
    assert.deepEqual(flag(), []);
    // The debug toggle hides it from an edit until the caret moves.
    await debugItem('Hide the flag while typing');
    try {
      act('do', 'PlaceCaret', { at: 13 });
      act('type', { text: 'z' });
      assert.deepEqual(flag(), []);
      act('do', 'PlaceCaret', { at: 12 });
      assert.deepEqual(flag(), ['B']);
    } finally {
      await debugItem('Hide the flag while typing');
    }
  }),
);

await story('a caret at a format edge joins the side the debug toggle says', () =>
  inScratchNote(async () => {
    // Display: "x bold y" 0..8: 2 is plain|bold, 6 is bold|plain.
    pasted('x **bold** y');
    const at = (offset) => {
      act('do', 'PlaceCaret', { at: offset });
      return flag();
    };
    try {
      // A placed caret lands: the character before supplies the formats, at a line's start the
      // first one (tests/desktop-editor-caret-side-stories.mjs has the rest of this rule).
      assert.deepEqual([at(0), at(2), at(6)], [[], [], ['B']]);
      await debugItem('more formatting');
      assert.deepEqual([at(0), at(2), at(6)], [[], ['B'], ['B']]);
      // What the flag says is what is typed: on both edges, the bold side.
      at(2);
      act('type', { text: 'P' });
      at(7);
      act('type', { text: 'Q' });
      assert.deepEqual(formatsOf('x PboldQ y'), ['plain', 'bold', 'plain']);
      await debugItem('always left');
      assert.deepEqual([at(8), at(2)], [['B'], []]);
      act('type', { text: 'L' });
      assert.deepEqual(formatsOf('x LPboldQ'), ['plain', 'bold']);
      // "x LPboldQ y": 3 is plain|bold, 9 bold|plain.
      await debugItem('always right');
      assert.deepEqual([at(0), at(3), at(9)], [[], ['B'], []]);
    } finally {
      await debugItem('the side it came from');
    }
  }),
);

finish('desktop editor format stories');

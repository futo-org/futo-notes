// The desktop editor's fenced code blocks: drawn from the engine's block descriptions as cards
// (desktopCodeBlocks.css), read back through `doc`'s kinds; a block as one object, selected by a
// press on its header or by Backspace after it, its card filled and no caret or toolbar drawn
// (state's `selection.block`); the arrows, Mod+Enter and presses that leave it or open a line
// beside it (codeBlockKeys.ts, codeBlockPress.ts). Content comes in through Paste.
// `node tests/desktop-editor-code-block-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
  pasted,
  pastedEndingWithBlock,
  read,
  SELECT_TO_NOTE_END_KEY,
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

/** The first line whose text is `text`. */
const lineOf = (text) => read('doc').lines.find((line) => line.text === text);
const endOf = (text) => lineOf(text).end;
const startOf = (text) => lineOf(text).at;

/** The selection as [from, to], and whether it is a code block selected as one object. */
function selected() {
  const editor = read('state').editor;
  assert.equal(editor.error, undefined);
  return [editor.selection.from, editor.selection.to, !!editor.selection.block];
}

/** A real click on the header above the code line whose text is `text`. */
function clickHeaderAbove(text) {
  const code = read('show', { text }).rect;
  // The header is right above the block's first line, past its name field.
  act('click', { x: code.x + 40, y: code.y - 12 });
}

const toolbarButtons = () =>
  read('elements').elements.filter((element) => element.component === 'FormatToolbar.svelte');

const BLOCK = 'above\n```js\nlet alpha = 1\nlet beta = 2\n```\nbelow';

await story(
  'fenced code reads as code, and adjacent blocks are two cards, each under a header',
  () =>
    inScratchNote(async () => {
      pasted('p\n```js name:a.js\nx\ny\n```\n```py\nz\n```\nq');
      assert.deepEqual(kinds(), [
        ['paragraph', 'p'],
        ['code js', 'x'],
        ['code js', 'y'],
        ['code py', 'z'],
        ['paragraph', 'q'],
      ]);
      const top = (text) => read('show', { text }).rect.y;
      // Within a block, one line unit a line; between two, the first's 10px skirt, the 4px gap
      // and the second's 27px header.
      assert.equal(top('y') - top('x'), 24);
      assert.equal(top('z') - top('y'), 24 + 10 + 4 + 27, 'the blocks are not 4px apart');
    }),
);

await story("a code line's caret is a paragraph's height; a heading's keeps its own", () =>
  inScratchNote(async () => {
    pasted(`para\n# Heading\n\`\`\`js\nlet a\n\nlet b ${'x'.repeat(200)}\n\`\`\`\nend`);
    const caretAt = (at) => {
      act('do', 'PlaceCaret', { at });
      return read('state').editor.caret.height;
    };
    const paragraph = caretAt(startOf('para') + 2);
    assert.ok(caretAt(startOf('Heading') + 2) > paragraph + 4, 'the heading caret shrank');
    const wrapped = lineOf(`let b ${'x'.repeat(200)}`);
    const empty = read('doc').lines.find((line) => line.kind.startsWith('code') && !line.text);
    for (const [where, at] of [
      ['in a code line', startOf('let a') + 2],
      ['at its end', endOf('let a')],
      ['on an empty code line', empty.at],
      ["on a wrapped line's last row", wrapped.end - 2],
    ]) {
      const height = caretAt(at);
      assert.ok(
        Math.abs(height - paragraph) <= 1,
        `${where}: ${height}px, a paragraph's ${paragraph}px`,
      );
    }
  }),
);

await story(
  'Enter inside a code block keeps the lines below it code, as the engine reads them',
  () =>
    inScratchNote(async () => {
      pasted('```sh\na\nb\nc\n```\nend');
      act('do', 'PlaceCaret', { at: endOf('a') });
      act('press', { key: 'Enter' });
      act('type', { text: 'new' });
      // `selection()` fails on Puppet's drift error, which compares the page with the engine.
      selection();
      assert.deepEqual(kinds(), [
        ['code sh', 'a'],
        ['code sh', 'new'],
        ['code sh', 'b'],
        ['code sh', 'c'],
        ['paragraph', 'end'],
      ]);
    }),
);

await story("a copied code line is its text alone, not its block's header or number", () =>
  inScratchNote(async () => {
    pasted('```js name:a.js\nlet a\n```\nafter');
    act('do', 'Select', { from: startOf('let a'), to: endOf('let a') });
    act('do', 'Copy');
    assert.equal(read('clipboard').clipboard.text, 'let a');
  }),
);

await story('a typed backtick pairs, steps out of code, and the third makes a block', () =>
  inScratchNote(async (noteId) => {
    const type = (keys) => act('type', { text: keys });
    const flag = () => read('state').editor.flag;
    type('foo `');
    assert.equal(await saved(noteId), 'foo ``');
    // Backspace between the empty pair takes both.
    act('press', { key: 'Backspace' });
    assert.equal(await saved(noteId), 'foo ');
    type('`');
    assert.equal(await saved(noteId), 'foo ``');
    type('bar');
    assert.deepEqual([await saved(noteId), flag()], ['foo `bar`', ['<>']]);
    // The closing backtick is already there: the key only takes the caret out of the code.
    type('`');
    assert.deepEqual([await saved(noteId), flag()], ['foo `bar`', []]);
    type(' baz');
    assert.equal(await saved(noteId), 'foo `bar` baz');
    act('press', { key: 'Enter' });
    type('``');
    assert.equal(await saved(noteId), 'foo `bar` baz\n``');
    type('`');
    assert.equal(await saved(noteId), 'foo `bar` baz\n```\n```');
    // The caret is at the opening fence's end: letters write the language, Enter the code.
    type('js');
    act('press', { key: 'Enter' });
    type('let a');
    assert.equal(await saved(noteId), 'foo `bar` baz\n```js\nlet a\n```');
    assert.deepEqual(kinds(), [
      ['paragraph', 'foo bar baz'],
      ['code js', 'let a'],
    ]);
    // In a code block a backtick is only a backtick.
    type('`');
    assert.equal(await saved(noteId), 'foo `bar` baz\n```js\nlet a`\n```');
  }),
);

await story(
  'a click on a block header selects the block, Backspace deletes it, Undo restores it',
  () =>
    inScratchNote(async (noteId) => {
      pasted(BLOCK);
      clickHeaderAbove('let alpha = 1');
      assert.deepEqual(selected(), [startOf('let alpha = 1'), endOf('let beta = 2'), true]);
      assert.equal(read('state').editor.caret, null, 'a caret drawn on the selected block');
      act('press', { key: 'Backspace' });
      assert.deepEqual(kinds(), [
        ['paragraph', 'above'],
        ['gap', ''],
        ['paragraph', 'below'],
      ]);
      assert.equal(await saved(noteId), 'above\n\nbelow');
      // Undo brings the block back selected, from the edit's own view change.
      act('press', { key: 'Mod-z' });
      assert.deepEqual(selected(), [startOf('let alpha = 1'), endOf('let beta = 2'), true]);
      assert.equal(read('state').editor.caret, null, 'a caret drawn on the restored block');
    }),
);

await story('Backspace after a block selects it, no toolbar shown, and the next deletes it', () =>
  inScratchNote(async () => {
    pasted(BLOCK);
    act('do', 'PlaceCaret', { at: startOf('below') });
    act('press', { key: 'Backspace' });
    assert.deepEqual(selected(), [startOf('let alpha = 1'), endOf('let beta = 2'), true]);
    // A selection reaching into the code shows the toolbar: the frame that would draw it ran.
    act('do', 'Select', { from: endOf('below'), to: startOf('let beta = 2') });
    await until(() => toolbarButtons().length > 0, 'the toolbar shows past the code');
    act('do', 'Select', { from: startOf('let alpha = 1') + 4, to: endOf('let beta = 2') });
    await until(() => toolbarButtons().length === 0, 'the toolbar hides over code');
    act('do', 'PlaceCaret', { at: startOf('below') });
    act('press', { key: 'Backspace' });
    await until(() => toolbarButtons().length === 0, 'the toolbar hides on a selected block');
    act('press', { key: 'Backspace' });
    assert.ok(!kinds().some(([kind]) => kind.startsWith('code')), 'the block is still there');
  }),
);

await story('the arrows leave a selected block beside it, an empty one as Up and Down', () =>
  inScratchNote(async () => {
    pasted(BLOCK);
    const block = [startOf('let alpha = 1'), endOf('let beta = 2'), true];
    const press = (key) => {
      clickHeaderAbove('let alpha = 1');
      assert.deepEqual(selected(), block);
      act('press', { key });
      return selected();
    };
    assert.deepEqual(press('ArrowUp'), [endOf('above'), endOf('above'), false]);
    assert.deepEqual(press('ArrowDown'), [startOf('below'), startOf('below'), false]);
    assert.deepEqual(press('ArrowLeft'), [block[0], block[0], false]);
    assert.deepEqual(press('ArrowRight'), [block[1], block[1], false]);
    // Shift extends from the code's start, a selection anchored in the code: it stays there.
    clickHeaderAbove('let alpha = 1');
    act('press', { key: 'Shift-ArrowDown', count: 2 });
    assert.deepEqual(selected(), [block[0], block[1], false], 'Shift+Down from the block');
    act('do', 'Select', { from: 0, to: read('doc').lines.at(-1).end });
    act('press', { key: 'Backspace' });
    pasted('above\n```\n```\nbelow');
    const empty = read('doc').lines[1];
    for (const [key, at] of [
      ['ArrowLeft', endOf('above')],
      ['ArrowRight', startOf('below')],
    ]) {
      act('do', 'PlaceCaret', { at: startOf('below') });
      act('press', { key: 'Backspace' });
      assert.deepEqual(selected(), [empty.at, empty.at, true], 'Backspace selected no empty block');
      assert.equal(read('state').editor.caret, null, 'a caret drawn on the empty block');
      act('press', { key });
      assert.deepEqual(selected(), [at, at, false], key);
    }
  }),
);

await story('Up on a block that starts the note keeps it selected', () =>
  inScratchNote(async () => {
    pasted('```js\nx\n```\nafter');
    clickHeaderAbove('x');
    act('press', { key: 'ArrowUp' });
    assert.deepEqual(selected(), [0, 1, true]);
  }),
);

await story('Mod+Enter and Shift+Mod+Enter open a line after and before a selected block', () =>
  inScratchNote(async (noteId) => {
    pastedEndingWithBlock('```js\nx\n```');
    clickHeaderAbove('x');
    act('press', { key: 'Mod-Enter' });
    act('type', { text: 'after' });
    clickHeaderAbove('x');
    act('press', { key: 'Shift-Mod-Enter' });
    act('type', { text: 'before' });
    assert.equal(await saved(noteId), 'before\n```js\nx\n```\nafter');
  }),
);

await story('Down off a block that ends the note, and a press below it, open a line', () =>
  inScratchNote(async (noteId) => {
    pastedEndingWithBlock('```js\nx\ny\n```');
    act('do', 'PlaceCaret', { at: endOf('x') });
    act('press', { key: 'ArrowDown' });
    assert.deepEqual(selected(), [endOf('y'), endOf('y'), false], 'Down from x is y');
    act('press', { key: 'ArrowDown' });
    act('type', { text: 'one' });
    assert.equal(await saved(noteId), '```js\nx\ny\n```\none');
    act('do', 'Select', { from: 0, to: endOf('one') });
    act('press', { key: 'Backspace' });
    pastedEndingWithBlock('```js\nx\n```');
    const code = read('show', { text: 'x' }).rect;
    act('click', { x: code.x + 40, y: code.y + code.h + 30 });
    act('type', { text: 'two' });
    assert.equal(await saved(noteId), '```js\nx\n```\ntwo');
  }),
);

/** The middle of the text `text` on screen, as [x, y]. */
function middleOf(text, along = 0.5) {
  const rect = read('show', { text }).rect;
  return [rect.x + rect.w * along, rect.y + rect.h / 2];
}

/** A real drag from `from` to `to`, each [x, y], with `extra` (a click count). */
function dragBetween(from, to, extra = {}) {
  // A press on selected text would drag the text: start from a caret.
  act('do', 'PlaceCaret', { at: 0 });
  act('drag', { x: from[0], y: from[1], x2: to[0], y2: to[1], ...extra });
}

await story('a drag from inside code stays in that code, up, down, sideways or from its edge', () =>
  inScratchNote(async () => {
    pasted(BLOCK);
    const inAlpha = middleOf('let alpha = 1', 0.3);
    const inBeta = middleOf('let beta = 2', 0.3);
    dragBetween(inAlpha, middleOf('below'));
    const [from] = selected();
    assert.ok(from > startOf('let alpha = 1') && from < endOf('let alpha = 1'), `from ${from}`);
    assert.deepEqual(selected(), [from, endOf('let beta = 2'), false], 'down into the prose');
    // The page's own selection was put back too: Shift+Left steps from the code's end.
    act('press', { key: 'Shift-ArrowLeft' });
    assert.deepEqual(selected(), [from, endOf('let beta = 2') - 1, false]);
    dragBetween(inBeta, middleOf('above'));
    const [, to] = selected();
    assert.deepEqual(selected(), [startOf('let alpha = 1'), to, false], 'up into the prose');
    dragBetween(inAlpha, [inAlpha[0] + 600, inAlpha[1]]);
    assert.deepEqual(selected().slice(1), [endOf('let alpha = 1'), false], 'off the row right');
    dragBetween(inBeta, [inBeta[0] - 200, inBeta[1]]);
    assert.equal(selected()[0], startOf('let beta = 2'), "off the row left: the row's start");
    // From the code's very start out over its edge, nothing is between the two.
    const start = read('show', { text: 'let alpha = 1' }).rect;
    dragBetween([start.x + 1, start.y + start.h / 2], middleOf('above'));
    const codeStart = startOf('let alpha = 1');
    assert.deepEqual(selected(), [codeStart, codeStart, false], 'from the edge out');
    // From the prose the drag takes the block whole, as the engine does.
    dragBetween(middleOf('above'), inBeta);
    act('do', 'Copy');
    assert.ok(read('clipboard').clipboard.text.includes('```'), 'the block was not taken whole');
  }),
);

await story('Shift+click, Shift+arrows, a triple and a double click drag stop at the code', () =>
  inScratchNote(async () => {
    pasted(BLOCK);
    const code = [startOf('let alpha = 1'), endOf('let beta = 2')];
    const [x, y] = middleOf('let alpha = 1', 0.3);
    act('click', { x, y });
    const [at] = selected();
    act('click', { x: middleOf('below')[0], y: middleOf('below')[1], shift: true });
    assert.deepEqual(selected(), [at, code[1], false], 'Shift+click below');
    act('click', { x, y });
    act('press', { key: 'Shift-ArrowDown', count: 3 });
    assert.deepEqual(selected(), [at, code[1], false], 'Shift+Down is a wall');
    act('press', { key: 'Shift-ArrowUp', count: 4 });
    assert.deepEqual(selected(), [code[0], at, false], 'Shift+Up is a wall');
    act('click', { x, y });
    act('press', { key: SELECT_TO_NOTE_END_KEY });
    assert.deepEqual(selected(), [at, code[1], false], 'Shift+Cmd+Down');
    act('click', { x, y, count: 3 });
    assert.deepEqual(selected(), [code[0], endOf('let alpha = 1'), false], 'a triple click');
    dragBetween([x, y], middleOf('below'), { count: 2 });
    assert.deepEqual(selected().slice(1), [code[1], false], 'a double click drag');
    // Select All is the whole note, from a block that opens it too. A real Mod+A selects nothing
    // in the background web view (desktop-editor-ledger-checks.mjs): Select is its range.
    act('do', 'Select', { from: 0, to: endOf('below') });
    act('press', { key: 'Backspace' });
    pasted('```js\nx\n```\nafter');
    act('do', 'Select', { from: 0, to: endOf('after') });
    assert.deepEqual(selected(), [0, endOf('after'), false], 'Select All');
  }),
);

await story(
  'a drag up from below a block to right of its code starts past the break after it',
  () =>
    inScratchNote(async () => {
      pasted('above\n```js\nlet alpha = 1\nlet beta = 2\n```\nbelow the block');
      const beta = read('show', { text: 'let beta = 2' }).rect;
      const rightOfBeta = [beta.x + beta.w + 150, beta.y + beta.h / 2];
      const [x, y] = middleOf('below the block');
      dragBetween([x, y], rightOfBeta);
      const below = startOf('below the block');
      const [from, to, block] = selected();
      assert.ok(from === below && to > below && !block, `the drag selected ${from}..${to}`);
      dragBetween([read('show', { text: 'below the block' }).rect.x + 1, y], rightOfBeta);
      assert.deepEqual(selected(), [below, below, false], 'the break alone is a caret');
      // Up from the line below keeps its column on the code's last row, never the code's end.
      act('do', 'PlaceCaret', { at: endOf('below the block') });
      act('press', { key: 'ArrowUp' });
      const [up] = selected();
      assert.ok(up > startOf('let beta = 2') && up < endOf('let beta = 2'), `Up to ${up}`);
    }),
);

await story('Undo brings back a selection from the prose into code as it was', () =>
  inScratchNote(async () => {
    pasted(BLOCK);
    act('do', 'Select', { from: endOf('below'), to: startOf('let beta = 2') + 3 });
    const before = selected();
    act('press', { key: 'Backspace' });
    act('press', { key: 'Mod-z' });
    assert.deepEqual(selected(), before);
  }),
);

finish('desktop editor code block stories');

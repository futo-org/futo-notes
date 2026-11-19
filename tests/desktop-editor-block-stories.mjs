// The desktop editor's lists, tasks, quotes and dividers: drawn from the
// engine's block descriptions (lineElements.ts `drawLine`), read back through `doc`'s kinds,
// which come from the lines the page draws; the keys the engine answers (Enter, Tab, Shift+Tab,
// Backspace), the block shortcuts, a task's checkbox under a real click, and a divider as an
// atom. Content comes in through Paste, which is quicker than typing its markers. Fenced code
// blocks have their own stories (desktop-editor-code-block-stories.mjs).
// `node tests/desktop-editor-block-stories.mjs [filter]` runs the stories whose name holds it.
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

/** Each line as [kind, text], with a list's nesting below its first level after the kind. */
const kinds = () =>
  read('doc').lines.map((line) => [
    line.indent ? `${line.kind} +${line.indent}` : line.kind,
    line.text,
  ]);

async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

/** The end of the first line whose text is `text`. */
const endOf = (text) => read('doc').lines.find((line) => line.text === text).end;
/** Where the first line whose text is `text` has that text start: after a list item's marker
 *  unit, which its `at` is before. */
const startOf = (text) => {
  const line = read('doc').lines.find((entry) => entry.text === text);
  return line.end - line.text.length;
};

await story('draws bullets, numbers, tasks, quotes and a divider, nested', () =>
  inScratchNote(async () => {
    pasted(
      [
        '- one',
        '  - two',
        '- [ ] open',
        '- [x] done',
        '',
        '1. first',
        '2. second',
        '',
        '> quoted',
        '> - listed',
        '> > deeper',
        '',
        '---',
        '',
        'end',
      ].join('\n'),
    );
    assert.deepEqual(kinds(), [
      ['bullet', 'one'],
      ['bullet +1', 'two'],
      ['task ☐', 'open'],
      ['task ☑', 'done'],
      ['gap', ''],
      ['1.', 'first'],
      ['2.', 'second'],
      ['gap', ''],
      ['quote', 'quoted'],
      ['quote > bullet', 'listed'],
      ['quote > quote', 'deeper'],
      ['gap', ''],
      ['divider', '￼'],
      ['gap', ''],
      ['paragraph', 'end'],
    ]);
    const boxes = read('elements').elements.filter((element) => element.role === 'checkbox');
    assert.deepEqual(
      boxes.map((box) => [box.text, box.flags.includes('checked')]),
      [
        ['Done', false],
        ['Done', true],
      ],
    );
  }),
);

await story('Enter continues a list, and on an empty item leaves it', () =>
  inScratchNote(async (noteId) => {
    pasted('- a');
    act('do', 'PlaceCaret', { at: endOf('a') });
    act('press', { key: 'Enter' });
    act('type', { text: 'b' });
    assert.deepEqual(kinds().slice(0, 2), [
      ['bullet', 'a'],
      ['bullet', 'b'],
    ]);
    act('press', { key: 'Enter' });
    assert.equal(kinds()[2][0], 'bullet', 'Enter made no empty item');
    // The caret on the empty item is at its text column, not the line's left edge.
    const caret = read('state').editor.caret;
    act('do', 'PlaceCaret', { at: startOf('b') });
    const textColumn = read('state').editor.caret.left;
    assert.ok(
      Math.abs(caret.left - textColumn) < 1,
      `empty item caret ${caret.left}, text ${textColumn}`,
    );
    act('do', 'PlaceCaret', { at: read('doc').lines[2].end });
    act('press', { key: 'Enter' });
    assert.equal(kinds()[2][0], 'gap', 'Enter on an empty item stayed in the list');
    act('type', { text: 'out' });
    assert.deepEqual(kinds().at(-1), ['paragraph', 'out']);
    // No blank line is written where the list ends.
    assert.equal(await saved(noteId), '- a\n- b\nout');
  }),
);

await story('Enter on an empty nested item lifts it a level', () =>
  inScratchNote(async () => {
    pasted('- a\n  - b');
    act('do', 'PlaceCaret', { at: endOf('b') });
    act('press', { key: 'Enter' });
    assert.equal(kinds()[2][0], 'bullet +1');
    act('press', { key: 'Enter' });
    assert.equal(kinds()[2][0], 'bullet', 'the empty nested item did not lift a level');
  }),
);

await story('Tab and Shift+Tab indent and outdent an item, and on a plain line do nothing', () =>
  inScratchNote(async (noteId) => {
    pasted('- a\n- b\n\nplain');
    act('do', 'PlaceCaret', { at: startOf('b') + 1 });
    act('press', { key: 'Tab' });
    assert.deepEqual(kinds()[1], ['bullet +1', 'b']);
    assert.deepEqual(selection(), [startOf('b') + 1, startOf('b') + 1], 'the caret moved');
    act('press', { key: 'Shift-Tab' });
    assert.deepEqual(kinds()[1], ['bullet', 'b']);
    act('do', 'PlaceCaret', { at: startOf('plain') });
    act('press', { key: 'Tab' });
    assert.deepEqual(kinds()[3], ['paragraph', 'plain']);
    act('press', { key: 'Shift-Tab' });
    assert.deepEqual(kinds()[3], ['paragraph', 'plain']);
    assert.deepEqual(selection(), [startOf('plain'), startOf('plain')], 'the caret moved');
    assert.equal(await saved(noteId), '- a\n- b\n\nplain');
  }),
);

await story('Backspace at the first item text start takes its marker', () =>
  inScratchNote(async (noteId) => {
    pasted('- a\n- b');
    act('do', 'PlaceCaret', { at: startOf('a') });
    act('press', { key: 'Backspace' });
    assert.deepEqual(kinds()[0], ['paragraph', 'a']);
    assert.match(await saved(noteId), /^a\n/);
  }),
);

await story('block shortcuts make a bullet, an ordered item and a quote', () =>
  inScratchNote(async (noteId) => {
    pasted('one\n\ntwo\n\nthree');
    act('do', 'PlaceCaret', { at: endOf('one') });
    act('press', { key: 'Mod-Alt-8' });
    act('do', 'PlaceCaret', { at: endOf('two') });
    act('press', { key: 'Mod-Alt-7' });
    act('do', 'PlaceCaret', { at: endOf('three') });
    act('press', { key: 'Shift-Mod-b' });
    assert.deepEqual(
      kinds().filter(([kind]) => kind !== 'gap'),
      [
        ['bullet', 'one'],
        ['1.', 'two'],
        ['quote', 'three'],
      ],
    );
    assert.equal(await saved(noteId), '- one\n\n1. two\n\n> three');
  }),
);

await story('a click on a task checkbox toggles it as one Undo step, the caret staying', () =>
  inScratchNote(async (noteId) => {
    pasted('- [ ] task one\n\nbelow');
    act('do', 'PlaceCaret', { at: endOf('below') - 2 });
    const caret = selection();
    const box = read('elements').elements.find((element) => element.role === 'checkbox');
    assert.equal(
      read('at', { x: box.rect.x + box.rect.w / 2, y: box.rect.y + box.rect.h / 2 }).cursor,
      'default',
    );
    act('click', { ref: box.ref });
    assert.deepEqual(kinds()[0], ['task ☑', 'task one']);
    assert.deepEqual(selection(), caret, 'the toggle moved the selection');
    assert.equal(await saved(noteId), '- [x] task one\n\nbelow');
    act('press', { key: 'Mod-z' });
    assert.deepEqual(kinds()[0], ['task ☐', 'task one']);
    assert.deepEqual(selection(), caret, 'Undo moved the selection');
    act('press', { key: 'Shift-Mod-z' });
    assert.deepEqual(kinds()[0], ['task ☑', 'task one']);
    assert.deepEqual(selection(), caret, 'Redo moved the selection');
  }),
);

await story('a click on a task checkbox leaves the focus in the title field', () =>
  inScratchNote(async () => {
    pasted('- [ ] task');
    const elements = read('elements').elements;
    const title = elements.find(
      (element) => element.role === 'textbox' && element.component !== 'DesktopEditor.svelte',
    );
    act('click', { ref: title.ref });
    assert.equal(read('state').editor.focused, false, 'the title field took no focus');
    act('click', { ref: elements.find((element) => element.role === 'checkbox').ref });
    assert.deepEqual(kinds()[0], ['task ☑', 'task']);
    assert.equal(read('state').editor.focused, false, 'the checkbox took the focus');
  }),
);

await story('a press beside a checkbox places the caret before it or at the task text', () =>
  inScratchNote(async () => {
    pasted('above\n- [ ] task');
    const box = read('elements').elements.find((element) => element.role === 'checkbox');
    const task = read('doc').lines[1];
    act('click', { x: box.rect.x - 4, y: box.rect.y + box.rect.h / 2 });
    assert.deepEqual(selection(), [task.at, task.at], 'left of the box is before it');
    act('click', { x: box.rect.x + box.rect.w + 1, y: box.rect.y + box.rect.h / 2 });
    assert.deepEqual(selection(), [startOf('task'), startOf('task')], 'right of it is the text');
    assert.deepEqual(kinds()[1], ['task ☐', 'task']);
  }),
);

await story('typing in a quote stays quoted, and Enter on an empty quoted line leaves it', () =>
  inScratchNote(async (noteId) => {
    pasted('> a');
    act('do', 'PlaceCaret', { at: endOf('a') });
    act('press', { key: 'Enter' });
    act('type', { text: 'b' });
    assert.deepEqual(kinds().slice(0, 2), [
      ['quote', 'a'],
      ['quote', 'b'],
    ]);
    act('press', { key: 'Enter' });
    act('press', { key: 'Enter' });
    act('type', { text: 'out' });
    assert.deepEqual(kinds().at(-1), ['paragraph', 'out']);
    // No blank line is written where the quote ends.
    assert.equal(await saved(noteId), '> a\n> b\nout');
  }),
);

const DIVIDED = 'above\n\n---\n\nbelow';

await story('a click on a divider selects it whole, and Backspace deletes it', () =>
  inScratchNote(async () => {
    pasted(DIVIDED);
    const rule = read('doc').lines.find((line) => line.kind === 'divider');
    const editor = read('show', { text: 'above' }).rect;
    // The divider's row is two rows under "above".
    act('click', { x: editor.x + 120, y: editor.y + editor.h / 2 + 2 * editor.h });
    assert.deepEqual(selection(), [rule.at, rule.end]);
    act('press', { key: 'Backspace' });
    assert.ok(!kinds().some(([kind]) => kind === 'divider'), 'the divider is still there');
  }),
);

await story('the caret steps over a divider, and Delete before it deletes it', () =>
  inScratchNote(async () => {
    pasted(DIVIDED);
    const rule = read('doc').lines.find((line) => line.kind === 'divider');
    act('do', 'PlaceCaret', { at: rule.at - 1 });
    act('press', { key: 'ArrowRight' });
    assert.deepEqual(selection(), [rule.at, rule.at]);
    act('press', { key: 'ArrowRight' });
    assert.deepEqual(selection(), [rule.end, rule.end]);
    act('press', { key: 'Shift-ArrowLeft' });
    assert.deepEqual(selection(), [rule.at, rule.end]);
    act('do', 'PlaceCaret', { at: rule.at });
    act('press', { key: 'Delete' });
    assert.ok(!kinds().some(([kind]) => kind === 'divider'), 'Delete left the divider');
  }),
);

await story('a drag across a divider takes it whole', () =>
  inScratchNote(async () => {
    pasted(DIVIDED);
    const above = read('show', { text: 'above' }).rect;
    const below = read('show', { text: 'below' }).rect;
    act('drag', {
      x: above.x + 10,
      y: above.y + above.h / 2,
      x2: below.x + 10,
      y2: below.y + below.h / 2,
    });
    const rule = read('doc').lines.find((line) => line.kind === 'divider');
    const [from, to] = selection();
    assert.ok(from < rule.at && to > rule.end, `selected ${from}..${to}`);
  }),
);

await story('Up and Down go one line a press through every kind, and back', () =>
  inScratchNote(async () => {
    // Headings over a line each: Down from a heading whose rows are taller than a line unit
    // lands on the next line. Two code blocks back to back: Up and Down cross each
    // header and the gap above it.
    pasted(
      '# one\nunder one\n## two\nunder two\ntop\n\n- bullet\n- [ ] task\n\n> quote\n\n---\n' +
        '```js\nx\ny\n```\n```\nz\n```\nend',
    );
    const count = read('doc').lines.length;
    act('do', 'PlaceCaret', { at: 0 });
    const line = () => read('state').editor.selection.line;
    for (let expected = 2; expected <= count; expected++) {
      act('press', { key: 'ArrowDown' });
      assert.equal(line(), expected, `Down to line ${expected}`);
    }
    for (let expected = count - 1; expected >= 1; expected--) {
      act('press', { key: 'ArrowUp' });
      assert.equal(line(), expected, `Up to line ${expected}`);
    }
  }),
);

await story('typed line starts make a bullet and an ordered item', () =>
  inScratchNote(async () => {
    act('type', { text: '- x' });
    // Out of the list first: a marker typed into an empty item is that item's text.
    act('press', { key: 'Enter', count: 2 });
    act('type', { text: '1. y' });
    assert.deepEqual(kinds(), [
      ['bullet', 'x'],
      ['1.', 'y'],
    ]);
  }),
);

await story('a copied list keeps its markers, and pasted it is a list again', () =>
  inScratchNote(async () => {
    pasted('- a\n- b\n\n1. c\n\nend');
    act('do', 'Select', { from: 0, to: endOf('c') });
    act('do', 'Copy');
    act('do', 'PlaceCaret', { at: endOf('end') });
    act('press', { key: 'Enter' });
    act('press', { key: 'Enter' });
    // The copied text alone: a list again only if its markers came with it.
    act('do', 'PasteAndMatchStyle');
    const tail = kinds().slice(-4);
    assert.deepEqual(tail, [
      ['bullet', 'a'],
      ['bullet', 'b'],
      ['gap', ''],
      ['1.', 'c'],
    ]);
  }),
);

await story('Enter in the middle of an ordered list renumbers the items below', () =>
  inScratchNote(async () => {
    pasted('1. a\n2. b\n3. c');
    act('do', 'PlaceCaret', { at: endOf('a') });
    act('press', { key: 'Enter' });
    act('type', { text: 'new' });
    assert.deepEqual(kinds(), [
      ['1.', 'a'],
      ['2.', 'new'],
      ['3.', 'b'],
      ['4.', 'c'],
    ]);
  }),
);

finish('desktop editor block stories');

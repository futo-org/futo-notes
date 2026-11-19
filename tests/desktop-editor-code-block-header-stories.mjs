// The desktop editor's code block header (codeBlockHeader.ts): the name and language fields and
// the copy button, real clicks, keys and typing in them, the header written once through the
// engine when a field is left (the file on disk), the button's copy, the typed fence's language
// field, the controls' inset in the card, and a press on a selected empty block. Puppet's `state.editor.headerField` says which field has focus.
// `node tests/desktop-editor-code-block-header-stories.mjs [filter]` runs the stories whose name
// holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
  onRow,
  pasted,
  read,
  scrollAtRest,
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

const lineOf = (text) => read('doc').lines.find((line) => line.text === text);
const startOf = (text) => lineOf(text).at;
const endOf = (text) => lineOf(text).end;

function editor() {
  const state = read('state').editor;
  assert.equal(state.error, undefined);
  return state;
}

/** The selection as [from, to], and whether it is a block selected as one object. */
function selected() {
  const { selection } = editor();
  return [selection.from, selection.to, !!selection.block];
}

/** The header controls above the code line drawn at `y` (with no `y`, the note's one block): the
 *  name field, the language field and the copy button. */
function headerAt(y) {
  const controls = read('elements').elements.filter(
    (element) =>
      element.component === 'DesktopEditor.svelte' &&
      element.role !== 'textbox' &&
      (y === undefined || (element.rect.y < y && element.rect.y > y - 40)),
  );
  const fields = controls.filter((element) => element.role === 'text');
  fields.sort((left, right) => left.rect.x - right.rect.x);
  return {
    name: fields[0],
    language: fields[1],
    copy: controls.find((element) => element.role === 'button'),
  };
}

const headerAbove = (text) => headerAt(read('show', { text }).rect.y);
const clickOn = (element, extra = {}) =>
  act('click', {
    x: element.rect.x + element.rect.w / 2,
    y: element.rect.y + element.rect.h / 2,
    ...extra,
  });

const BLOCK = 'above\n```js\nlet alpha = 1\nlet beta = 2\n```\nbelow';

await story(
  'a click on the name field edits it; Enter writes the name, the caret at the code',
  () =>
    inScratchNote(async (noteId) => {
      pasted(BLOCK);
      clickOn(headerAbove('let alpha = 1').name);
      assert.deepEqual(editor().headerField, { field: 'name', value: '' });
      assert.equal(editor().caret, null, 'a caret drawn in the note while a field has focus');
      act('type', { text: 'main.js' });
      act('press', { key: 'Enter' });
      assert.equal(editor().headerField, undefined);
      const code = startOf('let alpha = 1');
      assert.deepEqual(selected(), [code, code, false]);
      act('type', { text: 'x' });
      assert.equal(
        await saved(noteId),
        'above\n```js name:main.js\nxlet alpha = 1\nlet beta = 2\n```\nbelow',
      );
      assert.equal(headerAbove('xlet alpha = 1').name.text, 'main.js');
    }),
);

await story(
  'Escape puts the field back and returns; a refused name leaves the block as it was',
  () =>
    inScratchNote(async (noteId) => {
      pasted(BLOCK);
      act('do', 'PlaceCaret', { at: endOf('below') });
      clickOn(headerAbove('let alpha = 1').name);
      act('type', { text: 'zzz' });
      act('press', { key: 'Escape' });
      assert.deepEqual(selected(), [endOf('below'), endOf('below'), false]);
      assert.equal(headerAbove('let alpha = 1').name.text, 'name');
      // A name holding a key would not read back: the engine refuses it.
      clickOn(headerAbove('let alpha = 1').name);
      act('type', { text: 'a hl:2' });
      act('press', { key: 'Enter' });
      assert.equal(editor().headerField, undefined);
      assert.equal(await saved(noteId), BLOCK);
      assert.equal(headerAbove('let alpha = 1').name.text, 'name');
    }),
);

await story('a click on the language edits it; only the copy button copies', () =>
  inScratchNote(async (noteId) => {
    pasted(BLOCK);
    const copiedBefore = read('state').copied;
    clickOn(headerAbove('let alpha = 1').language);
    assert.deepEqual(editor().headerField, { field: 'language', value: 'js' });
    assert.deepEqual(read('state').copied, copiedBefore, 'a click on the language copied');
    // Emptied with keys the background web view takes: Mod+A is the Edit menu's, which
    // Puppet's keys do not reach (desktop-editor-ledger-checks.mjs).
    act('press', { key: 'Backspace', count: 2 });
    act('press', { key: 'Delete', count: 2 });
    assert.deepEqual(editor().headerField, { field: 'language', value: '' });
    // A space becomes a hyphen and a leading one goes.
    act('type', { text: ' c sharp' });
    assert.deepEqual(editor().headerField, { field: 'language', value: 'c-sharp' });
    act('press', { key: 'Tab' });
    const code = startOf('let alpha = 1');
    assert.deepEqual(selected(), [code, code, false]);
    assert.equal(await saved(noteId), BLOCK.replace('```js', '```c-sharp'));
    // Escape in the language puts its value back and goes to the code.
    clickOn(headerAbove('let alpha = 1').language);
    act('type', { text: 'rust' });
    act('press', { key: 'Escape' });
    assert.deepEqual(selected(), [code, code, false]);
    assert.equal(await saved(noteId), BLOCK.replace('```js', '```c-sharp'));
    // Read before the check's 1.1 s flash ends: one Puppet call takes most of a second on Windows.
    const copy = headerAbove('let alpha = 1').copy;
    clickOn(copy);
    assert.ok(
      read('show', { ref: copy.ref }).classes.includes('copied'),
      'the glyph never showed the copied check',
    );
    assert.equal(read('state').copied?.text, 'let alpha = 1\nlet beta = 2');
    assert.equal(editor().headerField, undefined, 'a click on the copy button opened a field');
  }),
);

await story("each control's fill stands as far from the card's top as from its side", () =>
  inScratchNote(async () => {
    pasted(BLOCK);
    const { name, language, copy } = headerAbove('let alpha = 1');
    // The header row under the space between the fields: the card's top and sides.
    const header = read('at', {
      x: name.rect.x + name.rect.w + 20,
      y: name.rect.y + name.rect.h / 2,
    }).stack.find(
      (element) =>
        element.rect.x <= name.rect.x &&
        element.rect.x + element.rect.w >= copy.rect.x + copy.rect.w,
    ).rect;
    const side = name.rect.x - header.x;
    assert.ok(side > 0, `the name field touches the card's side (${side}px)`);
    assert.ok(Math.abs(header.x + header.w - (copy.rect.x + copy.rect.w) - side) < 1);
    for (const control of [name, language, copy]) {
      const top = control.rect.y - header.y;
      assert.ok(Math.abs(top - side) < 1, `${control.role} ${top}px from the top, ${side}px aside`);
    }
  }),
);

await story('Tab and Shift+Tab walk name, language and code; Up from a field leaves above', () =>
  inScratchNote(async (noteId) => {
    pasted(BLOCK);
    const code = startOf('let alpha = 1');
    act('do', 'PlaceCaret', { at: code });
    act('press', { key: 'Shift-Tab' });
    assert.deepEqual(editor().headerField, { field: 'language', value: 'js' });
    act('press', { key: 'Shift-Tab' });
    assert.deepEqual(editor().headerField, { field: 'name', value: '' });
    act('type', { text: 'a.js' });
    act('press', { key: 'Tab' });
    act('press', { key: 'Backspace', count: 2 });
    act('type', { text: 'ts' });
    act('press', { key: 'Shift-Tab' });
    act('press', { key: 'ArrowUp' });
    assert.deepEqual(selected(), [endOf('above'), endOf('above'), false]);
    // Both fields left together: one write, one Undo step.
    assert.equal(await saved(noteId), BLOCK.replace('```js', '```ts name:a.js'));
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), BLOCK);
  }),
);

await story('the third backtick gives the language field focus: letters, Enter, then code', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '```' });
    assert.deepEqual(editor().headerField, { field: 'language', value: '' });
    assert.equal(editor().caret, null, 'a caret drawn in the code');
    // Backspace in the empty field removes nothing and stays.
    act('press', { key: 'Backspace' });
    assert.deepEqual(editor().headerField, { field: 'language', value: '' });
    act('type', { text: 'js' });
    act('press', { key: 'Enter' });
    assert.equal(editor().headerField, undefined);
    act('type', { text: 'let a' });
    assert.equal(await saved(noteId), '```js\nlet a\n```');
    // Undo back to the language caret gives the field focus again; with nothing typed in it, the
    // next Undo is the note's, and Redo comes back to it.
    act('press', { key: 'Mod-z' });
    act('press', { key: 'Mod-z' });
    assert.deepEqual(editor().headerField, { field: 'language', value: '' });
    assert.equal(await saved(noteId), '```\n```');
    act('press', { key: 'Mod-z' });
    assert.equal(editor().headerField, undefined);
    assert.equal(await saved(noteId), '``');
    act('press', { key: 'Shift-Mod-z' });
    assert.deepEqual(editor().headerField, { field: 'language', value: '' });
    act('press', { key: 'Escape' });
    act('type', { text: 'b' });
    assert.equal(await saved(noteId), '```\nb\n```');
  }),
);

await story('neither field takes a backtick: the rest of what was typed is written', () =>
  inScratchNote(async (noteId) => {
    pasted(BLOCK);
    clickOn(headerAbove('let alpha = 1').language, { count: 2 });
    act('type', { text: '`p`y`' });
    assert.deepEqual(editor().headerField, { field: 'language', value: 'py' });
    act('press', { key: 'Shift-Tab' });
    act('type', { text: 'ma`in.py' });
    assert.deepEqual(editor().headerField, { field: 'name', value: 'main.py' });
    act('press', { key: 'Enter' });
    assert.equal(
      await saved(noteId),
      'above\n```py name:main.py\nlet alpha = 1\nlet beta = 2\n```\nbelow',
    );
  }),
);

await story('leaving a field leaves the pane where it is, with the caret far away', () =>
  inScratchNote(async () => {
    const rows = Array.from({ length: 80 }, (_, index) => `row ${index + 1}`).join('\n');
    pasted(`${rows}\n${BLOCK}`);
    const editorBox = () =>
      read('elements').elements.find((element) => element.component === 'DesktopEditor.svelte')
        .rect;
    for (const [field, key] of [
      ['language', 'Enter'],
      ['name', 'Escape'],
      ['name', 'ArrowUp'],
    ]) {
      act('do', 'PlaceCaret', { at: 0 });
      await scrollAtRest({ x: editorBox().x + 20, y: 300, dy: 3000 });
      const scrolled = editorBox().y;
      clickOn(headerAbove('let alpha = 1')[field]);
      act('type', { text: 'p' });
      act('press', { key });
      await untilIdle();
      assert.equal(editor().headerField, undefined);
      assert.equal(editorBox().y, scrolled, `${key} in the ${field} scrolled the pane`);
    }
  }),
);

await story('a press in the code ends the language field; the letters typed there are kept', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '```' });
    act('type', { text: 'py' });
    const { name } = headerAt();
    // The empty code line, under the header.
    act('click', { x: name.rect.x + 80, y: name.rect.y + 35 });
    await until(() => !editor().headerField, 'the language field kept focus');
    act('type', { text: 'x' });
    assert.equal(await saved(noteId), '```py\nx\n```');
  }),
);

await story('a press on a selected empty block ends the selection: typing writes code', () =>
  inScratchNote(async (noteId) => {
    pasted('above\n```\n```\nbelow');
    const { name } = headerAt();
    // The header row between its fields selects the block.
    act('click', { x: name.rect.x + name.rect.w + 40, y: name.rect.y + name.rect.h / 2 });
    const empty = read('doc').lines[1].at;
    assert.deepEqual(selected(), [empty, empty, true]);
    act('click', { x: name.rect.x + 80, y: name.rect.y + 35 });
    assert.deepEqual(selected(), [empty, empty, false]);
    act('type', { text: 'x' });
    assert.equal(await saved(noteId), 'above\n```\nx\n```\nbelow');
  }),
);

await story('a switch to another note writes the field being typed in', () =>
  inScratchNote(async (noteId) => {
    pasted(BLOCK);
    clickOn(headerAbove('let alpha = 1').name);
    act('type', { text: 'main.js' });
    onRow('OpenNote', { noteId: 'another note' });
    assert.equal(
      await saved(noteId),
      'above\n```js name:main.js\nlet alpha = 1\nlet beta = 2\n```\nbelow',
    );
  }),
);

finish('desktop editor code block header stories');

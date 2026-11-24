// Paired typing in the desktop editor (docs/spec/editor/desktop/paired-typing.md, the rules in
// portable-core/paired-typing.md): real key presses through `just puppet`, checked against the
// file, the engine's caret and the caret's flag. Backticks: desktop-editor-code-block-stories.mjs.
// `node tests/desktop-editor-pairing-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
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

/** Type `text` with real keys; the file then reads `source` and the caret is at `caret`. */
async function typed(noteId, text, source, caret) {
  act('type', { text });
  assert.equal(await saved(noteId), source, `after typing ${JSON.stringify(text)}`);
  assert.deepEqual(selection(), [caret, caret], `the caret after ${JSON.stringify(text)}`);
}

async function backspace(noteId, source, caret) {
  act('press', { key: 'Backspace' });
  assert.equal(await saved(noteId), source);
  assert.deepEqual(selection(), [caret, caret]);
}

const flag = () => read('state').editor.flag;
const listShows = () => read('elements').elements.some((element) => element.role === 'listbox');
const offered = () =>
  read('elements')
    .elements.filter((element) => element.role === 'option')
    .map((element) => element.text);

await story('* pairs, grows to bold and both, a fourth is typed; Backspace takes a level', () =>
  inScratchNote(async (noteId) => {
    await typed(noteId, 'a *', 'a **', 3);
    await typed(noteId, '*', 'a ****', 4);
    await typed(noteId, '*', 'a ******', 5);
    await typed(noteId, '*', 'a *******', 6);
    await backspace(noteId, 'a ******', 5);
    await backspace(noteId, 'a ****', 4);
    await backspace(noteId, 'a **', 3);
    await backspace(noteId, 'a ', 2);
    // After a digit or a letter it is typed, before a word it pairs, at a line's start it is
    // typed.
    act('press', { key: 'Enter' });
    await typed(noteId, '2*3 word', 'a \n2*3 word', 11);
    act('do', 'PlaceCaret', { at: 7 });
    await typed(noteId, '*', 'a \n2*3 **word', 8);
    act('do', 'PlaceCaret', { at: 13 });
    act('press', { key: 'Enter' });
    await typed(noteId, '*', 'a \n2*3 **word\n*', 15);
  }),
);

await story('text in a pair, then * steps out of bold and italic, the flag losing them', () =>
  inScratchNote(async (noteId) => {
    await typed(noteId, 'a **bold', 'a **bold**', 6);
    assert.deepEqual(flag(), ['B']);
    await typed(noteId, '*', 'a **bold**', 6);
    assert.deepEqual(flag(), []);
    await typed(noteId, '*', 'a **bold**', 6);
    await typed(noteId, ' *it', 'a **bold** *it*', 9);
    assert.deepEqual(flag(), ['I']);
    await typed(noteId, '*', 'a **bold** *it*', 9);
    assert.deepEqual(flag(), []);
    await typed(noteId, ' ***b*x', 'a **bold** *it* ***b***x', 12);
  }),
);

await story('~ is typed once, a second pairs as strikethrough, and ~~ steps out', () =>
  inScratchNote(async (noteId) => {
    await typed(noteId, 'a ~', 'a ~', 3);
    await typed(noteId, '~', 'a ~~~~', 4);
    await backspace(noteId, 'a ', 2);
    await typed(noteId, '~~s', 'a ~~s~~', 3);
    assert.deepEqual(flag(), ['S']);
    await typed(noteId, '~~x', 'a ~~s~~x', 4);
  }),
);

await story(
  '[ pairs and grows, ] steps over, Backspace takes a level, and a task types as before',
  () =>
    inScratchNote(async (noteId) => {
      await typed(noteId, 'a [', 'a []', 3);
      await typed(noteId, '[', 'a [[]]', 4);
      await backspace(noteId, 'a []', 3);
      await typed(noteId, 'b]', 'a [b]', 5);
      act('press', { key: 'Enter' });
      act('type', { text: '- [ ] task' });
      assert.equal(await saved(noteId), 'a [b]\n- [ ] task');
      assert.match(read('doc').lines[1].kind, /^task/);
    }),
);

await story('a wikilink draws as typed while its run is open, and Enter leaves no stray ]]', () =>
  inScratchNote(async (noteId) => {
    await typed(noteId, 'go [[', 'go [[]]', 5);
    await until(listShows, 'the note list shows');
    assert.ok(offered().length > 1, 'every note is offered');
    await typed(noteId, 'anot', 'go [[anot]]', 9);
    await until(() => offered().join() === 'another note', 'the letters narrow the list');
    // As typed: its source shows (a unit's text is drawn at no size), the caret stops inside.
    assert.ok(read('show', { text: '[[anot]]' }).rect.w > 0);
    act('press', { key: 'ArrowLeft', count: 2 });
    assert.deepEqual(selection(), [7, 7]);
    act('press', { key: 'ArrowRight', count: 2 });
    act('press', { key: 'Enter' });
    assert.equal(await saved(noteId), 'go [[another note]]');
    assert.deepEqual(selection(), [19, 19]);
    // Escape keeps what was typed; `]]` steps out and the wikilink is one unit again.
    await typed(noteId, ' [[anot', 'go [[another note]] [[anot]]', 26);
    await until(listShows, 'the note list shows');
    act('press', { key: 'Escape' });
    assert.ok(!listShows());
    await typed(noteId, ']]', 'go [[another note]] [[anot]]', 28);
    act('press', { key: 'ArrowLeft' });
    assert.deepEqual(selection(), [20, 20]);
    act('do', 'PlaceCaret', { at: 28 });
    await backspace(noteId, 'go [[another note]] ', 20);
  }),
);

await story('over a selection * italic, bold, both, then typed; ~ strikes in one key', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: 'x word y' });
    act('do', 'Select', { from: 2, to: 6 });
    act('type', { text: '*' });
    assert.equal(await saved(noteId), 'x *word* y');
    act('type', { text: '*' });
    assert.equal(await saved(noteId), 'x **word** y');
    act('type', { text: '*' });
    assert.equal(await saved(noteId), 'x ***word*** y');
    assert.deepEqual(selection(), [2, 6]);
    await typed(noteId, '*', 'x ******* y', 6);
    act('do', 'PlaceCaret', { at: 11 });
    act('press', { key: 'Enter' });
    act('type', { text: 'z word' });
    act('do', 'Select', { from: 14, to: 18 });
    act('type', { text: '~' });
    assert.equal(await saved(noteId), 'x ******* y\nz ~~word~~');
  }),
);

await story('in a code block nothing pairs', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '```' });
    act('press', { key: 'Enter' });
    act('type', { text: 'x*[~' });
    assert.equal(await saved(noteId), '```\nx*[~\n```');
  }),
);

finish('desktop editor pairing stories');

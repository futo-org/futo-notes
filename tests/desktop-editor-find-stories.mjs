// Find in the note on the desktop editor (docs/spec/editor/desktop/find.md): Ctrl/Cmd+F through
// the shell's chord, the bar's own verbs (SetFindQuery, StepFind, CloseFind), Ctrl/Cmd+G from the
// body, and what find leaves: the selection on the current match, the note's file untouched.
// Each story reads `state.editor.find` ({open, query, current, total}) and the selection.
// `node tests/desktop-editor-find-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
  onRow,
  pasted,
  read,
  selection,
  story,
  until,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

const find = () => read('state').editor.find;
const press = (key, count = 1) => act('press', { key, count });
const query = (text) => act('do', 'SetFindQuery', { query: text });
const step = (direction) => act('do', 'StepFind', { direction });

/** The saved note, once every edit is written. */
async function savedText(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

/** Find's state once the scan of `query` (a frame later) reads `current` of `total`. */
const counted = (query, current, total) =>
  until(() => {
    const state = find();
    return state.query === query && state.current === current && state.total === total && state;
  }, `find reads ${current} of ${total} for "${query}"`);

await story(
  'Mod+F opens on the selected word, steps with wrap, and Escape leaves a caret after the match',
  () =>
    inScratchNote(async (noteId) => {
      pasted('a cat\n\nthe Cat and the CAT');
      const before = await savedText(noteId);
      // "a cat\n\nthe Cat and the CAT": the matches are 2..5, 11..14, 23..26.
      act('do', 'Select', { from: 2, to: 5 });
      press('Mod-f');
      assert.deepEqual(await counted('cat', 1, 3), {
        open: true,
        query: 'cat',
        current: 1,
        total: 3,
      });
      // The first press lands on the current match; later presses move on and wrap.
      step(1);
      assert.deepEqual(selection(), [2, 5]);
      step(1);
      assert.deepEqual(selection(), [11, 14]);
      step(1);
      step(1);
      assert.deepEqual([find().current, selection()], [1, [2, 5]]);
      step(-1);
      assert.deepEqual([find().current, selection()], [3, [23, 26]]);
      act('do', 'CloseFind');
      assert.equal(find().open, false);
      assert.deepEqual(selection(), [26, 26]);
      assert.equal(read('state').editor.focused, true);
      assert.equal(await savedText(noteId), before);
    }),
);

await story(
  'Mod+G steps from the body while the bar is open, and does nothing once it is closed',
  () =>
    inScratchNote(async () => {
      pasted('one two one two one');
      press('Mod-f');
      query('one');
      await counted('one', 1, 3);
      act('do', 'PlaceCaret', { at: 4 });
      press('Mod-g');
      assert.equal(find().open, true);
      press('Mod-g');
      press('Mod-Shift-g');
      const [from, to] = selection();
      assert.equal(to - from, 3);
      act('do', 'CloseFind');
      const closed = selection();
      press('Mod-g');
      assert.deepEqual([find().open, selection()], [false, closed]);
    }),
);

await story(
  'find matches the text shown: across a hidden mark, not markers, code text, table cells',
  () =>
    inScratchNote(async () => {
      pasted(
        'a **bo**ld word\n\n- milk\n\n```\nlet Bold = 1\n```\n\n| a | bold |\n|---|---|\n| c | d |',
      );
      press('Mod-f');
      query('bold');
      await counted('bold', 1, 3);
      query('**');
      await counted('**', 0, 0);
      query('- m');
      await counted('- m', 0, 0);
      query('bold word');
      await counted('bold word', 1, 1);
      // Every line break is a barrier.
      query('word milk');
      await counted('word milk', 0, 0);
      act('do', 'CloseFind');
    }),
);

await story('editing with find open keeps it open and recounts once typing settles', () =>
  inScratchNote(async (noteId) => {
    // "cat\ndog": the caret goes at the end, 7.
    pasted('cat\ndog');
    press('Mod-f');
    query('cat');
    await counted('cat', 1, 1);
    act('do', 'PlaceCaret', { at: 7 });
    act('type', { text: 'cat' });
    assert.equal(find().open, true);
    await until(() => find().total === 2, 'the rescan after typing settled');
    assert.equal(await savedText(noteId), 'cat\ndogcat');
    // Find added no Undo step: Undo takes the typing back.
    act('do', 'Undo');
    assert.equal(await savedText(noteId), 'cat\ndog');
    act('do', 'CloseFind');
  }),
);

await story('find matches past wider characters and every Greek sigma alike', () =>
  inScratchNote(async () => {
    pasted('😀 ΟΔΟΣΑ é οδος');
    act('do', 'PlaceCaret', { at: 0 });
    press('Mod-f');
    query('οδοσ');
    await counted('οδοσ', 1, 2);
    step(1);
    assert.deepEqual(selection(), [3, 7]);
    step(1);
    assert.deepEqual(selection(), [11, 15]);
    act('do', 'CloseFind');
  }),
);

const toolbarShown = () =>
  read('elements').elements.some((element) => element.component === 'FormatToolbar.svelte');

await story(
  "the selection toolbar stays down for find's selection, and shows for the user's own",
  () =>
    inScratchNote(async () => {
      pasted('one cat two');
      act('do', 'PlaceCaret', { at: 0 });
      press('Mod-f');
      query('cat');
      await counted('cat', 1, 1);
      step(1);
      assert.deepEqual(selection(), [4, 7]);
      assert.equal(toolbarShown(), false);
      act('do', 'CloseFind');
      assert.deepEqual(selection(), [7, 7]);
      act('do', 'Select', { from: 0, to: 3 });
      await until(toolbarShown, 'the toolbar shows for the next selection');
    }),
);

await story('a closed bar keeps its query for this note; opening another note closes it', () =>
  inScratchNote(async (noteId) => {
    pasted('dog');
    press('Mod-f');
    query('dog');
    await counted('dog', 1, 1);
    act('do', 'CloseFind');
    act('do', 'PlaceCaret', { at: 0 });
    press('Mod-f');
    assert.deepEqual(await counted('dog', 1, 1), {
      open: true,
      query: 'dog',
      current: 1,
      total: 1,
    });
    // An untouched new note is deleted as it is left.
    act('do', 'CreateNote');
    assert.equal(find().open, false);
    onRow('OpenNote', { noteId });
    assert.equal(find().open, false);
  }),
);

await story('typing in a long note with find open stays as fast as without it', () =>
  inScratchNote(async () => {
    const long = Array.from({ length: 5000 }, (_, index) => `line ${index} with the letter e`);
    pasted(long.join('\n'));
    act('do', 'PlaceCaret', { at: 0 });
    press('Mod-f');
    query('e');
    await until(() => find().total > 5000, 'the long note counted');
    act('do', 'PlaceCaret', { at: 0 });
    // Enough keys that the median is a typed key's, whatever else was timed before.
    act('type', { text: 'some typing here '.repeat(8) });
    const typing = read('state').editor.typing;
    console.log(`    typing with find open: ${JSON.stringify(typing)}`);
    assert.ok(typing.median < 8, `median ${typing.median} ms`);
    act('do', 'CloseFind');
  }),
);

finish('desktop editor find stories');

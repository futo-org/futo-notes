// A change to the open note from outside the editor (docs/spec/editor/desktop/outside-changes.md):
// another app edits, renames or deletes the note's file while the editor holds it. The stories
// write the file in the running dev app's vault directly (`devVault`, never the real vault) and
// touch only the notes they create. The window is in the background, so the editor's focus is
// what the page reports, never the window's.
// `node tests/desktop-editor-outside-change-stories.mjs [filter]` runs the stories whose name
// holds it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  act,
  devVault,
  finish,
  NOTE_END_KEY,
  onRow,
  read,
  selection,
  story,
  until,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

const VAULT = devVault();
const fileOf = (noteId) => join(VAULT, `${noteId}.md`);
/** The draft's source; null while the editor holds no note (re-opening it refuses `doc`). */
function source() {
  try {
    return read('doc').source;
  } catch {
    return null;
  }
}
const noteNow = () => read('state').note?.id ?? null;
const editorBox = () =>
  read('elements').elements.find((element) => element.component === 'DesktopEditor.svelte').rect;
/** A watcher event, the verdict and the host's round trip take longer than a frame. */
const OUTSIDE_MILLISECONDS = 5000;
const eventually = (check, what) => until(check, what, OUTSIDE_MILLISECONDS);

const copiesOf = (noteId) => read('notes').notes.filter((id) => id.startsWith(`${noteId} (`));
const toast = () => read('state').toast;

/** A note of its own holding `text`, saved and opened again with the caret at its end, so its
 *  text is the note's, not Undo steps (an outside edit beside text typed since the note opened
 *  is an ambiguous step the engine does not rebase). Every note the story names in `created`
 *  (the note, a conflict copy, a rename's new name) is deleted afterwards if it is still there. */
async function inOwnNote(text, run) {
  act('do', 'CreateNote');
  const noteId = read('state').note.id;
  const created = new Set([noteId]);
  act('do', 'PlaceCaret', { at: 0 });
  try {
    act('type', { text });
    await untilIdle();
    onRow('OpenNote', { noteId: 'another note' });
    onRow('OpenNote', { noteId });
    const editor = read('elements').elements.find(
      (element) => element.component === 'DesktopEditor.svelte',
    );
    act('click', { ref: editor.ref });
    act('press', { key: NOTE_END_KEY });
    const end = read('doc').lines.at(-1).end;
    assert.deepEqual(selection(), [end, end], "the caret is not at the note's end");
    await run(noteId, created);
  } finally {
    const remaining = read('notes').notes;
    for (const id of created) {
      if (!remaining.includes(id)) continue;
      onRow('OpenNoteContextMenu', { noteId: id });
      act('do', 'DeleteNote');
      act('do', 'ConfirmDialog');
    }
  }
}

const ROWS = Array.from({ length: 60 }, (_, index) => `row ${index + 1}`).join('\n');
const ROW_ONE_EDITED = ROWS.replace('row 1\n', 'row 1 edited elsewhere\n');
const INSERTED = ' edited elsewhere'.length;

await story(
  'a clean note takes an outside edit in place, the caret with its text and Undo kept',
  () =>
    inOwnNote(ROWS, async (noteId) => {
      act('type', { text: ' typed' });
      await untilIdle();
      const [from] = selection();
      const scrolled = editorBox().y;
      const written = ROW_ONE_EDITED + ' typed';
      writeFileSync(fileOf(noteId), written);
      const modified = statSync(fileOf(noteId)).mtimeMs;
      await eventually(() => source() === written, 'the editor took the outside edit');
      assert.deepEqual(selection(), [from + INSERTED, from + INSERTED], 'the caret left its text');
      assert.equal(editorBox().y, scrolled, 'the pane kept its scroll');
      await untilIdle();
      assert.equal(statSync(fileOf(noteId)).mtimeMs, modified, 'taking it wrote the note again');
      act('do', 'Undo');
      assert.equal(
        source(),
        ROW_ONE_EDITED,
        'Undo did not remove the typing, or took the outside edit',
      );
    }),
);

// The outside write races the host's save of the typed text (500 ms after the last key); it
// is written the moment `type` returns, well inside that window.
await story('unsaved edits merge with an outside edit to another line', () =>
  inOwnNote(ROWS, async (noteId, created) => {
    act('type', { text: ' typed' });
    writeFileSync(fileOf(noteId), ROW_ONE_EDITED);
    const both = ROW_ONE_EDITED + ' typed';
    await eventually(() => source() === both, 'the editor took the merge');
    await untilIdle();
    for (const id of copiesOf(noteId)) created.add(id);
    assert.equal(readFileSync(fileOf(noteId), 'utf8'), both);
    assert.equal(noteNow(), noteId);
    assert.deepEqual(copiesOf(noteId), [], 'the merge parked a copy');
    act('do', 'Undo');
    assert.equal(
      source(),
      ROW_ONE_EDITED,
      'Undo did not remove the typing, or took the outside edit',
    );
    await untilIdle();
    assert.equal(readFileSync(fileOf(noteId), 'utf8'), ROW_ONE_EDITED);
  }),
);

// The lines share a word ("line"), which made the engine call the two edits ambiguous and the
// editor re-open the note: a line break between them is a hard boundary.
await story('an outside edit on the line above saved typing is taken in place, Undo kept', () =>
  inOwnNote('alpha line\nbeta line\ngamma line', async (noteId) => {
    act('type', { text: ' word' });
    await untilIdle();
    const [caret] = selection();
    const outside = 'alpha line\nBETA LINE from outside\ngamma line word';
    writeFileSync(fileOf(noteId), outside);
    await eventually(() => source() === outside, 'the editor took the outside edit');
    const grown = 'BETA LINE from outside'.length - 'beta line'.length;
    assert.deepEqual(selection(), [caret + grown, caret + grown], 'the caret left its text');
    act('do', 'Undo');
    assert.equal(source(), outside.slice(0, -' word'.length), 'Undo did not undo the typing');
    await untilIdle();
    assert.equal(noteNow(), noteId);
  }),
);

await story('unsaved edits at the place an outside edit changed park in a conflict copy', () =>
  inOwnNote('shared line', async (noteId, created) => {
    act('type', { text: ' typed here' });
    writeFileSync(fileOf(noteId), 'shared line written elsewhere');
    const copy = await eventually(() => noteNow() !== noteId && noteNow(), 'the draft parked');
    created.add(copy);
    assert.equal(source(), 'shared line typed here', 'the editor shows the draft');
    await untilIdle();
    assert.equal(readFileSync(fileOf(copy), 'utf8'), 'shared line typed here');
    assert.equal(readFileSync(fileOf(noteId), 'utf8'), 'shared line written elsewhere');
    act('type', { text: '!' });
    await untilIdle();
    assert.equal(readFileSync(fileOf(copy), 'utf8'), 'shared line typed here!');
    assert.equal(readFileSync(fileOf(noteId), 'utf8'), 'shared line written elsewhere');
  }),
);

await story('a focused clean note takes an outside edit at once', () =>
  inOwnNote('first line\nsecond line', async (noteId) => {
    act('do', 'PlaceCaret', { at: read('doc').lines[1].at + 'second'.length });
    await untilIdle();
    assert.equal(read('state').editor.focused, true, 'the editor lost the focus');
    const [from] = selection();
    const written = 'outside first line\nsecond line';
    writeFileSync(fileOf(noteId), written);
    await eventually(() => source() === written, 'the focused editor took the outside edit');
    assert.equal(read('state').editor.focused, true, 'taking it moved the focus');
    assert.deepEqual(selection(), [from + 'outside '.length, from + 'outside '.length]);
  }),
);

await story('an outside edit to front matter re-opens the note on the merged text', () =>
  inOwnNote('body', async (noteId, created) => {
    writeFileSync(fileOf(noteId), '---\ntitle: a\n---\nbody');
    await eventually(() => source() === '---\ntitle: a\n---\nbody', 'the editor took it');
    act('do', 'PlaceCaret', { at: read('doc').lines.at(-1).end });
    act('type', { text: ' typed' });
    writeFileSync(fileOf(noteId), '---\ntitle: b\n---\nbody');
    const both = '---\ntitle: b\n---\nbody typed';
    await eventually(() => source() === both, 'the editor re-opened on the merge');
    await untilIdle();
    for (const id of copiesOf(noteId)) created.add(id);
    assert.equal(readFileSync(fileOf(noteId), 'utf8'), both);
    assert.deepEqual(copiesOf(noteId), [], 'the merge parked a copy');
    act('do', 'Undo');
    assert.equal(source(), both, 'Undo survived the re-open');
  }),
);

await story('two outside edits in a row both reach a dirty editor', () =>
  inOwnNote('alpha\nbeta\ngamma', async (noteId, created) => {
    act('type', { text: ' typed' });
    writeFileSync(fileOf(noteId), 'ALPHA\nbeta\ngamma');
    await eventually(() => source() === 'ALPHA\nbeta\ngamma typed', 'the first merge');
    act('type', { text: ' more' });
    writeFileSync(fileOf(noteId), 'ALPHA\nBETA\ngamma typed');
    const all = 'ALPHA\nBETA\ngamma typed more';
    await eventually(() => source() === all, 'the second merge');
    await untilIdle();
    for (const id of copiesOf(noteId)) created.add(id);
    assert.equal(readFileSync(fileOf(noteId), 'utf8'), all);
    assert.deepEqual(copiesOf(noteId), [], 'a merge parked a copy');
  }),
);

await story('a rename outside the app keeps the editor on the note, its draft and Undo', () =>
  inOwnNote('renamed', async (noteId, created) => {
    const renamedId = `${noteId} moved by a story`;
    created.add(renamedId);
    act('type', { text: ' then typed' });
    await untilIdle();
    renameSync(fileOf(noteId), fileOf(renamedId));
    await eventually(() => noteNow() === renamedId, 'the editor followed the rename');
    assert.equal(source(), 'renamed then typed');
    act('do', 'Undo');
    const undone = source();
    assert.notEqual(undone, 'renamed then typed', 'the rename emptied Undo');
    await untilIdle();
    assert.equal(readFileSync(fileOf(renamedId), 'utf8'), undone);
    assert.ok(!existsSync(fileOf(noteId)), 'a save recreated the old name');
  }),
);

await story('a delete outside the app closes a clean note and writes nothing', () =>
  inOwnNote('to be deleted', async (noteId) => {
    rmSync(fileOf(noteId));
    await eventually(() => noteNow() === null, 'the editor let the note go');
    await sleep(1000);
    assert.ok(!existsSync(fileOf(noteId)), 'the deleted note came back');
    assert.ok(!read('notes').notes.includes(noteId));
  }),
);

// The delete races the host's save of the typed text, as the merge story's write does.
await story(
  'a delete outside the app keeps unsaved edits, says so, and saves them at the note',
  () =>
    inOwnNote('kept', async (noteId) => {
      act('type', { text: ' after all' });
      rmSync(fileOf(noteId));
      await eventually(
        () => toast() === 'Open note was deleted; keeping local draft',
        'the draft-kept message',
      );
      await untilIdle();
      assert.equal(noteNow(), noteId);
      assert.equal(readFileSync(fileOf(noteId), 'utf8'), 'kept after all');
    }),
);

finish('outside-change stories');

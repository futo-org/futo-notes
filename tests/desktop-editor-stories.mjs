// The desktop editor's stories: real input through `just puppet` into this worktree's
// running `just tauri-dev`, checked against Puppet's JSON reads and the file on disk.
// `node tests/desktop-editor-stories.mjs [filter]` runs the stories whose name holds the filter.
import assert from 'node:assert/strict';
import {
  act,
  appleStory,
  finish,
  inNewNote,
  lines,
  read,
  story,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

await story('typing, deleting, Undo and Redo with real keys save the note', () =>
  inNewNote(async (noteId) => {
    act('type', { text: '# Title\nfirst line' });
    assert.deepEqual(lines(), [
      ['heading1', 'Title'],
      ['paragraph', 'first line'],
    ]);
    act('press', { key: 'Backspace', count: 4 });
    assert.equal(lines()[1][1], 'first ');
    // A run of Backspaces is one Undo step, and so is a run of typing.
    act('press', { key: 'Mod-z' });
    assert.equal(lines()[1][1], 'first line');
    act('press', { key: 'Shift-Mod-z' });
    assert.equal(lines()[1][1], 'first ');
    act('press', { key: 'Mod-z' });
    act('press', { key: 'Enter' });
    act('type', { text: 'second' });
    assert.deepEqual(lines(), [
      ['heading1', 'Title'],
      ['paragraph', 'first line'],
      ['paragraph', 'second'],
    ]);
    await untilIdle();
    const file = read('file', { noteId, save: false });
    assert.deepEqual(
      file.lines.map((line) => line.text),
      ['# Title', 'first line', 'second'],
    );
    assert.ok(read('state').editor.typing.count >= 25, 'every keystroke is timed');
  }),
);

await story('Enter then Backspace at the end of a note leaves the caret where it was', () =>
  inNewNote(async () => {
    act('type', { text: 'ab' });
    const before = read('state').editor.caret;
    act('press', { key: 'Enter' });
    act('press', { key: 'Backspace' });
    // The removed line took the browser's selection with it: the caret must still be drawn
    // at the end of `ab`, where the next keystroke lands.
    assert.deepEqual(read('state').editor.caret, before);
    act('type', { text: 'c' });
    assert.deepEqual(lines(), [['paragraph', 'abc']]);
  }),
);

await story('a word deleted in one step, then a rename keeps the body under the new name', () =>
  inNewNote(async (noteId) => {
    act('type', { text: 'keep this word' });
    act('do', 'Press', { key: 'Alt-Backspace' });
    assert.deepEqual(lines(), [['paragraph', 'keep this ']]);
    act('do', 'SetTitle', { title: 'story renamed' });
    assert.equal(read('state').note.id, 'story renamed');
    await untilIdle();
    assert.ok(!read('notes').notes.includes(noteId), 'the old name is gone');
    const file = read('file', { noteId: 'story renamed', save: false });
    assert.deepEqual(
      file.lines.map((line) => line.text),
      ['keep this '],
    );
  }),
);

await story('a press on the chrome takes the caret away, and keys type nothing', () =>
  inNewNote(async () => {
    act('type', { text: 'first' });
    const caret = read('state').editor.caret;
    const rows = read('elements').elements;
    const body = rows.find((row) => row.component === 'DesktopEditor.svelte').rect;
    // The tag bar's strip just above the body: chrome, under the arrow.
    const chrome = { x: body.x + body.w / 2, y: body.y - 4 };
    assert.equal(read('at', chrome).cursor, 'default');
    act('click', chrome);
    assert.equal(read('state').editor.focused, false);
    assert.equal(read('state').editor.caret, null);
    act('type', { text: 'zz' });
    assert.deepEqual(lines(), [['paragraph', 'first']]);
    // The same press takes focus off the title, which commits its rename.
    const title = { ref: rows.find((row) => row.verb === 'SetTitle').ref };
    act('click', title);
    act('type', { text: 'chrome story' });
    act('click', chrome);
    await untilIdle();
    assert.equal(read('state').note.id, 'chrome story');
    // Enter in the title goes back to the body, at the caret it had.
    act('click', title);
    act('press', { key: 'Enter' });
    assert.deepEqual(read('state').editor.caret, caret);
    act('type', { text: '!' });
    assert.deepEqual(lines(), [['paragraph', 'first!']]);
  }),
);

await story('Mod+Enter opens a line below the caret, Shift+Mod+Enter one above', () =>
  inNewNote(async () => {
    act('type', { text: '# Title\nmiddle' });
    act('do', 'PlaceCaret', { at: 8 });
    act('press', { key: 'Mod-Enter' });
    act('type', { text: 'below' });
    act('do', 'PlaceCaret', { at: 2 });
    act('press', { key: 'Shift-Mod-Enter' });
    act('type', { text: 'above' });
    assert.deepEqual(lines(), [
      ['paragraph', 'above'],
      ['heading1', 'Title'],
      ['paragraph', 'middle'],
      ['paragraph', 'below'],
    ]);
    // One Undo takes back the typing, the next the line.
    act('press', { key: 'Mod-z' });
    act('press', { key: 'Mod-z' });
    assert.equal(lines()[0][0], 'heading1');
  }),
);

await story(
  'Backspace at the start of a heading takes the blank line above, and it stays a heading',
  () =>
    inNewNote(async (noteId) => {
      act('type', { text: 'para\n\n# Title' });
      act('do', 'PlaceCaret', { at: 6 });
      act('press', { key: 'Backspace' });
      assert.deepEqual(lines(), [
        ['paragraph', 'para'],
        ['heading1', 'Title'],
      ]);
      await untilIdle();
      const file = read('file', { noteId, save: false });
      assert.deepEqual(
        file.lines.map((line) => line.text),
        ['para', '# Title'],
      );
    }),
);

await story('Tab and Shift+Tab on a plain line change nothing and insert no tab', () =>
  inNewNote(async (noteId) => {
    act('type', { text: 'ab' });
    act('press', { key: 'Tab' });
    act('type', { text: 'c' });
    assert.deepEqual(lines(), [['paragraph', 'abc']]);
    act('press', { key: 'Shift-Tab' });
    assert.deepEqual(lines(), [['paragraph', 'abc']]);
    await untilIdle();
    const file = read('file', { noteId, save: false });
    assert.deepEqual(
      file.lines.map((line) => line.text),
      ['abc'],
    );
  }),
);

await appleStory('Ctrl+T swaps the characters at the caret, and Undo puts the caret back', () =>
  inNewNote(async () => {
    act('type', { text: 'abcd' });
    act('do', 'PlaceCaret', { at: 2 });
    act('press', { key: 'Ctrl-t' });
    assert.deepEqual(lines(), [['paragraph', 'acbd']]);
    act('press', { key: 'Mod-z' });
    assert.deepEqual(lines(), [['paragraph', 'abcd']]);
    const { from, to } = read('state').editor.selection;
    assert.deepEqual([from, to], [2, 2]);
  }),
);

await story('a control character from a quoted key types nothing', () =>
  inNewNote(async () => {
    // Ctrl+Q, Ctrl+Q sends U+0011 as text; Ctrl+Option+A sends U+0001.
    act('do', 'Type', { text: 'a\u0011\u0001b' });
    assert.deepEqual(lines(), [['paragraph', 'ab']]);
  }),
);

await appleStory('Ctrl+Q does nothing, and the key after it does its own job', () =>
  inNewNote(async () => {
    act('type', { text: 'abc' });
    act('press', { key: 'Ctrl-q' });
    act('press', { key: 'Backspace' });
    assert.deepEqual(lines(), [['paragraph', 'ab']]);
  }),
);

await appleStory('Ctrl+K kills to the line end and its break, and Ctrl+Y puts them back', () =>
  inNewNote(async () => {
    act('type', { text: 'keep cut\nnext' });
    act('do', 'PlaceCaret', { at: 4 });
    act('press', { key: 'Ctrl-k' });
    assert.deepEqual(lines(), [
      ['paragraph', 'keep'],
      ['paragraph', 'next'],
    ]);
    act('press', { key: 'Ctrl-k' });
    assert.deepEqual(lines(), [['paragraph', 'keepnext']]);
    act('press', { key: 'Ctrl-y' });
    assert.deepEqual(lines(), [
      ['paragraph', 'keep cut'],
      ['paragraph', 'next'],
    ]);
  }),
);

await appleStory('Ctrl+O splits the line and leaves the caret before the break', () =>
  inNewNote(async () => {
    act('type', { text: 'ab' });
    act('do', 'PlaceCaret', { at: 1 });
    act('press', { key: 'Ctrl-o' });
    assert.deepEqual(lines(), [
      ['paragraph', 'a'],
      ['paragraph', 'b'],
    ]);
    assert.equal(read('state').editor.selection.from, 1);
  }),
);

// Copied from a web page: the HTML form carries the formatting, the plain form only text.
const copiedPage = {
  text: 'Title\nbold and plain',
  html: '<h2>Title</h2><p><strong>bold</strong> and plain</p>',
};

await story('Paste, and Paste and Match Style, paste the plain text read as Markdown', () =>
  inNewNote(async (noteId) => {
    act('clipboard', copiedPage);
    act('do', 'Paste');
    act('press', { key: 'Enter' });
    act('clipboard', { ...copiedPage, text: '**bold** and plain' });
    act('do', 'PasteAndMatchStyle');
    assert.deepEqual(lines(), [
      ['paragraph', 'Title'],
      ['paragraph', 'bold and plain'],
      ['paragraph', 'bold and plain'],
    ]);
    await untilIdle();
    const file = read('file', { noteId, save: false });
    assert.deepEqual(
      file.lines.map((line) => line.text),
      ['Title', 'bold and plain', '**bold** and plain'],
    );
  }),
);

finish('desktop editor stories');

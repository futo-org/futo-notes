// The selection toolbar's block buttons: Heading 1, 2 and 3 and Quote ahead of the inline
// formats (desktop-editor-format-stories.mjs has those), each the engine's toggle under a real
// click, the selection kept and one Undo step. Content comes in through Paste.
// `node tests/desktop-editor-toolbar-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
  lines,
  pasted,
  read,
  selection,
  story,
  until,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

const toolbarButtons = () =>
  read('elements').elements.filter((element) => element.component === 'FormatToolbar.svelte');
const shownButtons = () =>
  until(() => toolbarButtons().length > 0 && toolbarButtons(), 'the toolbar shows');
const litButtons = () =>
  toolbarButtons()
    .filter((button) => button.flags.includes('pressed'))
    .map((button) => button.text);
const click = (text) =>
  act('click', { ref: toolbarButtons().find((found) => found.text === text).ref });
const saved = async (noteId) => {
  await untilIdle();
  return read('file', { noteId, save: false }).lines.map((line) => line.text);
};

await story('the toolbar offers Heading 1–3 and Quote before the inline formats, no Text', () =>
  inScratchNote(async () => {
    // Display: "plain code end" 0..14.
    pasted('plain `code` end');
    act('do', 'Select', { from: 0, to: 5 });
    assert.deepEqual(
      (await shownButtons()).map((button) => button.text),
      [
        'Heading 1',
        'Heading 2',
        'Heading 3',
        'Block quote',
        'Bold',
        'Italic',
        'Strikethrough',
        'Code',
        'Link',
      ],
    );
    // Inside inline code the inline formats grey out; the line's block buttons do not.
    act('do', 'Select', { from: 7, to: 9 });
    const blocks = (await shownButtons()).slice(0, 4);
    assert.ok(blocks.every((button) => !button.flags.includes('disabled')));
  }),
);

await story('a heading button sets the level, a second press makes the lines text', () =>
  inScratchNote(async (noteId) => {
    // Display: "one" 0..3, "two" 4..7.
    pasted('one\ntwo');
    act('do', 'Select', { from: 1, to: 6 });
    await shownButtons();
    click('Heading 2');
    assert.deepEqual(lines(), [
      ['heading2', 'one'],
      ['heading2', 'two'],
    ]);
    assert.deepEqual(selection(), [1, 6]);
    assert.equal(read('state').editor.focused, true);
    assert.deepEqual(await saved(noteId), ['## one', '## two']);
    assert.deepEqual(litButtons(), ['Heading 2'], 'the level the lines share is lit');
    click('Heading 2');
    assert.deepEqual(await saved(noteId), ['one', 'two']);
    assert.deepEqual(litButtons(), []);
    assert.deepEqual(selection(), [1, 6]);
    // Another level on a heading sets that level; one Undo takes one press back.
    click('Heading 1');
    click('Heading 3');
    assert.deepEqual(await saved(noteId), ['### one', '### two']);
    act('press', { key: 'Mod-z' });
    assert.deepEqual(await saved(noteId), ['# one', '# two']);
  }),
);

await story('Quote adds a quote level and a second press takes it off, list markers kept', () =>
  inScratchNote(async (noteId) => {
    pasted('- item\nplain');
    act('do', 'Select', { from: 0, to: read('doc').lines[1].end });
    await shownButtons();
    click('Block quote');
    assert.deepEqual(await saved(noteId), ['> - item', '> plain']);
    click('Block quote');
    assert.deepEqual(await saved(noteId), ['- item', 'plain']);
    act('press', { key: 'Mod-z' });
    assert.deepEqual(await saved(noteId), ['> - item', '> plain']);
  }),
);

await story('over text through a code block, the block buttons change only the text lines', () =>
  inScratchNote(async (noteId) => {
    pasted('one\n```\ncode\n```\ntwo');
    const doc = read('doc').lines;
    act('do', 'Select', { from: 0, to: doc[doc.length - 1].end });
    await shownButtons();
    click('Heading 1');
    assert.deepEqual(await saved(noteId), ['# one', '```', 'code', '```', '# two']);
  }),
);

await story('over only table lines, the heading buttons and Quote grey out', () =>
  inScratchNote(async () => {
    pasted('one\n| a | b |\n|---|---|\n| c | d |\ntwo');
    const doc = read('doc').lines;
    act('do', 'Select', { from: doc[1].at + 2, to: doc[3].end - 2 });
    const blocks = (await shownButtons()).slice(0, 4);
    assert.deepEqual(
      blocks.map((button) => [button.text, button.flags.includes('disabled')]),
      [
        ['Heading 1', true],
        ['Heading 2', true],
        ['Heading 3', true],
        ['Block quote', true],
      ],
    );
    // With a text line in the selection they apply again.
    act('do', 'Select', { from: 1, to: doc[3].end - 2 });
    const mixed = (await shownButtons()).slice(0, 4);
    assert.ok(mixed.every((button) => !button.flags.includes('disabled')));
  }),
);

await story('over text through a table, the formats change only the text lines', () =>
  inScratchNote(async (noteId) => {
    const table = ['| a | b |', '|---|---|', '| c | d |'];
    pasted(['one', ...table, 'two'].join('\n'));
    assert.deepEqual(await saved(noteId), ['one', ...table, 'two']);
    const selectAll = async () => {
      const doc = read('doc').lines;
      act('do', 'Select', { from: 0, to: doc[doc.length - 1].end });
      await shownButtons();
    };
    const changed = {
      Bold: ['**one**', '**two**'],
      Italic: ['*one*', '*two*'],
      Strikethrough: ['~~one~~', '~~two~~'],
      Code: ['`one`', '`two`'],
      'Block quote': ['> one', '> two'],
    };
    for (const [name, [first, last]] of Object.entries(changed)) {
      await selectAll();
      click(name);
      assert.deepEqual(await saved(noteId), [first, ...table, last], name);
      act('press', { key: 'Mod-z' });
      assert.deepEqual(await saved(noteId), ['one', ...table, 'two'], `${name} undone`);
    }
    await selectAll();
    click('Link');
    // The prompt's field has focus as it opens: the address is typed, not set.
    act('type', { text: 'https://x.test' });
    act('press', { key: 'Enter' });
    assert.deepEqual(await saved(noteId), [
      '[one](https://x.test)',
      ...table,
      '[two](https://x.test)',
    ]);
  }),
);

finish('desktop editor toolbar stories');

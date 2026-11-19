// Links and wikilinks in the desktop editor (docs/spec/editor/desktop/links.md): real input
// through `just puppet`, checked against the engine's selection, the open note and the file.
// The dev vault holds "another note" (desktop-editor-story.mjs `inScratchNote`).
// `node tests/desktop-editor-link-stories.mjs [filter]` runs the stories whose name holds it.
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

async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

const shown = (text) => read('show', { text }).rect;
/** On the row of `text`, `dx` px right of its first character's left edge. */
const at = (text, dx = 3) => {
  const rect = shown(text);
  return { x: rect.x + dx, y: rect.y + rect.h / 2 };
};
/** A wikilink's own text draws at no size, so its label is found from the plain text before
 *  it: a point 6 px past the end of `before` (its space included), on its row. */
const after = (before) => {
  const rect = shown(before);
  return { x: rect.x + rect.w + 6, y: rect.y + rect.h / 2 };
};

await story('a link shows its label and a web address shows as itself; both stay as typed', () =>
  inScratchNote(async (noteId) => {
    pasted('see [docs](https://x.test) and https://y.test now');
    assert.equal(read('doc').lines[0].text, 'see docs and https://y.test now');
    assert.equal(await saved(noteId), 'see [docs](https://x.test) and https://y.test now');
  }),
);

await story('a letter typed at a link label’s end or start is outside the link', () =>
  inScratchNote(async (noteId) => {
    // Display: "a b c": the label "b" 2..3.
    pasted('a [b](u) c');
    act('do', 'PlaceCaret', { at: 3 });
    act('type', { text: 'X' });
    act('do', 'PlaceCaret', { at: 2 });
    act('type', { text: 'Y' });
    assert.equal(await saved(noteId), 'a Y[b](u)X c');
  }),
);

await story('a press that drags from a link selects and opens nothing', () =>
  inScratchNote(async (noteId) => {
    pasted('go [[another note]] now');
    // Display: "go " 0..3, the wikilink 3..19, " now" 19..23.
    const from = after('go');
    const to = at('now', shown('now').w + 2);
    act('drag', { x: from.x, y: from.y, x2: to.x, y2: to.y });
    assert.equal(read('state').note.id, noteId);
    assert.deepEqual(selection(), [3, 23]);
  }),
);

await story('a click past a link’s end places the caret and opens nothing', () =>
  inScratchNote(async (noteId) => {
    pasted('go [[another note]]');
    const box = read('elements').elements.find(
      (element) => element.component === 'DesktopEditor.svelte',
    ).rect;
    act('click', { x: box.x + box.w - 4, y: after('go').y });
    assert.equal(read('state').note.id, noteId);
    assert.deepEqual(selection(), [19, 19]);
  }),
);

await story('a click on a wikilink opens its note', () =>
  inScratchNote(async () => {
    pasted('go [[another note]] now');
    act('click', after('go'));
    await until(() => read('state').note?.id === 'another note', 'the linked note opens');
  }),
);

await story('a click on a wikilink to no note opens a new note with its name', () =>
  inScratchNote(async () => {
    pasted('go [[link story missing]] now');
    act('click', after('go'));
    await until(() => read('state').note?.id === 'link story missing', 'the new note opens');
    // Left untouched, it is deleted again on the way back.
    onRow('OpenNote', { noteId: 'another note' });
    await until(
      () => !read('notes').notes.includes('link story missing'),
      'the untouched note is deleted',
    );
  }),
);

await story('the caret steps over a wikilink and Backspace takes it whole, Undo back', () =>
  inScratchNote(async (noteId) => {
    pasted('go [[another note]] now');
    act('do', 'PlaceCaret', { at: 19 });
    act('press', { key: 'ArrowLeft' });
    assert.deepEqual(selection(), [3, 3]);
    act('press', { key: 'ArrowRight' });
    assert.deepEqual(selection(), [19, 19]);
    act('press', { key: 'Shift-ArrowLeft' });
    assert.deepEqual(selection(), [3, 19]);
    act('do', 'PlaceCaret', { at: 19 });
    act('press', { key: 'Backspace' });
    assert.equal(await saved(noteId), 'go  now');
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), 'go [[another note]] now');
  }),
);

await story('typing [[ lists the notes; Enter writes the full id and the caret goes after it', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: 'see [[anoth' });
    await until(
      () => read('elements').elements.some((element) => element.role === 'listbox'),
      'the list shows',
    );
    act('press', { key: 'Enter' });
    assert.equal(await saved(noteId), 'see [[another note]]');
    assert.deepEqual(selection(), [20, 20]);
    act('press', { key: 'Mod-z' });
    // `[[` paired to `[[|]]` as it was typed (portable-core/paired-typing.md).
    assert.equal(await saved(noteId), 'see [[anoth]]');
  }),
);

await story('in a list item Enter accepts the list’s note before it opens a new item', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '- [[anoth' });
    await until(
      () => read('elements').elements.some((element) => element.role === 'listbox'),
      'the list shows',
    );
    act('press', { key: 'Enter' });
    assert.equal(await saved(noteId), '- [[another note]]');
  }),
);

await story('Escape closes the list and keeps what was typed while the run is typed on', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '- [[anoth' });
    await until(
      () => read('elements').elements.some((element) => element.role === 'listbox'),
      'the list shows',
    );
    act('press', { key: 'Escape' });
    act('type', { text: 'e' });
    assert.ok(!read('elements').elements.some((element) => element.role === 'listbox'));
    // `[[` paired to `[[|]]` as it was typed (portable-core/paired-typing.md).
    assert.equal(await saved(noteId), '- [[anothe]]');
  }),
);

await story('the list accepts with an ]] already after the caret', () =>
  inScratchNote(async (noteId) => {
    pasted('see [[]] now');
    act('do', 'PlaceCaret', { at: 6 });
    act('type', { text: 'anoth' });
    await until(
      () => read('elements').elements.some((element) => element.role === 'listbox'),
      'the list shows',
    );
    act('press', { key: 'Tab' });
    assert.equal(await saved(noteId), 'see [[another note]] now');
  }),
);

await story('a click on a link to a note opens it; to a path no note holds does nothing', () =>
  inScratchNote(async (noteId) => {
    pasted('go [the other](another%20note) or [gone](link%20story%20gone) now');
    const opened = read('state').opened;
    act('click', at('gone'));
    assert.equal(read('state').note.id, noteId);
    assert.deepEqual(read('state').opened, opened);
    assert.ok(!read('notes').notes.includes('link story gone'));
    act('click', at('the other'));
    await until(() => read('state').note?.id === 'another note', 'the linked note opens');
  }),
);

await story('a click on a web address opens it outside the app', () =>
  inScratchNote(async () => {
    pasted('see [docs](https://x.test/link-story) now');
    const count = read('state').opened?.count ?? 0;
    act('click', at('docs'));
    await until(() => (read('state').opened?.count ?? 0) > count, 'the address opens');
    assert.equal(read('state').opened.url, 'https://x.test/link-story');
  }),
);

await story('the Link prompt saves a web address with https and a note path as typed', () =>
  inScratchNote(async (noteId) => {
    pasted('see docs and plan now');
    act('do', 'Select', { from: 4, to: 8 });
    act('press', { key: 'Mod-k' });
    // The prompt's field has focus as it opens: the address is typed, not set.
    act('type', { text: 'example.com' });
    act('press', { key: 'Enter' });
    assert.equal(await saved(noteId), 'see [docs](https://example.com) and plan now');
    act('do', 'Select', { from: 13, to: 17 });
    act('press', { key: 'Mod-k' });
    act('do', 'SetLinkUrl', { url: 'Projects/plan.md' });
    act('do', 'ApplyLink');
    assert.equal(
      await saved(noteId),
      'see [docs](https://example.com) and [plan](Projects/plan.md) now',
    );
  }),
);

await story('Mod+K links the selection, updates a link and an empty field unlinks it', () =>
  inScratchNote(async (noteId) => {
    pasted('see docs now');
    act('do', 'Select', { from: 4, to: 8 });
    act('press', { key: 'Mod-k' });
    act('do', 'SetLinkUrl', { url: 'https://x.test' });
    act('do', 'ApplyLink');
    assert.equal(await saved(noteId), 'see [docs](https://x.test) now');
    act('do', 'PlaceCaret', { at: 6 });
    act('press', { key: 'Mod-k' });
    act('do', 'SetLinkUrl', { url: 'https://y.test' });
    act('do', 'ApplyLink');
    assert.equal(await saved(noteId), 'see [docs](https://y.test) now');
    act('do', 'Select', { from: 5, to: 7 });
    act('press', { key: 'Mod-k' });
    act('do', 'SetLinkUrl', { url: '' });
    act('do', 'ApplyLink');
    assert.equal(await saved(noteId), 'see docs now');
  }),
);

await story('the Link prompt at a plain caret inserts the address; Cancel changes nothing', () =>
  inScratchNote(async (noteId) => {
    pasted('see  now');
    act('do', 'PlaceCaret', { at: 4 });
    act('press', { key: 'Mod-k' });
    act('do', 'SetLinkUrl', { url: 'https://z.test' });
    act('do', 'CancelLink');
    assert.equal(await saved(noteId), 'see  now');
    act('do', 'PlaceCaret', { at: 4 });
    act('press', { key: 'Mod-k' });
    act('do', 'SetLinkUrl', { url: 'https://z.test' });
    act('do', 'ApplyLink');
    assert.equal(await saved(noteId), 'see https://z.test now');
    assert.deepEqual(selection(), [18, 18]);
  }),
);

await story('the toolbar’s Link button is lit on a link and opens the prompt', () =>
  inScratchNote(async () => {
    pasted('see [docs](https://x.test) now');
    act('do', 'Select', { from: 5, to: 7 });
    const link = await until(
      () =>
        read('elements').elements.find(
          (element) => element.component === 'FormatToolbar.svelte' && element.text === 'Link',
        ),
      'the toolbar shows Link',
    );
    assert.ok(link.flags.includes('pressed'), JSON.stringify(link));
    act('click', { ref: link.ref });
    await until(
      // Puppet names a button by its accessible name: the Update button's is "Update link".
      () => read('elements').elements.some((element) => element.text === 'Update link'),
      'the prompt opens to Update',
    );
    act('do', 'CancelLink');
  }),
);

await story('the caret before a wikilink pushed onto the next row stands at its label', () =>
  inScratchNote(async () => {
    const wikilink = '[[another note]]';
    const caretAt = async (offset) => {
      act('do', 'PlaceCaret', { at: offset });
      return until(() => read('state').editor.caret, 'the caret draws');
    };
    // The label's first word, measured as plain text, and the row's right edge in the caret's
    // coordinates.
    pasted('another');
    const word = shown('another');
    act('click', { x: word.x + 1, y: word.y + word.h / 2 });
    const firstRow = await caretAt(0);
    const toCaret = word.x - firstRow.left;
    const line = read('at', { x: word.x + 1, y: word.y + word.h / 2 }).stack[1].rect;
    const rowRight = line.x + line.w - toCaret;
    // More words before the wikilink, until the whole label starts the next row: on the row it
    // starts, the caret before it must stand with room for its first word.
    for (let count = 1; count < 40; count++) {
      act('do', 'Select', { from: 0, to: read('doc').lines[0].end });
      pasted(`${'word '.repeat(count)}${wikilink} tail`);
      const start = read('doc').lines[0].text.indexOf(wikilink);
      const [before, end] = [await caretAt(start), await caretAt(start + wikilink.length)];
      if (Math.abs(before.top - end.top) < 1) {
        if (Math.abs(before.top - firstRow.top) < 1) continue;
        return;
      }
      assert.ok(rowRight - before.left >= word.w, `the caret stands at ${before.left}, row end`);
      // Its label wraps: selected, it is highlighted on each of its rows, not past its end.
      act('do', 'Select', { from: start, to: start + wikilink.length });
      const tail = shown('tail');
      const bandsUnder = (point) =>
        read('at', point).stack.filter(
          (entry) => entry.flags.includes('passes') && entry.rect.h < 100,
        );
      await until(() => bandsUnder({ x: word.x + 2, y: tail.y + tail.h / 2 }).length, 'a band');
      assert.equal(bandsUnder({ x: tail.x + 2, y: tail.y + tail.h / 2 }).length, 0, 'tail lit');
    }
    assert.fail('the wikilink never started the next row');
  }),
);

finish('link stories');

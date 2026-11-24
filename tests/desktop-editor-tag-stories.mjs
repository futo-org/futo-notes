// Tags and front matter in the desktop editor (docs/spec/editor/desktop/tags.md): real input
// through `just puppet`, checked against the engine's selection, the shown lines and the file.
// `node tests/desktop-editor-tag-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
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

const shownLines = () => read('doc').lines.map((line) => line.text);

await story('the tag bar adds a tag as the header block, one Undo step', () =>
  inScratchNote(async (noteId) => {
    pasted('some body');
    act('do', 'StartAddingTag', { name: 'Recipes' });
    assert.equal(await saved(noteId), '#recipes\n\nsome body');
    assert.deepEqual(shownLines(), ['#recipes', '', 'some body']);
    act('do', 'PlaceCaret', { at: 0 });
    act('do', 'Undo');
    assert.equal(await saved(noteId), 'some body');
  }),
);

await story('a tag typed in the field commits on a comma, after the tags there', () =>
  inScratchNote(async (noteId) => {
    pasted('#a\n\nsome body');
    act('do', 'StartAddingTag');
    // Into the field as a person would: a background window may not run the frame that
    // focuses it.
    const field = read('elements').elements.find(
      (element) => element.component === 'NoteTagBar.svelte' && element.role === 'text',
    );
    act('click', { x: field.rect.x + field.rect.w / 2, y: field.rect.y + field.rect.h / 2 });
    act('type', { text: 'work' });
    act('press', { key: ',' });
    assert.equal(await saved(noteId), '#a #work\n\nsome body');
  }),
);

await story('the field stays for the next tag; an empty Enter returns to the note', () =>
  inScratchNote(async (noteId) => {
    pasted('some body');
    act('do', 'StartAddingTag');
    const field = read('elements').elements.find(
      (element) => element.component === 'NoteTagBar.svelte' && element.role === 'text',
    );
    act('click', { x: field.rect.x + field.rect.w / 2, y: field.rect.y + field.rect.h / 2 });
    act('type', { text: 'one' });
    act('press', { key: 'Enter' });
    act('type', { text: 'two' });
    act('press', { key: 'Enter' });
    assert.equal(await saved(noteId), '#one #two\n\nsome body');
    act('press', { key: 'Enter' });
    assert.equal(read('state').editor.focused, true);
    act('type', { text: 'x' });
    assert.equal(await saved(noteId), '#one #two\n\nsome bodyx');
  }),
);

await story('a tag bar edit keeps the note’s selection on its text', () =>
  inScratchNote(async (noteId) => {
    pasted('#a\n\nsome body');
    // "body" in the display "#a\n\nsome body".
    act('do', 'Select', { from: 9, to: 13 });
    act('do', 'StartAddingTag', { name: 'work' });
    assert.equal(await saved(noteId), '#a #work\n\nsome body');
    assert.deepEqual(selection(), [15, 19]);
  }),
);

await story('removing the last chip removes the header block and its blank line', () =>
  inScratchNote(async (noteId) => {
    pasted('#a #b\n\nsome body');
    // The chips follow an edit with the editor's coalesced change report, not on its frame.
    await until(
      () => read('elements').elements.some((element) => element.text === 'Remove tag #a'),
      'the chip for #a',
    );
    act('do', 'RemoveTag', { name: 'a' });
    assert.equal(await saved(noteId), '#b\n\nsome body');
    act('do', 'RemoveTag', { name: 'b' });
    assert.equal(await saved(noteId), 'some body');
  }),
);

await story('a tag in the text stays text: typing inside one edits it', () =>
  inScratchNote(async (noteId) => {
    pasted('see #tag here');
    act('do', 'PlaceCaret', { at: 8 });
    act('type', { text: 's' });
    assert.equal(await saved(noteId), 'see #tags here');
  }),
);

await story(
  'front matter shows its lines, not its fences, and a click there lands in the body',
  () =>
    inScratchNote(async (noteId) => {
      pasted('---\ntitle: x\n---\nbody');
      assert.deepEqual(shownLines(), ['title: x', 'body']);
      const rect = read('show', { text: 'title: x' }).rect;
      act('click', { x: rect.x + 3, y: rect.y + rect.h / 2 });
      assert.deepEqual(selection(), [9, 9]);
      act('type', { text: 'A' });
      assert.equal(await saved(noteId), '---\ntitle: x\n---\nAbody');
    }),
);

await story(
  '8px of page stand under the front matter panel, and a click there lands on a line',
  () =>
    inScratchNote(async () => {
      pasted('---\ntitle: x\ntags: y\n---\nbody');
      // The line element under a point right of a line's text (the editor's own `at` stack).
      const lineAt = (text) => {
        const shown = read('show', { text }).rect;
        return read('at', { x: shown.x + shown.w + 40, y: shown.y + shown.h / 2 }).stack[0].rect;
      };
      const first = lineAt('title: x');
      const last = lineAt('tags: y');
      const body = lineAt('body');
      // The panel's last line carries the gap as its padding: 8px taller than the one above it,
      // and the body line starts where it ends.
      assert.equal(Math.round(last.h - first.h), 8, `panel lines ${first.h}px and ${last.h}px`);
      assert.ok(
        Math.abs(body.y - (last.y + last.h)) < 1,
        `body at ${body.y}, panel ends ${last.y + last.h}`,
      );
      // A click in the gap is on the panel's last line, so it lands in the body (the caret never
      // rests in front matter), not nowhere.
      act('click', { x: body.x + 20, y: body.y - 4 });
      const bodyStart = read('doc').lines[2].at;
      assert.deepEqual(selection(), [bodyStart, bodyStart]);
    }),
);

finish('tag stories');

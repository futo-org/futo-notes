// Pasting and dropping in the desktop editor (docs/spec/editor/desktop/paste.md): a pasted
// picture, with text beside it or none, is saved into the vault and its reference written at the
// caret, one Undo step; a text paste stays a text paste, its HTML unread; picture files dropped
// from the OS land at the drop point, in order, and other files are ignored. The pictures go in
// through Puppet's `clipboard {"image"}` and `DropFiles`, which dispatch the page's paste and
// drop events; `DropFiles` sends no real OS drag, so it cannot show the drop reaching the note past
// the window's drop guard (externalFileDropGuard.ts). The files land in the running dev app's
// vault (`devVault`), and each story deletes the ones it made.
// `node tests/desktop-editor-paste-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PNG,
  referencesIn,
  untilPictures,
  VAULT,
  withPictures,
} from './lib/desktop-editor-pictures.mjs';
import {
  act,
  finish,
  inScratchNote,
  pasted,
  read,
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

await story('pastes a picture at the caret as a vault file and its reference, one Undo step', () =>
  withPictures(async (noteId, keep) => {
    pasted('before after');
    act('do', 'PlaceCaret', { at: 'before '.length });
    act('clipboard', { image: PNG });
    act('do', 'Paste');
    const text = await untilPictures(noteId, 1, keep);
    const [reference] = referencesIn(text);
    // On a line with text the engine gives the picture a line of its own.
    assert.equal(text, `before \n![](${reference})\nafter`);
    assert.ok(existsSync(join(VAULT, reference)), 'the file is in the vault');
    await until(() => read('doc').lines[1].pictures?.[0]?.shows === 'loaded', 'the picture loaded');
    act('do', 'Undo');
    assert.equal(await saved(noteId), 'before after');
  }),
);

await story('a picture with text beside it on the clipboard pastes the picture', () =>
  withPictures(async (noteId, keep) => {
    act('clipboard', { text: 'photo.png', image: PNG });
    act('do', 'Paste');
    const text = await untilPictures(noteId, 1, keep);
    assert.match(text, /^!\[\]\(image-[^)]+\)$/);
  }),
);

await story('a text paste stays text: its HTML is not read and no file is made', () =>
  inScratchNote(async (noteId) => {
    act('clipboard', { text: 'plain **bold**', html: '<p>plain <b>bold</b></p>' });
    act('do', 'Paste');
    assert.equal(await saved(noteId), 'plain **bold**');
  }),
);

await story('dropped pictures land at the drop point, in order, each its own Undo step', () =>
  withPictures(async (noteId, keep) => {
    pasted('first second');
    const word = read('show', { text: 'second' }).rect;
    act('do', 'DropFiles', {
      x: word.x + 1,
      y: word.y + Math.round(word.h / 2),
      names: 'one.png,two.png',
      base64: PNG,
    });
    const text = await untilPictures(noteId, 2, keep);
    const [one, two] = referencesIn(text);
    assert.equal(text, `first \n![](${one})\n![](${two})\nsecond`);
    act('do', 'Undo');
    assert.equal(await saved(noteId), `first \n![](${one})\nsecond`);
  }),
);

await story('a dropped file that is not a picture is ignored', () =>
  inScratchNote(async (noteId) => {
    pasted('kept as it is');
    const words = read('show', { text: 'kept' }).rect;
    act('do', 'DropFiles', {
      x: words.x + 1,
      y: words.y + Math.round(words.h / 2),
      names: 'notes.md',
      base64: PNG,
    });
    assert.equal(await saved(noteId), 'kept as it is');
    assert.equal(read('state').note.id, noteId, 'the app still shows the note');
  }),
);

finish('desktop editor paste stories');

// The `/` menu in the desktop editor (docs/spec/editor/desktop/slash-menu.md): real typing,
// keys and clicks through `just puppet`, the menu read from its `PickSlashItem` verb (offered
// while the menu is up, its `item` naming the rows) and each pick checked in the saved file.
// The menu is read on the caret's frame, which a background window can hold back: a story waits
// for it before acting on it.
// `node tests/desktop-editor-slash-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PNG, referencesIn, untilPictures, withPictures } from './lib/desktop-editor-pictures.mjs';
import {
  act,
  finish,
  inScratchNote,
  pasted,
  puppet,
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

/** The ids of the rows the menu shows, in order; none while it is closed. A menu of one row
 *  reads as `['string']`: its verb then takes any id. */
function offered() {
  const verb = puppet('actions')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('PickSlashItem'));
  if (!verb) return [];
  return /item: ([^,}\s]+)/.exec(verb)[1].split('|');
}

/** The rows, once the menu shows. */
const shows = () => until(() => offered().length > 0 && offered(), 'the / menu shows');

/** No menu once the typed text is in and its frame drawn: an absence has no event to wait
 *  for, so it gives the frame a moment. */
async function closed() {
  await untilIdle();
  await sleep(150);
  assert.deepEqual(offered(), []);
}

const EVERY_ITEM = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'bullet-list',
  'ordered-list',
  'task-list',
  'quote',
  'code-block',
  'divider',
  'table',
  'link',
  'image',
];

await story('opens on / at a line start and after its indent, with every item', () =>
  inScratchNote(async () => {
    act('type', { text: '/' });
    assert.deepEqual(await shows(), EVERY_ITEM);
    act('press', { key: 'Backspace' });
    act('type', { text: 'first\n  /' });
    assert.deepEqual(await shows(), EVERY_ITEM);
  }),
);

await story('opens after a space mid-line, not in a word or in a web address', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: 'word /' });
    await shows();
    // Escape closes it and the typed text stays.
    act('press', { key: 'Escape' });
    await closed();
    assert.equal(await saved(noteId), 'word /');
    act('type', { text: '\nand/or' });
    await closed();
    act('type', { text: '\nhttp://' });
    await closed();
  }),
);

await story('does not open in a code block', () =>
  inScratchNote(async (noteId) => {
    // Text after the block, so the paste opens no empty line under it.
    pasted('```\nx\n```\nafter');
    const code = read('doc').lines.find((line) => line.text === 'x');
    act('do', 'PlaceCaret', { at: code.end - code.text.length });
    act('type', { text: '/' });
    await closed();
    assert.equal(await saved(noteId), '```\n/x\n```\nafter');
  }),
);

await story('does not open in inline code', () =>
  inScratchNote(async () => {
    // Display "/x", all code: the caret at 1 is strictly inside it, after the `/`.
    pasted('`/x`');
    act('do', 'PlaceCaret', { at: 1 });
    act('type', { text: 'h' });
    await closed();
  }),
);

await story('filters as the query is typed and hides when nothing matches', () =>
  inScratchNote(async () => {
    act('type', { text: '/head' });
    assert.deepEqual(await shows(), ['heading-1', 'heading-2', 'heading-3']);
    act('type', { text: 'zzz' });
    await closed();
    act('press', { key: 'Backspace', count: 3 });
    assert.deepEqual(await shows(), ['heading-1', 'heading-2', 'heading-3']);
    act('type', { text: ' ' });
    await closed();
  }),
);

await story('the arrows move the highlight and Enter picks it', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '/head' });
    await shows();
    act('press', { key: 'ArrowDown' });
    act('press', { key: 'Enter' });
    act('type', { text: 'Title' });
    assert.equal(await saved(noteId), '## Title');
    act('press', { key: 'Enter' });
    act('type', { text: '/head' });
    await shows();
    // Up from the first row wraps to the last.
    act('press', { key: 'ArrowUp' });
    act('press', { key: 'Enter' });
    act('type', { text: 'Small' });
    assert.equal(await saved(noteId), '## Title\n### Small');
  }),
);

await story('Tab picks the highlighted item', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '/quo' });
    await shows();
    act('press', { key: 'Tab' });
    act('type', { text: 'said' });
    assert.equal(await saved(noteId), '> said');
  }),
);

await story('a click on a row picks it', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '/' });
    await shows();
    const row = read('elements').elements.find(
      (element) => element.role === 'option' && element.text.startsWith('Heading 2'),
    ).rect;
    act('click', { x: row.x + row.w / 2, y: row.y + row.h / 2 });
    act('type', { text: 'Clicked' });
    assert.equal(await saved(noteId), '## Clicked');
  }),
);

await story('Escape closes it and keeps the typed text while that / is typed on', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '/hea' });
    await shows();
    act('press', { key: 'Escape' });
    await closed();
    act('type', { text: 'd' });
    await closed();
    assert.equal(await saved(noteId), '/head');
    act('type', { text: '\n/' });
    assert.deepEqual(await shows(), EVERY_ITEM);
  }),
);

const WRITTEN = {
  paragraph: '',
  'heading-1': '# ',
  'heading-2': '## ',
  'heading-3': '### ',
  'bullet-list': '- ',
  'ordered-list': '1. ',
  'task-list': '- [ ] ',
  quote: '> ',
  'code-block': '```\n\n```',
  // The empty line the engine opens under the divider ends the file: `file` reads it as no line.
  divider: '---',
  table: '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |',
};

for (const [item, written] of Object.entries(WRITTEN)) {
  await story(`${item} writes its block in place of the typed /`, () =>
    inScratchNote(async (noteId) => {
      act('type', { text: '/' });
      await shows();
      act('do', 'PickSlashItem', { item });
      assert.equal(await saved(noteId), written);
    }),
  );
}

await story('Link removes the typed /link and opens the Link prompt at the caret', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '/link' });
    await shows();
    act('press', { key: 'Enter' });
    // The prompt's field has focus as it opens: the address is typed, not set.
    act('type', { text: 'https://z.test' });
    act('press', { key: 'Enter' });
    assert.equal(await saved(noteId), 'https://z.test');
    act('type', { text: '\n/link' });
    await shows();
    act('press', { key: 'Enter' });
    act('do', 'CancelLink');
    // The typed /link is gone and its empty line stays, which `file` reads as no line.
    assert.equal(await saved(noteId), 'https://z.test');
    assert.equal(read('doc').lines.length, 2);
  }),
);

await story('one Undo takes the item back and brings the typed query back', () =>
  inScratchNote(async (noteId) => {
    act('type', { text: '/h2' });
    await shows();
    act('press', { key: 'Enter' });
    assert.equal(await saved(noteId), '## ');
    // The pick is one engine command, so one Undo undoes it: the query is back, the menu with it.
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), '/h2');
    assert.deepEqual(await shows(), ['string']);
  }),
);

// The OS picker cannot be pressed: `PickSlashItem`'s `path` is the file it would return. The
// file sits under the home folder, inside the app's file scope (capabilities/default.json),
// which the dialog would otherwise grant.
await story('Image writes the picked file in place of the typed /image, its own Undo step', () =>
  withPictures(async (noteId, keep) => {
    const folder = mkdtempSync(join(homedir(), '.futo-slash-image-story-'));
    try {
      const picked = join(folder, 'photo.png');
      writeFileSync(picked, Buffer.from(PNG, 'base64'));
      act('type', { text: 'before\n/ima' });
      await shows();
      // Without a path the verb is refused and the menu stays up.
      assert.throws(() => act('do', 'PickSlashItem', { item: 'image' }));
      assert.deepEqual(await shows(), ['string']);
      act('do', 'PickSlashItem', { item: 'image', path: picked });
      const text = await untilPictures(noteId, 1, keep);
      const [reference] = referencesIn(text);
      assert.equal(text, `before\n![](${reference})`);
      act('press', { key: 'Mod-z' });
      assert.equal(await saved(noteId), 'before');
      act('press', { key: 'Mod-z' });
      assert.equal(await saved(noteId), 'before\n/ima');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }),
);

finish('slash menu stories');

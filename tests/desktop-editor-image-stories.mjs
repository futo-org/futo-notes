// Images in the desktop editor (docs/spec/editor/desktop/images.md): a picture drawn for each
// image atom, loaded from the vault or its own address, its label when its file is missing; the
// caret only before and after it, a click and Shift+Arrow taking it whole, Backspace selecting it
// before deleting it, Enter leaving a last image, and copy carrying its spelling. Pictures are
// read through `doc`'s `pictures` (puppetPictures.ts). The vault image is a file the story writes
// into the running dev app's vault (the folder `scripts/tauri-dev.mjs` names in this checkout's
// `.tauri-data/notes-dir-override.json`) and deletes afterwards.
// `node tests/desktop-editor-image-stories.mjs [filter]` runs the stories whose name holds it.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  act,
  devVault,
  finish,
  inScratchNote,
  pasted,
  read,
  selection,
  story,
  until,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

/** A 40×30 orange PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAKUlEQVR42u3NMQ0AAAgDsPkPnpkMOJr0b3Zy' +
    'ImKxWCwWi8VisVgs/hsXBQ87+lkXKkEAAAAASUVORK5CYII=',
  'base64',
);
// Percent-encoded, not base64: a ';' in `puppet clipboard` text makes the desktop bridge answer
// nothing.
const dataImage = (png, alt) =>
  `![${alt}](data:image/png,${[...png].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')})`;
const DATA_IMAGE = dataImage(PNG, 'dot');

/** A `width`×`height` PNG of one grey. */
function solidPng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  // Each row: filter byte 0, then one grey byte a pixel.
  const rows = Buffer.alloc((width + 1) * height, 0x88);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A picture five rows tall: text beside it shows which of its rows it stands on. */
const TALL_IMAGE = dataImage(solidPng(40, 120), 'tall');

const VAULT = devVault();
const VAULT_IMAGE = 'desktop-editor-image-story.png';

const pictures = () => read('doc').lines.flatMap((line) => line.pictures ?? []);
const loaded = (index = 0) =>
  until(() => pictures()[index]?.shows === 'loaded' && pictures()[index], 'the picture loaded');

async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

await story('draws a vault image and a data image as pictures, their spelling kept', () =>
  inScratchNote(async (noteId) => {
    writeFileSync(join(VAULT, VAULT_IMAGE), PNG);
    try {
      pasted(`![](${VAULT_IMAGE}) and ${DATA_IMAGE}`);
      const vault = await loaded(0);
      const data = await loaded(1);
      assert.equal(vault.source, VAULT_IMAGE);
      // 40×30 drawn at its own size, no wider than the column and no taller than 300px.
      assert.equal(Math.round(vault.box.width), 40);
      assert.equal(Math.round(data.box.height), 30);
      assert.equal(await saved(noteId), `![](${VAULT_IMAGE}) and ${DATA_IMAGE}`);
    } finally {
      rmSync(join(VAULT, VAULT_IMAGE), { force: true });
    }
  }),
);

await story('shows a missing image as its label and leaves the note as it was', () =>
  inScratchNote(async (noteId) => {
    pasted('before ![a lost photo](no-such-image-for-stories.png) after');
    const [picture] = await until(
      () => pictures()[0]?.shows === 'missing' && pictures(),
      'the missing picture marked',
    );
    assert.ok(picture.box.width > 0, 'the label takes room');
    assert.equal(
      await saved(noteId),
      'before ![a lost photo](no-such-image-for-stories.png) after',
    );
  }),
);

await story('a click on a picture selects it whole; Shift+Right takes it whole too', () =>
  inScratchNote(async () => {
    pasted(`a ${DATA_IMAGE} b`);
    const picture = await loaded();
    act('click', { x: picture.box.left + picture.box.width / 2, y: picture.box.top + 5 });
    assert.deepEqual(selection(), [picture.at, picture.end]);
    act('do', 'PlaceCaret', { at: picture.at });
    act('press', { key: 'ArrowRight' });
    assert.deepEqual(selection(), [picture.end, picture.end]);
    act('press', { key: 'ArrowLeft' });
    assert.deepEqual(selection(), [picture.at, picture.at]);
    act('press', { key: 'Shift-ArrowRight' });
    assert.deepEqual(selection(), [picture.at, picture.end]);
  }),
);

await story('a click on text left of a picture on its row lands in that text', () =>
  inScratchNote(async () => {
    pasted(`words ${DATA_IMAGE}`);
    const picture = await loaded();
    const word = read('show', { text: 'words' }).rect;
    act('click', { x: word.x + 2, y: word.y + word.h / 2 });
    const [from, to] = selection();
    assert.equal(from, to);
    assert.ok(from < picture.at, `the click landed at ${from}, not in "words"`);
  }),
);

await story('the caret beside a picture is as tall as the picture', () =>
  inScratchNote(async () => {
    // The picture is 40 by 30.
    pasted(DATA_IMAGE);
    const picture = await loaded();
    act('do', 'PlaceCaret', { at: picture.end });
    const caret = await until(() => read('state').editor.caret, 'the caret drawn');
    assert.ok(Math.abs(caret.height - 30) < 1, `caret ${caret.height}px tall, the picture 30`);
  }),
);

await story('Backspace after an image selects it, and the next one deletes it', () =>
  inScratchNote(async (noteId) => {
    pasted(`a ${DATA_IMAGE} b`);
    const picture = await loaded();
    act('do', 'PlaceCaret', { at: picture.end });
    act('press', { key: 'Backspace' });
    assert.deepEqual(selection(), [picture.at, picture.end]);
    assert.equal(await saved(noteId), `a ${DATA_IMAGE} b`);
    act('press', { key: 'Backspace' });
    assert.equal(await saved(noteId), 'a  b');
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), `a ${DATA_IMAGE} b`);
  }),
);

await story('Delete before an image selects it, and the next one deletes it', () =>
  inScratchNote(async (noteId) => {
    pasted(`a ${DATA_IMAGE} b`);
    const picture = await loaded();
    act('do', 'PlaceCaret', { at: picture.at });
    act('press', { key: 'Delete' });
    assert.deepEqual(selection(), [picture.at, picture.end]);
    assert.equal(await saved(noteId), `a ${DATA_IMAGE} b`);
    act('press', { key: 'Delete' });
    assert.equal(await saved(noteId), 'a  b');
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), `a ${DATA_IMAGE} b`);
    // A word's Delete selects it first too.
    act('do', 'PlaceCaret', { at: picture.at });
    act('press', { key: process.platform === 'darwin' ? 'Alt-Delete' : 'Ctrl-Delete' });
    assert.deepEqual(selection(), [picture.at, picture.end]);
  }),
);

await story('Enter on a selected last image opens a line after it', () =>
  inScratchNote(async (noteId) => {
    pasted(`text\n${DATA_IMAGE}`);
    const picture = await loaded();
    act('do', 'Select', { from: picture.at, to: picture.end });
    act('press', { key: 'Enter' });
    act('type', { text: 'after' });
    assert.equal(await saved(noteId), `text\n${DATA_IMAGE}\nafter`);
  }),
);

await story('copying a selection holding an image puts its spelling on the clipboard', () =>
  inScratchNote(async () => {
    pasted(`a ![alt](${VAULT_IMAGE} "title") b`);
    act('do', 'Select', { from: 0, to: read('doc').lines[0].end });
    act('do', 'Copy');
    assert.equal(read('clipboard').clipboard.text, `a ![alt](${VAULT_IMAGE} "title") b`);
  }),
);

const caret = () => read('state').editor.caret;
const lineOf = (index) => read('doc').lines[index];
const onLine = (index) => {
  const [from, to] = selection();
  const line = lineOf(index);
  return from === to && from >= line.at && from <= line.end;
};

await story('text beside a picture stands on its row first line, level with the checkbox', () =>
  inScratchNote(async () => {
    pasted(`- [ ] words ${TALL_IMAGE}`);
    const picture = await loaded();
    assert.ok(picture.box.height > 100, `the picture is ${picture.box.height}px tall`);
    const word = read('show', { text: 'words' }).rect;
    const middle = word.y + word.h / 2;
    assert.ok(
      middle > picture.box.top && middle < picture.box.top + 24,
      `"words" at ${middle}, the picture from ${picture.box.top}`,
    );
    const box = read('elements').elements.find((element) => element.role === 'checkbox');
    assert.ok(
      Math.abs(box.rect.y + box.rect.h / 2 - middle) < 4,
      'the checkbox is level with the text',
    );
  }),
);

await story(
  'the caret before and after a tall picture is as tall as it; Up and Down cross it',
  () =>
    inScratchNote(async () => {
      pasted(`above\n${TALL_IMAGE} after\nbelow`);
      const picture = await loaded();
      act('do', 'PlaceCaret', { at: 0 });
      const above = await until(caret, 'the caret drawn');
      act('do', 'PlaceCaret', { at: picture.at });
      const before = caret();
      act('do', 'PlaceCaret', { at: picture.end });
      const after = caret();
      act('do', 'PlaceCaret', { at: lineOf(1).end });
      const text = caret();
      // The picture is 120px tall; text beside it stands on its row's first line.
      for (const [name, stop] of Object.entries({ before, after })) {
        assert.ok(Math.abs(stop.height - 120) < 1, `the caret ${name} is ${stop.height}px tall`);
        assert.ok(Math.abs(stop.top - before.top) < 1, `${name} at ${stop.top}`);
      }
      assert.ok(text.height < 30, `the caret in the text is ${text.height}px tall`);
      assert.ok(
        text.top >= before.top && text.top - before.top < 8,
        `the text's caret at ${text.top}, the picture's top at ${before.top}`,
      );
      const step = before.top - above.top;
      assert.ok(step > 16 && step < 40, `the picture row's caret ${step}px under the line above`);
      act('do', 'PlaceCaret', { at: lineOf(0).end });
      act('press', { key: 'ArrowDown' });
      assert.ok(onLine(1), `Down went to ${selection()}`);
      act('press', { key: 'ArrowDown' });
      assert.ok(onLine(2), `Down went to ${selection()}`);
      act('press', { key: 'ArrowUp' });
      assert.ok(onLine(1), `Up went to ${selection()}`);
      act('press', { key: 'ArrowUp' });
      assert.ok(onLine(0), `Up went to ${selection()}`);
    }),
);

await story('Left and Right onto a picture line from the lines beside it keep the pane', () =>
  inScratchNote(async () => {
    const above = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    pasted(`${above}\n${TALL_IMAGE}\nbelow`);
    const picture = await loaded();
    const steps = [
      { from: picture.at - 1, key: 'ArrowRight', stop: picture.at },
      { from: picture.end + 1, key: 'ArrowLeft', stop: picture.end },
    ];
    for (const { from, key, stop } of steps) {
      act('do', 'PlaceCaret', { at: from });
      const before = (await loaded()).box.top;
      act('press', { key });
      assert.deepEqual(selection(), [stop, stop], key);
      // WebKit's own step scrolled the pane to the note's top, 40 lines up.
      const moved = Math.abs((await loaded()).box.top - before);
      assert.ok(moved < picture.box.height, `${key} scrolled the pane ${moved}px`);
    }
  }),
);

await story('a press beside a picture stops on that side; Up and Down leave a selected one', () =>
  inScratchNote(async () => {
    pasted(`above\n${TALL_IMAGE}\nbelow`);
    const picture = await loaded();
    const middle = picture.box.top + picture.box.height / 2;
    act('click', { x: picture.box.left - 8, y: middle });
    assert.deepEqual(selection(), [picture.at, picture.at], 'a press left of it');
    act('click', { x: picture.box.left + picture.box.width + 8, y: middle });
    assert.deepEqual(selection(), [picture.end, picture.end], 'a press right of it');
    act('do', 'Select', { from: picture.at, to: picture.end });
    act('press', { key: 'ArrowUp' });
    assert.deepEqual(selection(), [lineOf(0).end, lineOf(0).end], 'Up');
    act('do', 'Select', { from: picture.at, to: picture.end });
    act('press', { key: 'ArrowDown' });
    assert.deepEqual(selection(), [lineOf(2).at, lineOf(2).at], 'Down');
  }),
);

await story('a click beside a picture at its bottom lands on its row', () =>
  inScratchNote(async () => {
    pasted(`${TALL_IMAGE} words\nnext`);
    const picture = await loaded();
    const word = read('show', { text: 'words' }).rect;
    act('click', { x: word.x + word.w + 30, y: picture.box.top + picture.box.height - 3 });
    assert.deepEqual(selection(), [lineOf(0).end, lineOf(0).end]);
  }),
);

await story('two picture lines stand 4px apart, and a click in the gap selects the lower one', () =>
  inScratchNote(async () => {
    pasted(`${TALL_IMAGE}\n${TALL_IMAGE}`);
    const upper = await loaded(0);
    const lower = await loaded(1);
    const gap = lower.box.top - (upper.box.top + upper.box.height);
    assert.equal(Math.round(gap), 4, `the pictures are ${gap}px apart`);
    // In the gap's upper half: the gap is the lower line's padding, so still the lower picture.
    act('click', { x: lower.box.left + lower.box.width / 2, y: lower.box.top - 3 });
    assert.deepEqual(selection(), [lower.at, lower.end]);
  }),
);

await story('a picture under a code block stands 4px from its card, the gap its own line', () =>
  inScratchNote(async () => {
    pasted(`\`\`\`\ncode\n\`\`\`\n${TALL_IMAGE}`);
    const picture = await loaded();
    const x = picture.box.left + picture.box.width + 40;
    // The front element at a point in the gap is the picture's line; just above it, the code
    // line, whose box ends at the card's bottom (its skirt is its padding).
    const pictureLine = read('at', { x, y: picture.box.top - 2 }).stack[0].rect;
    assert.ok(
      Math.abs(picture.box.top - pictureLine.y - 4) < 1,
      `gap ${picture.box.top - pictureLine.y}px`,
    );
    const codeLine = read('at', { x, y: pictureLine.y - 2 }).stack[0].rect;
    assert.ok(
      Math.abs(codeLine.y + codeLine.h - pictureLine.y) < 1,
      'the card ends where the gap starts',
    );
  }),
);

/** The selection's bands at `point`: what a press passes through there, but the layers as large
 *  as the editor (the highlight's own, the caret's). */
const bandsUnder = (point) => {
  const passing = read('at', point).stack.filter((entry) => entry.flags.includes('passes'));
  const layer = Math.max(...passing.map((entry) => entry.rect.h));
  return passing.filter((entry) => entry.rect.h < layer);
};
/** Whether a band at `point` is the fill of a 4px gap over `picture`'s width. */
const gapFilledAt = (point, picture) =>
  bandsUnder(point).some(
    (entry) => Math.abs(entry.rect.h - 4) <= 1.5 && Math.abs(entry.rect.w - picture.box.width) <= 2,
  );
const centreOf = (picture) => ({
  x: picture.box.left + picture.box.width / 2,
  y: picture.box.top + picture.box.height / 2,
});

await story('a selected picture is highlighted over its own box, not the rest of its row', () =>
  inScratchNote(async () => {
    pasted(`${DATA_IMAGE} ${TALL_IMAGE}\nnext`);
    const short = await loaded(0);
    const tall = await loaded(1);
    // The short picture, then its line with its break: under the short one and right of the
    // tall one, the row is not highlighted.
    act('do', 'Select', { from: short.at, to: short.end });
    await until(() => bandsUnder(centreOf(short)).length > 0, 'the highlight');
    const underShort = { x: centreOf(short).x, y: short.box.top + short.box.height + 10 };
    assert.ok(underShort.y < tall.box.top + tall.box.height, 'the tall picture is taller');
    assert.equal(bandsUnder(underShort).length, 0, 'a band under the short picture');
    act('do', 'Select', { from: lineOf(0).at, to: lineOf(1).at });
    await until(() => bandsUnder(centreOf(tall)).length > 0, 'the highlight');
    const beside = { x: tall.box.left + tall.box.width + 30, y: centreOf(tall).y + 20 };
    assert.equal(bandsUnder(beside).length, 0, 'a band beside the tall picture');
    assert.equal(bandsUnder(underShort).length, 0, 'a band under the short picture');
  }),
);

await story('a highlighted card over a selected picture fills the gap over its width', () =>
  inScratchNote(async () => {
    pasted(`above\n\`\`\`\ncode\n\`\`\`\n${TALL_IMAGE}`);
    const picture = await loaded();
    act('do', 'Select', { from: 0, to: lineOf(read('doc').lines.length - 1).end });
    await until(() => bandsUnder(centreOf(picture)).length > 0, 'the highlight');
    const gap = picture.box.top - 2;
    assert.ok(gapFilledAt({ x: centreOf(picture).x, y: gap }, picture), 'the gap is page');
    const beside = { x: picture.box.left + picture.box.width + 30, y: gap };
    assert.equal(bandsUnder(beside).length, 0, 'the gap is filled beyond the picture');
  }),
);

await story('two selected pictures on consecutive lines have the gap between them filled', () =>
  inScratchNote(async () => {
    pasted(`${TALL_IMAGE}\n${TALL_IMAGE}`);
    const upper = await loaded(0);
    const lower = await loaded(1);
    act('do', 'Select', { from: upper.at, to: lower.end });
    await until(() => bandsUnder(centreOf(lower)).length > 0, 'the highlight');
    const gap = { x: centreOf(lower).x, y: (upper.box.top + upper.box.height + lower.box.top) / 2 };
    assert.ok(gapFilledAt(gap, lower), 'the gap between the pictures is page');
  }),
);

finish('image stories');

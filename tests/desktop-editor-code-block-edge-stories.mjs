// The desktop editor's "add a line above" and "add a line below" labels at a code block's edges
// (codeBlockEdges.ts, codeBlockPress.ts): where they are drawn, real clicks on them, on the skirt
// beside "below", in the gap between two touching blocks and on the header around "above", the
// file on disk after each, Undo, and the header's fields still taking their clicks. A label is
// shown by the pointer, which Puppet cannot move without pressing: codeBlockEdgeReveal.test.ts
// covers the reveal.
// `node tests/desktop-editor-code-block-edge-stories.mjs [filter]` runs the stories whose name
// holds it.
import assert from 'node:assert/strict';
import {
  act,
  finish,
  inScratchNote,
  pasted,
  pastedEndingWithBlock,
  read,
  story,
  untilIdle,
} from './lib/desktop-editor-story.mjs';

/** A block opening the note right over another, a paragraph, and a block ending the note. */
const NOTE = '```js\nlet alpha = 1\n```\n```py\nbeta = 2\n```\nmiddle\n```rust\nfn main() {}\n```';

async function saved(noteId) {
  await untilIdle();
  return read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');
}

function editor() {
  const state = read('state').editor;
  assert.equal(state.error, undefined);
  return state;
}

/** The labels drawn, top to bottom, each with the code line its block's edge is nearest. */
function labels() {
  const drawn = read('elements').elements.filter(
    (element) =>
      element.component === 'DesktopEditor.svelte' && element.text.startsWith('add a line'),
  );
  return drawn.sort((upper, lower) => upper.rect.y - lower.rect.y);
}

function describeLabels() {
  const rows = read('doc').lines.map((line) => ({
    text: line.text,
    y: read('show', { text: line.text }).rect.y,
  }));
  return labels().map((label) => {
    const distance = (row) => Math.abs(row.y - label.rect.y);
    const near = rows.reduce((best, row) => (distance(row) < distance(best) ? row : best));
    return `${label.text}: ${near.text}`;
  });
}

const clickAt = (x, y) => act('click', { x, y });
const centre = (element) => [
  element.rect.x + element.rect.w / 2,
  element.rect.y + element.rect.h / 2,
];

await story('a label is drawn only where no ordinary line reaches the edge, never as text', () =>
  inScratchNote(async () => {
    pastedEndingWithBlock(NOTE);
    assert.deepEqual(describeLabels(), [
      'add a line above: let alpha = 1',
      'add a line below: let alpha = 1',
      'add a line above: beta = 2',
      'add a line below: fn main() {}',
    ]);
    act('do', 'Select', { from: 0, to: read('doc').lines.at(-1).end });
    act('do', 'Copy');
    assert.equal(read('clipboard').clipboard.text, NOTE);
    assert.equal(
      read('doc').lines.some((line) => line.text.includes('add a line')),
      false,
    );
  }),
);

await story('a click on a label opens a line at that edge, the caret on it, one Undo step', () =>
  inScratchNote(async (noteId) => {
    pastedEndingWithBlock(NOTE);
    const [above] = labels();
    clickAt(...centre(above));
    assert.equal(await saved(noteId), `\n${NOTE}`);
    assert.deepEqual([editor().selection.from, editor().selection.to], [0, 0]);
    // The note's first line is a paragraph now: "above" is gone from the first block.
    assert.equal(labels()[0].text, 'add a line below');
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), NOTE);
    clickAt(...centre(labels().at(-1)));
    // A line the file cannot show until it holds text: the caret on an empty last line.
    const last = read('doc').lines.at(-1);
    assert.deepEqual([last.kind, last.text], ['gap', '']);
    assert.deepEqual([editor().selection.from, editor().selection.to], [last.at, last.at]);
    act('type', { text: 'after' });
    assert.equal(await saved(noteId), `${NOTE}\nafter`);
  }),
);

await story('the skirt beside "below" is the last code line; the gap under it opens a line', () =>
  inScratchNote(async (noteId) => {
    pastedEndingWithBlock(NOTE);
    const below = labels()[1];
    const code = read('show', { text: 'let alpha = 1' }).rect;
    // Above the label, the last code row's foot is that row's. The label takes presses from a
    // little above the box Puppet reports for it, so the click keeps well clear of it.
    clickAt(below.rect.x + below.rect.w / 2, below.rect.y - 6);
    assert.deepEqual([editor().selection.from, editor().selection.to], [13, 13]);
    // The skirt's band beside the label, at two columns: the last code line at each.
    const skirt = below.rect.y + 7;
    clickAt(code.x + 12, skirt);
    const near = editor().selection.from;
    // Right of the label, past the text's end: in a narrow pane the label's box reaches over
    // the text's last letters.
    clickAt(below.rect.x + below.rect.w + 20, skirt);
    const far = editor().selection.from;
    assert.ok(near > 0 && near < far, `the skirt answered ${near} then ${far}`);
    assert.equal(far, 'let alpha = 1'.length);
    assert.equal(await saved(noteId), NOTE);
    // The gap under the label, between the two blocks: a line opens between them.
    clickAt(code.x + 12, below.rect.y + below.rect.h + 5);
    assert.equal(await saved(noteId), NOTE.replace('```\n```py', '```\n\n```py'));
    const between = 'let alpha = 1\n'.length;
    assert.deepEqual([editor().selection.from, editor().selection.to], [between, between]);
    // The blocks no longer touch: neither seam label is drawn, until Undo makes it a seam again.
    const texts = () => labels().map((label) => label.text);
    assert.deepEqual(texts(), ['add a line above', 'add a line below']);
    act('press', { key: 'Mod-z' });
    assert.equal(await saved(noteId), NOTE);
    assert.equal(texts().length, 4);
  }),
);

await story('around "above" the header row still selects the block; its fields take clicks', () =>
  inScratchNote(async (noteId) => {
    pastedEndingWithBlock(NOTE);
    const above = labels()[2];
    const [x, y] = centre(above);
    clickAt(x - above.rect.w, y);
    assert.equal(editor().selection.block, true);
    assert.equal(await saved(noteId), NOTE);
    const fields = read('elements').elements.filter(
      (element) =>
        element.component === 'DesktopEditor.svelte' &&
        element.role === 'text' &&
        Math.abs(element.rect.y + element.rect.h / 2 - y) < 6,
    );
    fields.sort((left, right) => left.rect.x - right.rect.x);
    clickAt(...centre(fields[0]));
    assert.deepEqual(editor().headerField, { field: 'name', value: '' });
    clickAt(...centre(fields[1]));
    assert.deepEqual(editor().headerField, { field: 'language', value: 'py' });
    act('press', { key: 'Escape' });
    assert.equal(await saved(noteId), NOTE);
  }),
);

await story(
  'a block pasted over itself ends its selection, and pasted again is a second block',
  () =>
    inScratchNote(async (noteId) => {
      pasted('above\n```js\nlet alpha = 1\n```\nbelow');
      const below = () => read('doc').lines.find((line) => line.text === 'below').at;
      const selected = () => {
        const { selection } = editor();
        return [selection.from, selection.to, !!selection.block];
      };
      act('do', 'PlaceCaret', { at: below() });
      act('press', { key: 'Backspace' });
      assert.equal(selected()[2], true, 'Backspace under the block selects it');
      act('do', 'Copy');
      act('do', 'Paste');
      assert.deepEqual(selected(), [below(), below(), false], 'the caret under the pasted block');
      assert.equal(await saved(noteId), 'above\n```js\nlet alpha = 1\n```\nbelow');
      act('do', 'Paste');
      assert.equal(
        await saved(noteId),
        'above\n```js\nlet alpha = 1\n```\n```js\nlet alpha = 1\n```\nbelow',
      );
    }),
);

await story('a block pasted on the line above another block opens a line between them', () =>
  inScratchNote(async (noteId) => {
    pasted('top\n\n```py\nbeta = 2\n```\nend');
    act('do', 'PlaceCaret', { at: 4 });
    pasted('```js\nlet alpha = 1\n```');
    act('type', { text: 'x' });
    assert.equal(
      await saved(noteId),
      'top\n```js\nlet alpha = 1\n```\nx\n```py\nbeta = 2\n```\nend',
    );
  }),
);

finish('code block edge stories');

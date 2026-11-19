// The desktop editor's syntax colours in fenced code blocks (codeColours.ts): each token drawn
// as a span classed `tok-*`, read back through `show {"text"}`'s `formats`; `state`'s
// `editor.colouring` while colours are still to come (a grammar loading, a block read again
// after an edit). Content comes in through Paste, its text free of `;` (Puppet's clipboard drops
// text holding one).
// `node tests/desktop-editor-code-colour-stories.mjs [filter]` runs the stories whose name holds it.
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

const formatsOf = (text) => read('show', { text }).formats;
const coloured = () => until(() => !read('state').editor.colouring, 'the code coloured');
const startOf = (text) => read('doc').lines.find((line) => line.text.includes(text)).at;

await story('a block is coloured by its language, its text and lines as they were', () =>
  inScratchNote(async () => {
    pasted('above\n```js\nconst greeting = "hi" // say it\n```\nbelow');
    await coloured();
    assert.deepEqual(formatsOf('const'), ['tok-keyword']);
    assert.deepEqual(formatsOf('"hi"'), ['tok-string']);
    assert.deepEqual(formatsOf('// say it'), ['tok-comment']);
    assert.deepEqual(formatsOf('above'), ['plain']);
    assert.equal(read('state').editor.error, undefined);
    assert.deepEqual(
      read('doc').lines.map((line) => line.kind),
      ['paragraph', 'code js', 'paragraph'],
    );
  }),
);

await story('a language is found by name or alias in any case; any other stays plain', () =>
  inScratchNote(async () => {
    pasted(
      '```PY\nreturn_value = 1\n```\n~~~Rust\nfn main() {}\n~~~\n```cobol\nMOVE A TO B\n```\nend',
    );
    await coloured();
    assert.deepEqual(formatsOf('1'), ['tok-number']);
    assert.deepEqual(formatsOf('fn'), ['tok-keyword']);
    assert.deepEqual(formatsOf('MOVE A TO B'), ['plain']);
    // An uncoloured block is code all the same: it takes typing and saves it.
    act('do', 'PlaceCaret', { at: startOf('MOVE') + 4 });
    act('type', { text: 'X' });
    await untilIdle();
    assert.ok(read('doc').lines.some((line) => line.text === 'MOVEX A TO B'));
  }),
);

await story('a letter typed in a string is string-coloured at once and after', () =>
  inScratchNote(async () => {
    pasted('```js\nlet name = "ab"\n```\nend');
    await coloured();
    act('do', 'PlaceCaret', { at: startOf('let') + 13 });
    act('type', { text: 'Z' });
    assert.deepEqual(formatsOf('"aZb"'), ['tok-string']);
    await coloured();
    assert.deepEqual(formatsOf('"aZb"'), ['tok-string']);
    assert.equal(read('state').editor.error, undefined);
  }),
);

await story('an opened comment colours the lines below it, and Undo takes it back', () =>
  inScratchNote(async () => {
    pasted('```js\nlet first\nlet second\nlet third\n```\nend');
    await coloured();
    act('do', 'PlaceCaret', { at: startOf('first') });
    act('type', { text: '/*' });
    await coloured();
    assert.deepEqual(formatsOf('let third'), ['tok-comment']);
    act('do', 'Undo');
    await coloured();
    assert.deepEqual(formatsOf('let'), ['tok-keyword']);
  }),
);

await story('colours arriving keep the selection, its direction included', () =>
  inScratchNote(async () => {
    pasted('```py\ndef double(value):\n    return value * 2\n```\nend');
    const from = startOf('return') + 4;
    act('do', 'Select', { from: from + 6, to: from });
    await coloured();
    assert.deepEqual(selection(), [from, from + 6]);
    // Still backward: Shift+Right moves its focus, at its start.
    act('press', { key: 'Shift-ArrowRight' });
    assert.deepEqual(selection(), [from + 1, from + 6]);
    act('press', { key: 'Shift-ArrowLeft' });
    act('type', { text: 'x' });
    assert.ok(read('doc').lines.some((line) => line.text === '    x value * 2'));
  }),
);

await story('typing in a 2,000-line block stays within the typing budget', () =>
  inScratchNote(async () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `const value${index} = "${index}"`);
    pasted(`\`\`\`js\n${lines.join('\n')}\n\`\`\`\nend`);
    await coloured();
    act('do', 'PlaceCaret', { at: startOf('value1000 ') + 6 });
    act('type', { text: 'abcdefghijklmnopqrstuvwxyz'.repeat(4) });
    const typing = read('state').editor.typing;
    assert.ok(typing.median < 1, `median ${typing.median} ms`);
    assert.ok(typing.p99 < 2, `p99 ${typing.p99} ms`);
    await coloured();
    assert.deepEqual(formatsOf(`"1000"`), ['tok-string']);
  }),
);

finish('desktop editor code colour stories');

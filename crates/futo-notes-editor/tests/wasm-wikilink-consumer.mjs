// Wikilink roles and note-id delivery through compiled WASM, mid-composition.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

const source = '[[Roadmap]] ab cd `[[Roadmap]]`';
const session = new WasmSession(1n, source, 0n, 0n);
// The code span's backticks are hidden from display.
const roles = () => JSON.parse(session.project(0n, 0, source.length - 2)).wikilinks;
assert.deepEqual(roles(), [
  { range: { start: 0, end: 11 }, target: 'Roadmap', label: 'Roadmap', note_id: null },
]);
session.compose_utf16(
  0n,
  14,
  14,
  Array.from('か', (c) => c.charCodeAt(0)),
);
const change = JSON.parse(session.update_note_ids(JSON.stringify(['Projects/Roadmap'])));
assert.equal(change.revision, 0);
assert.deepEqual(
  change.projections.map((slice) => slice.wikilinks),
  [
    [
      {
        range: { start: 0, end: 11 },
        target: 'Roadmap',
        label: 'Roadmap',
        note_id: 'Projects/Roadmap',
      },
    ],
  ],
);
assert.equal(JSON.parse(session.composition()).text, 'か');
assert.equal(session.draft_text(), source);
session.free();
console.log('Compiled WASM wikilinks: roles and mid-composition note-id delivery passed.');

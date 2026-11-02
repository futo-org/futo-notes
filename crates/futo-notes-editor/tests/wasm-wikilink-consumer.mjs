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

// Completion: request, stale claim, accept; a pending change keeps requests out.
const page = new WasmSession(2n, 'see [[Ro', 0n, 0n);
page.update_note_ids(JSON.stringify(['Projects/Roadmap', 'Other/Notes']));
page.select_with_affinity(0n, 8, 8, '"Forward"');
const found = JSON.parse(page.wikilink_completion(0n));
assert.deepEqual(found.range, { start: 4, end: 8 });
assert.equal(found.query, 'Ro');
assert.deepEqual(found.candidates, [
  { note_id: 'Projects/Roadmap', label: 'Roadmap', detail: 'Projects/Roadmap' },
]);
assert.throws(() => page.accept_wikilink_completion(0n, 4, 8, 'R', 'Projects/Roadmap'));
assert.throws(() => page.accept_wikilink_completion(0n, 4, 8, 'Ro', 'Gone/Note'));
const request = JSON.parse(page.accept_wikilink_completion(0n, 4, 8, 'Ro', 'Projects/Roadmap'));
// The record is the minimal source diff: `[[` is kept, `Ro` becomes the id.
assert.equal(request.operation.Append.inserted, 'Projects/Roadmap]]');
assert.throws(() => page.wikilink_completion(1n));
page.free();
console.log('Compiled WASM wikilinks: roles, note-id delivery and completion passed.');

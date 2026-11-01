// Table cells, structural commands and keys through compiled WASM.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

const session = new WasmSession(1n, '| a | b |\n| --- | --- |\n| c | d |\n', 0n, 0n);
let revision = 0n;
// Acknowledge as the host would; the staged edit becomes the accepted revision.
const accept = (request) => {
  const { sequence } = JSON.parse(request);
  revision += 1n;
  session.acknowledge(
    JSON.stringify({
      token: 1,
      sequence,
      accepted: Number(revision),
      durable: 0,
      paused: false,
      error: null,
    }),
  );
};
const cell = (row, column) =>
  JSON.parse(session.inspect_table(revision, 0, 0)).rows[row][column].content;

assert.equal(session.inspect_table(revision, 0, 0).startsWith('{'), true);
const { start, end } = cell(0, 0);
accept(session.paste_markdown(revision, start, end, 'x\ny'));
assert.equal(session.draft_text().split('\n')[0], '| x y | b |');
const { start: at } = cell(1, 1);
accept(session.table_command(revision, at, at, 'InsertRowBelow'));
assert.equal(session.draft_text().split('\n').length, 5);
session.select_with_affinity(revision, cell(0, 0).end, cell(0, 0).end, '"Forward"');
assert.equal(
  typeof JSON.parse(session.table_key(revision, 'Tab')).selected.selection.start,
  'number',
);
session.free();
console.log('Compiled WASM tables: inspect, cell paste, row command and Tab key passed.');

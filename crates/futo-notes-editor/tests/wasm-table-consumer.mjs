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
// Native-unit variants address the same cells (ASCII: units agree) and refuse a split.
assert.equal(session.inspect_table_utf16(revision, 0, 0), session.inspect_table(revision, 0, 0));
const native = cell(0, 0);
accept(session.replace_utf16(revision, native.end, native.end, Uint16Array.of(0x7c)));
assert.equal(session.draft_text().split('\n')[0], '| x y\\| | b |');
const below = cell(1, 0);
accept(session.table_command_utf16(revision, below.start, below.end, 'InsertRowBelow'));
assert.equal(session.draft_text().split('\n').length, 6);
assert.throws(() => session.inspect_table_utf16(revision, 0, 10_000));
session.free();
console.log('Compiled WASM tables: inspect, cell paste, row command and Tab key passed.');

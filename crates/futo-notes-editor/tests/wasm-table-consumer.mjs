// Table cells, structural commands and keys through compiled WASM.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

const session = new WasmSession(1n, '| a | b |\n| --- | --- |\n| c | d |\n', 0n);
let revision = 0n;
// Acknowledge as the host would; the applied edit becomes the accepted revision.
const accept = (applied) => {
  const { sequence } = JSON.parse(applied).request;
  revision += 1n;
  session.acknowledge(
    JSON.stringify({
      token: 1,
      sequence,
      accepted: Number(revision),
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
accept(session.replace_utf16(revision, native.end, native.end, Uint16Array.of(0xe9)));
assert.equal(session.draft_text().split('\n')[0], '| x yé | b |');
const below = cell(1, 0);
accept(session.table_command_utf16(revision, below.start, below.end, 'InsertRowBelow'));
assert.equal(session.draft_text().split('\n').length, 6);
assert.throws(() => session.inspect_table_utf16(revision, 0, 10_000));
// Clearing a cell leaves its pipes; the same cell accepts the next
// native-unit input and exact history survives the worker boundary.
const edgeSource = '| Item | Owner |\n|:--- | --- |';
const edge = new WasmSession(2n, edgeSource, 0n);
let edgeRevision = 0n;
const edgeAccept = (applied) => {
  const { sequence } = JSON.parse(applied).request;
  edgeRevision += 1n;
  edge.acknowledge(
    JSON.stringify({
      token: 2,
      sequence,
      accepted: Number(edgeRevision),
      paused: false,
      error: null,
    }),
  );
};
edge.select_with_affinity(0n, 2, 6, '"Forward"');
edgeAccept(edge.paragraph_key_utf16(0n, 2, 6, '"Backspace"'));
assert.equal(edge.draft_text(), '|  | Owner |\n|:--- | --- |');
const clearedCell = JSON.parse(edge.inspect_table(edgeRevision, 2, 2));
assert.deepEqual(clearedCell.focus, { row: 0, column: 0 });
const emptyCell = clearedCell.rows[0][0].content;
assert.equal(emptyCell.start, emptyCell.end);
edgeAccept(edge.replace_utf16(edgeRevision, emptyCell.start, emptyCell.end, Uint16Array.of(0x58)));
assert.equal(edge.draft_text(), '| X | Owner |\n|:--- | --- |');
edgeAccept(edge.undo(edgeRevision));
assert.equal(edge.draft_text(), '|  | Owner |\n|:--- | --- |');
edgeAccept(edge.undo(edgeRevision));
assert.equal(edge.draft_text(), edgeSource);
edgeAccept(edge.redo(edgeRevision));
assert.equal(edge.draft_text(), '|  | Owner |\n|:--- | --- |');
const reopenedEdge = new WasmSession(3n, edge.draft_text(), 0n);
assert.deepEqual(JSON.parse(reopenedEdge.inspect_table(0n, 2, 2)).focus, { row: 0, column: 0 });
reopenedEdge.free();
edge.free();
session.free();

// Code taken out of a block keeps its bytes; a line that would start a table
// keeps reading as prose because nothing above it is a header.
const literalSource = '```\na | b\n|-|-|\n```';
const literal = new WasmSession(4n, literalSource, 0n);
assert.equal(JSON.parse(literal.inspect_table(0n, 0, 0)), null);
const plain = JSON.parse(literal.block_command_utf16(0n, 0, 11, '"WrapCodeBlock"'));
assert.equal(plain.change.projection.text, 'a | b\n|-|-|');
assert.equal(literal.draft_text(), 'a | b\n|-|-|');
assert.equal(JSON.parse(literal.inspect_table(1n, 0, 0)), null);
literal.undo(1n);
assert.equal(literal.draft_text(), literalSource);
literal.redo(2n);
assert.equal(JSON.parse(literal.inspect_table(3n, 0, 0)), null);
const literalReopened = new WasmSession(5n, literal.draft_text(), 0n);
assert.equal(JSON.parse(literalReopened.inspect_table(0n, 0, 0)), null);
literalReopened.free();
literal.free();

console.log('Compiled WASM tables: inspect, cell paste, row command and Tab key passed.');

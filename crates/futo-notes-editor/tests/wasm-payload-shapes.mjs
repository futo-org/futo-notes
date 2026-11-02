// Drift check: real WASM JSON must match packages/editor/src/wasmPayloads.d.ts exactly
// (no unknown keys, no missing required keys, literal unions respected).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { pathToFileURL, fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import ts from 'typescript';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

const dts = fileURLToPath(
  new URL('../../../packages/editor/src/wasmPayloads.d.ts', import.meta.url),
);
const file = ts.createSourceFile(dts, readFileSync(dts, 'utf8'), ts.ScriptTarget.Latest, true);
const decls = new Map();
for (const node of file.statements) {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    decls.set(node.name.text, node);
  }
}

function fits(node, value, path) {
  const fail = (why) => {
    throw new Error(`${path}: ${why} (${JSON.stringify(value)?.slice(0, 120)})`);
  };
  if (ts.isParenthesizedTypeNode(node)) return fits(node.type, value, path);
  if (ts.isUnionTypeNode(node)) {
    const errors = [];
    for (const member of node.types) {
      try {
        return fits(member, value, path);
      } catch (error) {
        errors.push(error.message);
      }
    }
    return fail(`no union member matched:\n  ${errors.join('\n  ')}`);
  }
  if (ts.isLiteralTypeNode(node)) {
    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return value === null || fail('not null');
    return value === node.literal.text || fail(`not ${node.literal.text}`);
  }
  if (node.kind === ts.SyntaxKind.NumberKeyword) {
    return (Number.isSafeInteger(value) && value >= 0) || fail('not a count');
  }
  if (node.kind === ts.SyntaxKind.StringKeyword) return typeof value === 'string' || fail('string');
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return typeof value === 'boolean' || fail('bool');
  if (ts.isArrayTypeNode(node)) {
    if (!Array.isArray(value)) fail('not an array');
    value.forEach((item, i) => fits(node.elementType, item, `${path}[${i}]`));
    return true;
  }
  if (ts.isTupleTypeNode(node)) {
    if (!Array.isArray(value) || value.length !== node.elements.length) fail('tuple length');
    node.elements.forEach((element, i) => fits(element, value[i], `${path}[${i}]`));
    return true;
  }
  if (ts.isTypeReferenceNode(node)) {
    const decl = decls.get(node.typeName.text);
    if (!decl) fail(`undeclared ${node.typeName.text}`);
    return ts.isTypeAliasDeclaration(decl)
      ? fits(decl.type, value, path)
      : members(decl.members, value, path);
  }
  if (ts.isTypeLiteralNode(node)) return members(node.members, value, path);
  return fail(`unsupported type node ${ts.SyntaxKind[node.kind]}`);

  function members(list, object, where) {
    if (object === null || typeof object !== 'object' || Array.isArray(object))
      fail('not an object');
    const known = new Set();
    for (const member of list) {
      const name = member.name.text;
      known.add(name);
      if (!(name in object)) {
        if (!member.questionToken) throw new Error(`${where}: missing ${name}`);
        continue;
      }
      fits(member.type, object[name], `${where}.${name}`);
    }
    for (const key of Object.keys(object)) {
      if (!known.has(key)) throw new Error(`${where}: undeclared field ${key}`);
    }
    return true;
  }
}
const covered = new Set();
const reference = (type) =>
  ts.createSourceFile('x.ts', `let x: ${type};`, ts.ScriptTarget.Latest, true).statements[0]
    .declarationList.declarations[0].type;
const shape = (type, json) => {
  covered.add(type.replace(/\W.*/, ''));
  const value = typeof json === 'string' ? JSON.parse(json) : json;
  fits(reference(type), value, type);
  return value;
};

const source =
  '---\ntitle: x\n---\n# Head\n\n**bé** [l](http://x.test "t") [[Road]] ![alt](img.png)\n\n- [ ] task\n1. num\n\n| a | b |\n| --- | --- |\n| c | d |\n\n```rust\ncode\n```\n---\n';
const session = new WasmSession(1n, source, 0n, 0n);
session.update_note_ids('["Road"]');
let length = Buffer.byteLength(session.draft_text());
while (length > 0) {
  try {
    session.project(0n, 0, length);
    break;
  } catch {
    length -= 1;
  }
}
const slice = shape('ProjectionSlice', session.project(0n, 0, length));
assert.ok(slice.blocks.some((b) => b.metadata && b.code === false));
assert.ok(slice.blocks.some((b) => b.list && b.code === false) && slice.atoms.length > 0);
assert.ok(slice.links.length && slice.wikilinks.some((w) => w.note_id === 'Road'));
assert.ok(slice.atoms.some((a) => a.image) && slice.blocks.some((b) => b.language === 'rust'));
shape('NoteIdChange', session.update_note_ids('["Road","Other"]'));
shape('NoteIdChange', session.update_note_ids('[]'));
shape('SelectionChange', session.select_with_affinity(0n, 3, 3, '"Forward"'));
shape(
  'LinkDescription | null',
  session.inspect_link(0n, slice.links[0].range.start, slice.links[0].range.end),
);
shape('PortableStatus', session.status());
shape('Composition | null', session.composition());
shape('Range', session.display_to_utf16(0n, 0, 1));
shape('Range', session.utf16_to_display(0n, 0, 1));
shape('string[]', session.tags());
shape('string[]', session.header_tags());
const report = shape('FindReport', session.find_set_query(0n, 'b'));
assert.ok(report.total > 0);
shape('FindReport', session.find_step(0n, true));
shape('FindScanRequest | null', session.find_scan_request());
const scan = shape('FindScanResult', WasmSession.find_scan(session.find_scan_request()));
shape('FindReport | null', session.find_apply_scan(JSON.stringify(scan)));
shape('DisplayRange[]', session.find_matches(0n, 0, length));
shape('FindReport', session.find_close());
const at = Buffer.byteLength(slice.text.slice(0, slice.text.indexOf('c')));
const table = shape('TableDescription | null', session.inspect_table(0n, at, at));
assert.ok(table, 'table expected at the cell');
const cell = table.rows[0][0].content;
session.select_with_affinity(0n, cell.end, cell.end, '"Forward"');
assert.ok(shape('TableDescription', session.inspect_table(0n, cell.end, cell.end)).focus);
shape('TableOutcome | null', session.table_key(0n, 'Tab'));
shape('string', JSON.stringify(session.copy_markdown(0n, 0, 4)));
shape('[string, HostRequest | null]', session.cut_markdown(0n, 0, 0));
assert.equal(typeof session.image_claim(), 'bigint');

const completion = new WasmSession(2n, '[[Ro', 0n, 0n);
completion.update_note_ids('["Road"]');
completion.select_with_affinity(0n, 4, 4, '"Forward"');
const open = shape('WikilinkCompletion | null', completion.wikilink_completion(0n));
assert.equal(open.candidates[0].note_id, 'Road');
shape(
  'HostRequest',
  completion.accept_wikilink_completion(0n, open.range.start, open.range.end, open.query, 'Road'),
);

// Requests, acknowledgements (with and without typed errors), snapshots and views.
const edit = new WasmSession(3n, 'abc', 0n, 0n);
const request = shape('HostRequest', edit.replace(0n, 1, 1, 'x'));
const ack = {
  token: 3,
  sequence: request.sequence,
  accepted: 1,
  durable: 0,
  paused: false,
  error: null,
};
shape('HostAck', ack);
const change = shape('ViewChange | null', edit.acknowledge(JSON.stringify(ack)));
assert.ok(change);
shape('HostRequest', edit.flush());
const failed = {
  ...ack,
  sequence: 2,
  paused: true,
  error: { kind: 'Storage', message: 'disk full' },
};
shape('HostAck', failed);
shape('HostAck', { ...ack, relink: { revision: 1, source: 'abc' } });
assert.equal(JSON.parse(edit.acknowledge(JSON.stringify(failed))), null);
shape('PortableStatus', edit.status());
assert.equal(JSON.parse(edit.status()).paused, true);
shape('HostRequest', edit.resume());
const snapshot = { token: 4, source: 'abc', revision: 0, durable: 0, paused: false };
shape('HostSnapshot', snapshot);
WasmSession.restore(JSON.stringify(snapshot)).free();
const block = new WasmSession(5n, 'abc', 0n, 0n);
shape('HostRequest | null', block.block_command_utf16(0n, 0, 0, '{"Heading":2}'));
shape('HostRequest', new WasmSession(6n, 'abc', 0n, 0n).resume());
const compose = new WasmSession(7n, 'abc', 0n, 0n);
shape('Composition', compose.compose_utf16(0n, 1, 1, Uint16Array.of(0x65e5)));
shape('Composition | null', compose.composition());
session.free();

console.log('Compiled WASM payload shapes match packages/editor/src/wasmPayloads.d.ts.');

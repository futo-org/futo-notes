// Actual compiled bounded page <-> source-only real Store worker. One retained
// engine per endpoint; the opening Full oracle is only a test display lookup.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
const { WasmSession, WasmBoundedSession } = await import(pathToFileURL(process.argv[2]).href);
const vault = mkdtempSync(join(tmpdir(), 'futo-editor-bounded-wasm-'));
const body = 'ab\n'.repeat(4096);
const paragraph = '__😀__ &acE; [x](u) plain\n\n';
const source = '```Rust\n' + body + '```\n\n' + paragraph.repeat(64);
const child = spawn(process.argv[3], [vault, source], { stdio: ['pipe', 'pipe', 'inherit'] });
const exited = once(child, 'exit');
const deadline = setTimeout(() => child.kill(), 30_000);
deadline.unref();
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const next = async () => {
  const line = await lines.next();
  assert.equal(line.done, false, 'worker reply required');
  return JSON.parse(line.value);
};
const exchange = async (request) => {
  child.stdin.write(JSON.stringify(request) + '\n');
  return next();
};
let page;
let full;
let oracle;
try {
  const snapshot = await next();
  oracle = WasmSession.restore(JSON.stringify(snapshot));
  // The source and literal fixture establish this opening byte length; this
  // independent Full query is outside all bounded input/results measurements.
  let text = JSON.parse(oracle.project(0n, 0, body.length - 1)).text;
  assert.equal(text, body.slice(0, -1));
  const shown = '😀 ∾\u0333 x plain\n\n';
  text += '\n\n' + shown.repeat(63) + shown.slice(0, -1);
  const apply = (frame) => {
    const bytes = Buffer.from(text);
    text = Buffer.concat([
      bytes.subarray(0, frame.range.start),
      Buffer.from(frame.inserted),
      bytes.subarray(frame.range.end),
    ]).toString();
  };
  const unwrap = (frame) => frame.Literal ?? frame.Progress?.Change ?? frame.Progress?.Status;
  const cursor = () => page.cursor();
  const accept = async (request) => {
    const ack = await exchange(request);
    assert.equal(ack.error, null);
    assert.equal(ack.work.parsed_source_bytes, 0);
    assert.ok(ack.work.copied_bytes < 4096);
    const frame = JSON.parse(page.acknowledge(JSON.stringify(ack)));
    if (frame) {
      const change = unwrap(frame);
      if ('range' in change) apply(change);
    }
    return { ack, frame };
  };
  page = new WasmBoundedSession(JSON.stringify(snapshot), 0);
  const entry = JSON.parse(page.entry_request());
  const ready = await exchange({ bounded_entry: entry });
  page.complete_entry(JSON.stringify(ready));
  assert.throws(() => page.complete_entry(JSON.stringify(ready)));
  assert.equal(JSON.parse(cursor()).revision, 0, 'failed repeat completion retains the same owner');
  assert.throws(() => page.insert_literal(cursor(), 0, '\n'));
  assert.equal(JSON.parse(page.last_operation_work()).input_bytes, 1);
  assert.equal(page.draft_text(), source);
  assert.throws(() => page.insert_literal('{', 0, 'q'));
  assert.ok(Object.values(JSON.parse(page.last_operation_work())).every((value) => value === 0));
  const remove = JSON.parse(page.remove_fence_closer(cursor()));
  const oldCursor = JSON.stringify({ token: 17, incarnation: 1, revision: 1, generation: 1 });
  assert.throws(() => page.select(oldCursor, 0, 0, '"Forward"'));
  const removed = await accept(remove);
  const continuation = unwrap(removed.frame).continuation;
  assert.equal(page.draft_text(), '```Rust\n' + body + '\n\n' + paragraph.repeat(64));
  const at = Buffer.byteLength(text.slice(0, text.lastIndexOf('plain') + 2));
  const selected = JSON.parse(page.select(cursor(), at, at, '"Backward"')).Change;
  assert.ok(selected);
  assert.ok(selected.projection.blocks.every((block) => block.description.code));
  assert.ok(selected.projection.mapping.some((part) => part.kind === 'Literal'));
  apply(selected);
  const first = JSON.parse(page.insert_literal(cursor(), selected.selection.start, 'x'));
  assert.throws(() => page.continue_projection(JSON.stringify(continuation)));
  const firstAck = await exchange(first);
  assert.deepEqual(await exchange(first), firstAck);
  assert.equal(JSON.parse(page.status()).displayed, 1);
  assert.equal((await exchange({ bounded_source: true })).source, page.draft_text());
  const resumed = JSON.parse(page.resume());
  const recovered = JSON.parse(page.acknowledge(JSON.stringify(await exchange(resumed))));
  apply(unwrap(recovered));
  assert.equal(JSON.parse(page.acknowledge(JSON.stringify(firstAck))), null);
  const current = unwrap(recovered).continuation;
  const progress = JSON.parse(page.continue_projection(JSON.stringify(current)));
  const progressed = progress.Change;
  assert.ok(progressed);
  apply(progressed);
  assert.throws(() => page.continue_projection(JSON.stringify(current)));
  const second = JSON.parse(
    page.insert_literal_utf16(cursor(), progressed.selection.start, new Uint16Array([121])),
  );
  const secondResult = await accept(second);
  assert.equal(unwrap(secondResult.frame).work.input_bytes, 3, 'UTF-16 read plus UTF-8 input');
  assert.ok(page.draft_text().includes('plxyain'));
  await accept(JSON.parse(page.undo(cursor())));
  assert.equal(page.draft_text(), '```Rust\n' + body + '\n\n' + paragraph.repeat(64));
  const restored = await accept(JSON.parse(page.undo(cursor())));
  let continuationBack = unwrap(restored.frame).continuation;
  let steps = 0;
  while (continuationBack) {
    const progress = JSON.parse(page.continue_projection(JSON.stringify(continuationBack)));
    const frame = progress.Change ?? progress.Status;
    if ('range' in frame) apply(frame);
    continuationBack = frame.continuation;
    assert.ok(++steps < 100);
  }
  assert.equal(page.draft_text(), source);
  assert.equal((await exchange({ bounded_source: true })).source, source);
  await accept(JSON.parse(page.flush()));
  full = page.materialize();
  assert.throws(() => page.cursor(), 'old bounded alias cannot resume after materialization');
  const fullSnapshot = await exchange({ bounded_full: true });
  assert.equal(fullSnapshot.source, source);
  const projected = JSON.parse(
    full.project(BigInt(fullSnapshot.revision), 0, Buffer.byteLength(text)),
  );
  assert.equal(projected.text, text);
  const redo = JSON.parse(full.redo(BigInt(fullSnapshot.revision)));
  const redoAck = await exchange(redo);
  assert.equal(redoAck.error, null);
  assert.ok(
    JSON.parse(full.acknowledge(JSON.stringify(redoAck))),
    'same page owner retains real Redo after full return',
  );
  console.log(
    'bounded WASM/real Store: far frame, grouped source inverse, closer restore, lost/duplicate ACK and same-owner history passed',
  );
} finally {
  page?.free();
  full?.free();
  oracle?.free();
  child.stdin.end();
  const [code] = await exited;
  clearTimeout(deadline);
  rmSync(vault, { recursive: true, force: true });
  assert.equal(code, 0);
}

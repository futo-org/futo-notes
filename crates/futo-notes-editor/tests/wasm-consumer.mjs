// Actual WASM editor <-> Rust store worker, with an independent display view.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

(async () => {
  const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-'));
  const worker = spawn(process.argv[3], [vault], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(worker, 'exit');
  const deadline = setTimeout(() => worker.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  let page;
  try {
    const next = async () => {
      const line = await lines.next();
      assert.equal(line.done, false, 'worker must return a reply');
      return JSON.parse(line.value);
    };
    const exchange = async (request) => {
      worker.stdin.write(JSON.stringify(request) + '\n');
      return next();
    };
    assert.throws(() => new WasmSession(9_007_199_254_740_992n, '', 0n, 0n));
    const initial = await next();
    assert.equal(initial.source, '__a__\r\n');
    page = WasmSession.restore(JSON.stringify(initial));
    const opening = JSON.parse(page.project(0n, 0, 3));
    assert.equal(opening.text, 'a\r\n');
    assert.deepEqual(opening.runs[0].formats, ['Bold']);
    assert.ok(opening.correspondence.some((part) => part.display.start === part.display.end));
    let text = opening.text;
    const apply = (change) => {
      assert.ok(change);
      const bytes = Buffer.from(text);
      text = Buffer.concat([
        bytes.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        bytes.subarray(change.range.end),
      ]).toString();
    };
    const request = JSON.parse(page.replace(0n, 1, 1, '🎉'));
    assert.equal(page.draft_text(), '__a🎉__\r\n');
    assert.equal(text, 'a\r\n');
    assert.equal(JSON.parse(page.status()).accepted, 0);
    assert.throws(() => page.replace(1n, 1, 1, '?'));
    const ack = await exchange(request);
    assert.equal(ack.accepted, 1);
    assert.equal(ack.durable, 0);
    assert.equal(JSON.parse(page.acknowledge(JSON.stringify({ ...ack, token: 99 }))), null);
    assert.equal(JSON.parse(page.status()).accepted, 0);
    assert.deepEqual(await exchange(request), ack);
    apply(JSON.parse(page.acknowledge(JSON.stringify(ack))));
    assert.equal(text, 'a🎉\r\n');
    assert.equal(JSON.parse(page.acknowledge(JSON.stringify(ack))), null);
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(1n)))))));
    assert.equal(text, 'a\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.redo(2n)))))));
    assert.equal(text, 'a🎉\r\n');
    const selection = JSON.parse(page.select_with_affinity(3n, 0, 5, '"Forward"'));
    assert.equal(selection.affinity, 'Forward');
    const toggle = JSON.parse(page.toggle_format(3n, '"Strike"'));
    assert.throws(() => page.project(4n, 0, 7));
    const rich = JSON.parse(page.acknowledge(JSON.stringify(await exchange(toggle))));
    apply(rich);
    assert.equal(text, 'a🎉\r\n');
    assert.equal(page.draft_text(), '~~__a🎉__~~\r\n');
    assert.equal(rich.affinity, 'Forward');
    assert.deepEqual(rich.projection.runs[0].formats, ['Bold', 'Strike']);
    assert.deepEqual(JSON.parse(page.project(4n, 0, 7)), rich.projection);
    const entity = JSON.parse(page.replace(4n, 0, 5, '&acE;'));
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(entity)))));
    assert.equal(text, '∾\u0333\r\n');
    assert.equal(page.draft_text(), '~~__&acE;__~~\r\n');
    const entityProjection = JSON.parse(page.project(5n, 0, 7));
    assert.ok(
      entityProjection.correspondence.some(
        (part) =>
          part.source.start === 4 &&
          part.source.end === 9 &&
          part.display.start === 0 &&
          part.display.end === 5,
      ),
    );
    for (const affinity of ['Backward', 'Forward']) {
      assert.deepEqual(JSON.parse(page.select_with_affinity(5n, 3, 3, JSON.stringify(affinity))), {
        revision: 5,
        selection: { start: 3, end: 3 },
        affinity,
      });
    }
    const partialEntity = JSON.parse(page.replace_utf16(5n, 1, 2, new Uint16Array([120])));
    const entityChange = JSON.parse(
      page.acknowledge(JSON.stringify(await exchange(partialEntity))),
    );
    apply(entityChange);
    assert.equal(text, '∾x\r\n');
    assert.equal(page.draft_text(), '~~__&#8766;x__~~\r\n');
    assert.deepEqual(entityChange.selection, { start: 4, end: 4 });
    assert.deepEqual(entityChange.projection.runs[0].formats, ['Bold', 'Strike']);
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(6n)))))));
    assert.equal(text, '∾\u0333\r\n');
    assert.equal(page.draft_text(), '~~__&acE;__~~\r\n');
    assert.deepEqual(JSON.parse(page.project(7n, 0, 7)), { ...entityProjection, revision: 7 });
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.redo(7n)))))));
    assert.equal(text, '∾x\r\n');
    assert.equal(page.draft_text(), '~~__&#8766;x__~~\r\n');
    const flush = JSON.parse(page.flush());
    assert.equal(JSON.parse(page.status()).durable, 0);
    page.acknowledge(JSON.stringify(await exchange(flush)));
    assert.equal(JSON.parse(page.status()).durable, 8);
  } finally {
    clearTimeout(deadline);
    page?.free();
    worker.stdin.end();
    const [code] = await exited;
    rmSync(vault, { recursive: true });
    assert.equal(code, 0);
  }
  console.log('Compiled WASM / Rust store consumer: ordered edit/undo/redo/append/flush passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

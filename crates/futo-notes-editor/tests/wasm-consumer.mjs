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
    assert.equal(initial.source, 'a\r\n');
    page = WasmSession.restore(JSON.stringify(initial));
    let text = initial.source;
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
    assert.equal(page.draft_text(), 'a🎉\r\n');
    assert.equal(text, 'a\r\n');
    assert.equal(JSON.parse(page.status()).accepted, 0);
    assert.throws(() => page.replace(1n, 1, 1, '?'));
    const ack = await exchange(request);
    assert.equal(ack.accepted, 1);
    assert.equal(ack.durable, 0);
    assert.deepEqual(await exchange(request), ack);
    apply(JSON.parse(page.acknowledge(JSON.stringify(ack))));
    assert.equal(text, 'a🎉\r\n');
    assert.equal(JSON.parse(page.acknowledge(JSON.stringify(ack))), null);
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.undo(1n)))))));
    assert.equal(text, 'a\r\n');
    apply(JSON.parse(page.acknowledge(JSON.stringify(await exchange(JSON.parse(page.redo(2n)))))));
    assert.equal(text, 'a🎉\r\n');
    const flush = JSON.parse(page.flush());
    assert.equal(JSON.parse(page.status()).durable, 0);
    page.acknowledge(JSON.stringify(await exchange(flush)));
    assert.equal(JSON.parse(page.status()).durable, 3);
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

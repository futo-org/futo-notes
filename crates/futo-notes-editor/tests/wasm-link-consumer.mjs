// Link semantics and exact recovery through compiled WASM and the real store.
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

const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-links-'));
const referenceVault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-references-'));
let session;
let worker;
let exited;
let deadline;
const start = async (fixture, root = vault) => {
  worker = spawn(process.argv[3], [root, fixture], { stdio: ['pipe', 'pipe', 'inherit'] });
  exited = once(worker, 'exit');
  deadline = setTimeout(() => worker.kill(), 30_000);
  deadline.unref();
  const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  };
  session = WasmSession.restore(JSON.stringify(await next()));
  return async (request) => {
    worker.stdin.write(request + '\n');
    return next();
  };
};
const stop = async () => {
  clearTimeout(deadline);
  session?.free();
  session = undefined;
  worker.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
};
try {
  const exchange = await start("see [teh __docs__](https://old.test 'Title')\r\n");
  let display = 'see teh docs\r\n';
  const accept = async (request) => {
    const ack = await exchange(request);
    const change = JSON.parse(session.acknowledge(JSON.stringify(ack)));
    const bytes = Buffer.from(display);
    display = Buffer.concat([
      bytes.subarray(0, change.range.start),
      Buffer.from(change.inserted),
      bytes.subarray(change.range.end),
    ]).toString();
    assert.equal(JSON.parse(session.acknowledge(JSON.stringify(ack))), null);
    return change;
  };
  await accept(session.replace(0n, 4, 7, 'the'));
  assert.equal(display, 'see the docs\r\n');
  assert.deepEqual(JSON.parse(session.inspect_link(1n, 5, 6)), {
    range: { start: 4, end: 12 },
    destination: 'https://old.test',
    title: 'Title',
  });
  const request = session.set_link(1n, 5, 6, 'https://x.test');
  assert.throws(() => session.project(2n, 0, 14));
  await accept(request);
  const updated = "see [the __docs__](https://x.test 'Title')\r\n";
  assert.equal(display, 'see the docs\r\n');
  assert.equal(session.draft_text(), updated);
  assert.equal(JSON.parse(session.project(2n, 0, 14)).links[0].destination, 'https://x.test');
  await accept(session.undo(2n));
  assert.equal(session.draft_text(), "see [the __docs__](https://old.test 'Title')\r\n");
  await accept(session.redo(3n));
  session.acknowledge(JSON.stringify(await exchange(session.flush())));
  assert.equal(JSON.parse(session.status()).durable, 4);
  await stop();
  const reopened = await start('--reopen');
  assert.equal(session.draft_text(), updated);
  assert.equal(JSON.parse(session.project(4n, 0, 14)).text, display);
  assert.equal(JSON.parse(session.inspect_link(4n, 5, 6)).destination, 'https://x.test');
  assert.deepEqual(await reopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
  const referenceSource = "[id]: <https://x.test> 'T'\n\nmiddle\n\n[one][id] end";
  const unlinkedSource = "[id]: <https://x.test> 'T'\n\nmiddle\n\none end";
  const referenceExchange = await start(referenceSource, referenceVault);
  let referenceDisplay = 'middle\n\none end';
  const unlinkRequest = session.set_link(0n, 9, 10, '');
  assert.throws(() => session.project(1n, 0, 15));
  const referenceAck = await referenceExchange(unlinkRequest);
  const referenceChange = JSON.parse(session.acknowledge(JSON.stringify(referenceAck)));
  const openingBytes = Buffer.from(referenceDisplay);
  referenceDisplay = Buffer.concat([
    openingBytes.subarray(0, referenceChange.range.start),
    Buffer.from(referenceChange.inserted),
    openingBytes.subarray(referenceChange.range.end),
  ]).toString();
  assert.equal(referenceDisplay, unlinkedSource);
  assert.deepEqual(referenceChange.selection, { start: 37, end: 38 });
  assert.equal(session.draft_text(), unlinkedSource);
  assert.equal(JSON.parse(session.inspect_link(1n, 36, 39)), null);
  session.acknowledge(JSON.stringify(await referenceExchange(session.flush())));
  await stop();
  const referenceReopened = await start('--reopen', referenceVault);
  assert.equal(session.draft_text(), unlinkedSource);
  assert.equal(JSON.parse(session.project(1n, 0, 43)).text, unlinkedSource);
  assert.deepEqual(await referenceReopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
  console.log(
    'Compiled WASM links: canonical inspection, ordered acceptance, exact history and real recovery passed.',
  );
} finally {
  if (session) await stop();
  rmSync(vault, { recursive: true });
  rmSync(referenceVault, { recursive: true });
}

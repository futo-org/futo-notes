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
const timingVaults = [];
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
  for (const kind of ['typed', 'composed']) {
    const timingVault = mkdtempSync(join(tmpdir(), `futo-editor-wasm-url-${kind}-`));
    timingVaults.push(timingVault);
    const timingExchange = await start('', timingVault);
    let timingDisplay = '';
    let timingRevision = 0n;
    const applyTiming = async (request) => {
      const ack = await timingExchange(request);
      const change = JSON.parse(session.acknowledge(JSON.stringify(ack)));
      const before = Buffer.from(timingDisplay);
      timingDisplay = Buffer.concat([
        before.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        before.subarray(change.range.end),
      ]).toString();
      timingRevision += 1n;
      assert.equal(change.revision, Number(timingRevision));
      assert.equal(JSON.parse(session.acknowledge(JSON.stringify(ack))), null);
      return change;
    };
    const pendingSource = 'x \\*b https://x.test/a*';
    if (kind === 'typed') {
      for (const ch of 'x *b https://x.test/a*') {
        const at = Buffer.byteLength(timingDisplay);
        await applyTiming(session.replace(timingRevision, at, at, ch));
        assert.equal(
          JSON.parse(session.project(timingRevision, 0, Buffer.byteLength(timingDisplay))).links
            .length,
          0,
        );
      }
      assert.equal(timingDisplay, 'x *b https://x.test/a*');
      assert.equal(session.draft_text(), pendingSource);
      session.compose_utf16(timingRevision, 22, 22, Uint16Array.of(32));
    } else {
      const text = 'x *b https://x.test/a* ';
      session.compose_utf16(
        timingRevision,
        0,
        0,
        Uint16Array.from([...text].map((ch) => ch.charCodeAt(0))),
      );
      assert.equal(session.draft_text(), '');
    }
    const finalSource = 'x *B https://x.test/a* ';
    const beforeCorrection = JSON.parse(session.status());
    let correction = session.replace(timingRevision, 3, 4, 'B');
    // Portable draft_text is the copyable pending local draft; only the
    // accepted/displayed watermarks and released delta wait for host ack.
    assert.equal(session.draft_text(), finalSource);
    assert.equal(JSON.parse(session.status()).accepted, beforeCorrection.accepted);
    assert.equal(JSON.parse(session.status()).displayed, beforeCorrection.displayed);
    assert.equal(timingDisplay, kind === 'typed' ? 'x *b https://x.test/a*' : '');
    assert.throws(() => session.project(timingRevision + 1n, 0, 21));
    if (kind === 'typed') {
      // Inject a transport rejection before sending this request to the real
      // store. Store append/short-write faults are separate Rust public tests.
      const request = JSON.parse(correction);
      const failed = JSON.stringify({
        token: request.token,
        sequence: request.sequence,
        accepted: beforeCorrection.accepted,
        durable: beforeCorrection.durable,
        paused: true,
        error: 'injected transport rejection',
      });
      assert.equal(JSON.parse(session.acknowledge(failed)), null);
      assert.equal(JSON.parse(session.status()).accepted, beforeCorrection.accepted);
      assert.equal(JSON.parse(session.status()).displayed, beforeCorrection.displayed);
      assert.equal(JSON.parse(session.status()).paused, true);
      assert.equal(session.draft_text(), finalSource);
      assert.equal(timingDisplay, 'x *b https://x.test/a*');
      assert.equal(
        JSON.parse(session.acknowledge(JSON.stringify(await timingExchange(session.resume())))),
        null,
      );
      correction = session.retry_pending();
      assert.equal(JSON.parse(session.acknowledge(failed)), null);
      assert.equal(JSON.parse(session.status()).paused, false);
    }
    const corrected = await applyTiming(correction);
    assert.deepEqual(corrected.selection, { start: 3, end: 3 });
    assert.equal(session.draft_text(), finalSource);
    assert.equal(timingDisplay, 'x B https://x.test/a ');
    assert.equal(
      JSON.parse(session.inspect_link(timingRevision, 4, 20)).destination,
      'https://x.test/a',
    );
    const undoCorrection = await applyTiming(session.undo(timingRevision));
    assert.equal(session.draft_text(), 'x *b https://x.test/a* ');
    assert.deepEqual(undoCorrection.selection, { start: 21, end: 21 });
    await applyTiming(session.undo(timingRevision));
    assert.equal(session.draft_text(), kind === 'typed' ? pendingSource : '');
    assert.equal(timingDisplay, kind === 'typed' ? 'x *b https://x.test/a*' : '');
    await applyTiming(session.redo(timingRevision));
    const redone = await applyTiming(session.redo(timingRevision));
    assert.equal(session.draft_text(), finalSource);
    assert.deepEqual(redone.selection, { start: 3, end: 3 });
    session.acknowledge(JSON.stringify(await timingExchange(session.flush())));
    assert.equal(JSON.parse(session.status()).durable, Number(timingRevision));
    await stop();
    const timingReopened = await start('--reopen', timingVault);
    assert.equal(session.draft_text(), finalSource);
    assert.equal(JSON.parse(session.project(timingRevision, 0, 21)).text, 'x B https://x.test/a ');
    assert.equal(
      JSON.parse(session.inspect_link(timingRevision, 4, 20)).destination,
      'https://x.test/a',
    );
    assert.equal(JSON.parse(session.undo(timingRevision)), null);
    assert.deepEqual(await timingReopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
  }
  console.log(
    'Compiled WASM links: canonical inspection, URL timing, retained/inserted targets, ordered acceptance, exact history and real recovery passed.',
  );
} finally {
  if (session) await stop();
  rmSync(vault, { recursive: true });
  rmSync(referenceVault, { recursive: true });
  for (const timingVault of timingVaults) rmSync(timingVault, { recursive: true });
}

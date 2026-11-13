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
import { partialLink } from './partial-link-consumer.mjs';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
const { WasmSession } = await import(pathToFileURL(process.argv[2]).href);

const vault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-links-'));
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
  // Every edit returns `{change, request}`: the page shows the change at once
  // and the worker mirrors the request.
  const accept = async (applied) => {
    const { change, request } = JSON.parse(applied);
    const ack = await exchange(JSON.stringify(request));
    assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(ack))), []);
    const bytes = Buffer.from(display);
    display = Buffer.concat([
      bytes.subarray(0, change.range.start),
      Buffer.from(change.inserted),
      bytes.subarray(change.range.end),
    ]).toString();
    assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(ack))), []);
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
  // Queries do not wait for the worker.
  assert.equal(JSON.parse(session.project(2n, 0, 14)).links[0].destination, 'https://x.test');
  await accept(request);
  const updated = "see [the __docs__](https://x.test 'Title')\r\n";
  assert.equal(display, 'see the docs\r\n');
  assert.equal(session.draft_text(), updated);
  assert.equal(JSON.parse(session.project(2n, 0, 14)).links[0].destination, 'https://x.test');
  await accept(session.undo(2n));
  assert.equal(session.draft_text(), "see [the __docs__](https://old.test 'Title')\r\n");
  await accept(session.redo(3n));
  await stop();
  await partialLink(start, stop, () => session, timingVaults);
  const reopened = await start('--reopen');
  assert.equal(session.draft_text(), updated);
  assert.equal(JSON.parse(session.project(0n, 0, 14)).text, display);
  assert.equal(JSON.parse(session.inspect_link(0n, 5, 6)).destination, 'https://x.test');
  assert.deepEqual(await reopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  // The public WASM command mirrors one source record, with one Undo step.
  const applied = JSON.parse(session.edit_link(0n, 5, 6, '雪 [label]', '/new'));
  const ack = await reopened(JSON.stringify(applied.request));
  assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(ack))), []);
  assert.equal(JSON.parse(session.project(1n, 0, 17)).text, 'see 雪 [label]\r\n');
  assert.equal(JSON.parse(session.inspect_link(1n, 4, 7)).destination, '/new');
  const undoLabel = JSON.parse(session.undo(1n));
  const undoAck = await reopened(JSON.stringify(undoLabel.request));
  assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(undoAck))), []);
  assert.equal(session.draft_text(), updated);
  await stop();
  for (const kind of ['typed', 'composed']) {
    const timingVault = mkdtempSync(join(tmpdir(), `futo-editor-wasm-url-${kind}-`));
    timingVaults.push(timingVault);
    const timingExchange = await start('', timingVault);
    let timingDisplay = '';
    let timingRevision = 0n;
    const showTiming = (change) => {
      const before = Buffer.from(timingDisplay);
      timingDisplay = Buffer.concat([
        before.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        before.subarray(change.range.end),
      ]).toString();
      timingRevision += 1n;
      assert.equal(change.revision, Number(timingRevision));
      return change;
    };
    const applyTiming = async (applied) => {
      const { change, request } = JSON.parse(applied);
      const ack = await timingExchange(JSON.stringify(request));
      assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(ack))), []);
      assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(ack))), []);
      return showTiming(change);
    };
    const pendingSource = 'x *b https://x.test/a*';
    if (kind === 'typed') {
      // Each key lands exactly as typed; nothing is escaped.
      let typed = '';
      for (const ch of pendingSource) {
        const at = Buffer.byteLength(timingDisplay);
        await applyTiming(session.replace(timingRevision, at, at, ch));
        typed += ch;
        assert.equal(session.draft_text(), typed);
      }
      assert.equal(timingDisplay, 'x b https://x.test/a');
      session.compose_utf16(timingRevision, 20, 20, Uint16Array.of(32));
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
    // Input during composition addresses the provisional display: the typed
    // note hides its `*`, the marked text shows it.
    const b = kind === 'typed' ? 2 : 3;
    let correction = session.replace(timingRevision, b, b + 1, 'B');
    // The edit is in the page's draft at once; only the accepted watermark
    // waits for the worker.
    assert.equal(session.draft_text(), finalSource);
    assert.equal(JSON.parse(session.status()).accepted, beforeCorrection.accepted);
    assert.ok(session.project(timingRevision + 1n, 0, 21));
    if (kind === 'typed') {
      // Inject a transport rejection before sending this request to the real
      // store. Store append/short-write faults are separate Rust public tests.
      const original = JSON.parse(correction);
      const failed = JSON.stringify({
        token: original.request.token,
        sequence: original.request.sequence,
        accepted: beforeCorrection.accepted,
        paused: true,
        error: { kind: 'Rejected', message: 'injected transport rejection' },
      });
      assert.deepEqual(JSON.parse(session.acknowledge(failed)), []);
      assert.equal(JSON.parse(session.status()).accepted, beforeCorrection.accepted);
      assert.equal(JSON.parse(session.status()).paused, true);
      assert.equal(session.draft_text(), finalSource);
      // A paused page refuses input but still answers queries.
      assert.throws(() => session.replace(timingRevision + 1n, 0, 0, 'z'), /Paused/);
      assert.ok(session.project(timingRevision + 1n, 0, 21));
      // The worker never saw the correction, so Resume re-sends it.
      const resumeAck = await timingExchange(session.resume());
      const resent = JSON.parse(session.acknowledge(JSON.stringify(resumeAck)));
      assert.equal(resent.length, 1);
      assert.equal(resent[0].operation.Append.revision, original.request.operation.Append.revision);
      assert.notEqual(resent[0].sequence, original.request.sequence);
      correction = JSON.stringify({ change: original.change, request: resent[0] });
      assert.deepEqual(JSON.parse(session.acknowledge(failed)), []);
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
    assert.equal(timingDisplay, kind === 'typed' ? 'x b https://x.test/a' : '');
    await applyTiming(session.redo(timingRevision));
    const redone = await applyTiming(session.redo(timingRevision));
    assert.equal(session.draft_text(), finalSource);
    assert.deepEqual(redone.selection, { start: 3, end: 3 });
    await stop();
    const timingReopened = await start('--reopen', timingVault);
    assert.equal(session.draft_text(), finalSource);
    assert.equal(JSON.parse(session.project(0n, 0, 21)).text, 'x B https://x.test/a ');
    assert.equal(JSON.parse(session.inspect_link(0n, 4, 20)).destination, 'https://x.test/a');
    assert.equal(JSON.parse(session.undo(0n)), null);
    assert.deepEqual(await timingReopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
  }
  {
    const liveVault = mkdtempSync(join(tmpdir(), 'futo-editor-wasm-live-split-'));
    timingVaults.push(liveVault);
    const liveExchange = await start('# x ', liveVault);
    let liveDisplay = 'x ';
    let revision = 0n;
    const applyLive = async (applied) => {
      const { change, request } = JSON.parse(applied);
      const ack = await liveExchange(JSON.stringify(request));
      assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(ack))), []);
      assert.ok(change);
      const bytes = Buffer.from(liveDisplay);
      liveDisplay = Buffer.concat([
        bytes.subarray(0, change.range.start),
        Buffer.from(change.inserted),
        bytes.subarray(change.range.end),
      ]).toString();
      revision = BigInt(change.revision);
      assert.deepEqual(JSON.parse(session.acknowledge(JSON.stringify(ack))), []);
      return change;
    };
    const pendingSource = '# x *b https://x.test/a*';
    const committed = '# x *b https://x.test/a*\n';
    await applyLive(session.replace(0n, 2, 2, '*b https://x.test/a*'));
    assert.equal(session.draft_text(), pendingSource);
    // Typed text lands as typed and the address is a link at once.
    assert.equal(liveDisplay, 'x b https://x.test/a');
    assert.equal(JSON.parse(session.inspect_link(1n, 4, 5)).destination, 'https://x.test/a');
    let request = session.paragraph_key_utf16(1n, 20, 20, JSON.stringify('Enter'));
    const before = JSON.parse(session.status());
    assert.equal(before.accepted, 1);
    assert.equal(session.draft_text(), committed);
    assert.ok(session.project(2n, 0, 21));
    const body = JSON.parse(request);
    const failed = JSON.stringify({
      token: body.request.token,
      sequence: body.request.sequence,
      accepted: 1,
      paused: true,
      error: { kind: 'Rejected', message: 'injected transport rejection' },
    });
    assert.deepEqual(JSON.parse(session.acknowledge(failed)), []);
    assert.equal(JSON.parse(session.status()).accepted, 1);
    assert.equal(liveDisplay, 'x b https://x.test/a');
    const resumeAck = await liveExchange(session.resume());
    const resent = JSON.parse(session.acknowledge(JSON.stringify(resumeAck)));
    assert.equal(resent.length, 1);
    request = JSON.stringify({ change: body.change, request: resent[0] });
    const entered = await applyLive(request);
    assert.deepEqual(JSON.parse(session.acknowledge(failed)), []);
    assert.deepEqual(entered.selection, { start: 21, end: 21 });
    assert.equal(liveDisplay, 'x b https://x.test/a\n');
    assert.equal(JSON.parse(session.inspect_link(revision, 4, 5)).destination, 'https://x.test/a');
    await applyLive(session.undo(revision));
    assert.equal(session.draft_text(), pendingSource);
    assert.equal(liveDisplay, 'x b https://x.test/a');
    const redone = await applyLive(session.redo(revision));
    await applyLive(session.replace(revision, redone.selection.end, redone.selection.end, '!'));
    assert.equal(session.draft_text(), committed + '!');
    assert.equal(liveDisplay, 'x b https://x.test/a\n!');
    await applyLive(session.undo(revision));
    await applyLive(session.undo(revision));
    assert.equal(session.draft_text(), pendingSource);
    await applyLive(session.undo(revision));
    assert.equal(session.draft_text(), '# x ');
    assert.equal(liveDisplay, 'x ');
    await applyLive(session.redo(revision));
    await applyLive(session.redo(revision));
    await applyLive(session.redo(revision));
    assert.equal(session.draft_text(), committed + '!');
    await stop();
    const liveReopened = await start('--reopen', liveVault);
    assert.equal(session.draft_text(), committed + '!');
    assert.equal(JSON.parse(session.project(0n, 0, 22)).text, 'x b https://x.test/a\n!');
    assert.equal(JSON.parse(session.inspect_link(0n, 4, 5)).destination, 'https://x.test/a');
    assert.equal(JSON.parse(session.undo(0n)), null);
    assert.deepEqual(await liveReopened(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
  }
  console.log(
    'Compiled WASM links: canonical inspection, URL timing, retained/inserted targets, immediate edits, exact history and real store saving passed.',
  );
} finally {
  if (session) await stop();
  rmSync(vault, { recursive: true });
  for (const timingVault of timingVaults) rmSync(timingVault, { recursive: true });
}

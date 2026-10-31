// Existing eligible typed origin across canonical relink in compiled WASM.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function relinkTypedConsumer({ start, stop, getSession, createRoot, parseSource }) {
  for (const word of ['www.x.test/[[plain]]/path', 'www.x.test/[[next]]/path']) {
    const canonical = parseSource(word);
    const literal = parseSource(`<${word}`);
    try {
      const inspected = JSON.parse(canonical.inspect_link(0n, 0, 1));
      assert.deepEqual(inspected.range, { start: 0, end: Buffer.byteLength(word) });
      assert.equal(inspected.destination, `http://${word}`);
      const loaded = JSON.parse(literal.project(0n, 0, Buffer.byteLength(word) + 1));
      assert.equal(loaded.text, `<${word}`);
      assert.deepEqual(loaded.links, []);
    } finally {
      canonical.free();
      literal.free();
    }
  }
  const root = createRoot('futo-editor-wasm-relink-typed-');
  let exchange = await start('', root);
  let page = getSession();
  let shown = '';
  let revision = 0n;
  const apply = async (request, reject = false) => {
    const before = JSON.parse(page.status());
    const displayed = shown;
    const draft = page.draft_text();
    assert.throws(() => page.project(revision, 0, Buffer.byteLength(shown)));
    if (reject) {
      // This transport refusal is before Store append; actual Append and
      // ShortWrite failures for the same lifecycle are separate Rust tests.
      const body = JSON.parse(request);
      const failed = JSON.stringify({
        token: body.token,
        sequence: body.sequence,
        accepted: before.accepted,
        durable: before.durable,
        paused: true,
        error: 'injected typed relink transport rejection',
      });
      assert.equal(JSON.parse(page.acknowledge(failed)), null);
      assert.equal(JSON.parse(page.status()).accepted, before.accepted);
      assert.equal(JSON.parse(page.status()).displayed, before.displayed);
      assert.equal(page.draft_text(), draft);
      assert.equal(shown, displayed);
      assert.equal(
        JSON.parse(page.acknowledge(JSON.stringify(await exchange(page.resume())))),
        null,
      );
      request = page.retry_pending();
      assert.equal(JSON.parse(page.acknowledge(failed)), null);
    }
    const ack = await exchange(request);
    assert.equal(JSON.parse(page.status()).accepted, before.accepted);
    assert.equal(JSON.parse(page.status()).displayed, before.displayed);
    assert.equal(shown, displayed);
    assert.deepEqual(await exchange(request), ack);
    const change = JSON.parse(page.acknowledge(JSON.stringify(ack)));
    assert.ok(change);
    const bytes = Buffer.from(shown);
    shown = Buffer.concat([
      bytes.subarray(0, change.range.start),
      Buffer.from(change.inserted),
      bytes.subarray(change.range.end),
    ]).toString();
    revision = BigInt(change.revision);
    assert.equal(JSON.parse(page.acknowledge(JSON.stringify(ack))), null);
  };
  const old = '<www.x.test/[[plain]]/path';
  const renamed = '<www.x.test/[[next]]/path';
  await apply(page.replace(0n, 0, 0, old));
  assert.equal(page.draft_text(), old);
  assert.deepEqual(JSON.parse(page.project(1n, 0, 26)).links, []);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  assert.deepEqual(await exchange(JSON.stringify({ rename: 'next' })), { id: 'next' });
  const offer = await exchange(page.flush());
  assert.ok(offer.relink);
  assert.equal(JSON.parse(page.acknowledge(JSON.stringify(offer))), null);
  const request = page.apply_relink_offer();
  assert.equal(page.draft_text(), renamed);
  assert.equal(shown, old);
  await apply(request, true);
  assert.equal(shown, renamed);
  assert.equal(JSON.parse(page.acknowledge(JSON.stringify(offer))), null);
  assert.deepEqual(JSON.parse(page.project(2n, 0, 25)).links, []);
  await apply(page.undo(2n));
  assert.equal(shown, '');
  assert.equal(page.draft_text(), '');
  await apply(page.redo(3n));
  assert.equal(shown, renamed);
  assert.equal(page.draft_text(), renamed);
  assert.deepEqual(JSON.parse(page.project(4n, 0, 25)).links, []);
  await apply(page.replace(4n, 25, 25, '>'));
  assert.equal(shown, `${renamed}>`);
  assert.deepEqual(JSON.parse(page.project(5n, 0, 26)).links, []);
  const closed = page.draft_text();
  // An actual caret excursion separates these two Typing actions. Consecutive
  // closer+Space may otherwise form one timed history group, as specified.
  page.select_with_affinity(5n, 0, 0, '"Forward"');
  page.select_with_affinity(5n, 26, 26, '"Forward"');
  await apply(page.replace(5n, 26, 26, ' '));
  assert.equal(shown, `${renamed}> `);
  const destination = 'http://www.x.test/[[next]]/path';
  assert.equal(JSON.parse(page.inspect_link(6n, 1, 2)).destination, destination);
  await apply(page.undo(6n));
  assert.equal(page.draft_text(), closed);
  assert.deepEqual(JSON.parse(page.project(7n, 0, 26)).links, []);
  await apply(page.redo(7n));
  assert.equal(JSON.parse(page.inspect_link(8n, 1, 2)).destination, destination);
  const saved = page.draft_text();
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen:next', root);
  page = getSession();
  assert.equal(page.draft_text(), saved);
  assert.equal(JSON.parse(page.project(revision, 0, 27)).text, shown);
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, destination);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'next' });
  await stop();
}

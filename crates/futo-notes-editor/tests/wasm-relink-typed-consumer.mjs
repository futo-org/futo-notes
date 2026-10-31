// Existing eligible typed origin across canonical relink in compiled WASM.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function relinkTypedConsumer(options) {
  for (const partial of [false, true]) await typedRelinkStory(options, partial);
}

async function typedRelinkStory({ start, stop, getSession, createRoot, parseSource }, partial) {
  const suffix = partial ? '.' : '';
  const continuation = partial ? 'next' : '';
  const old = `<www.x.test/[[plain]]/path${suffix}`;
  const renamed = `<www.x.test/[[next]]/path${suffix}`;
  const completedWord = `www.x.test/[[next]]/path${partial ? '.next' : ''}`;
  const destination = `http://${completedWord}`;
  for (const word of [old.slice(1), renamed.slice(1)]) {
    const canonical = parseSource(word);
    const literal = parseSource(`<${word}`);
    try {
      const inspected = JSON.parse(canonical.inspect_link(0n, 0, 1));
      assert.deepEqual(inspected.range, {
        start: 0,
        end: Buffer.byteLength(word) - (partial ? 1 : 0),
      });
      assert.equal(inspected.destination, `http://${partial ? word.slice(0, -1) : word}`);
      const loaded = JSON.parse(literal.project(0n, 0, Buffer.byteLength(word) + 1));
      assert.equal(loaded.text, `<${word}`);
      assert.deepEqual(loaded.links, []);
    } finally {
      canonical.free();
      literal.free();
    }
  }
  const completed = parseSource(completedWord);
  try {
    const link = JSON.parse(completed.inspect_link(0n, 0, 1));
    assert.deepEqual(link.range, { start: 0, end: Buffer.byteLength(completedWord) });
    assert.equal(link.destination, destination);
  } finally {
    completed.free();
  }
  const root = createRoot(`futo-editor-wasm-relink-typed-${partial}-`);
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
  await apply(page.replace(0n, 0, 0, old));
  assert.equal(page.draft_text(), old);
  assert.deepEqual(JSON.parse(page.project(1n, 0, Buffer.byteLength(old))).links, []);
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
  assert.deepEqual(JSON.parse(page.project(2n, 0, Buffer.byteLength(renamed))).links, []);
  await apply(page.undo(2n));
  assert.equal(shown, '');
  assert.equal(page.draft_text(), '');
  await apply(page.redo(3n));
  assert.equal(shown, renamed);
  assert.equal(page.draft_text(), renamed);
  assert.deepEqual(JSON.parse(page.project(revision, 0, Buffer.byteLength(renamed))).links, []);
  if (continuation) {
    const at = Buffer.byteLength(renamed);
    await apply(page.replace(revision, at, at, continuation));
    assert.equal(shown, `<${completedWord}`);
    assert.deepEqual(JSON.parse(page.project(revision, 0, Buffer.byteLength(shown))).links, []);
  }
  const end = Buffer.byteLength(shown);
  await apply(page.replace(revision, end, end, '>'));
  assert.equal(shown, `<${completedWord}>`);
  assert.deepEqual(JSON.parse(page.project(revision, 0, end + 1)).links, []);
  const closed = page.draft_text();
  // Actual caret excursion separates Typing actions without a clock assumption.
  page.select_with_affinity(revision, 0, 0, '"Forward"');
  page.select_with_affinity(revision, end + 1, end + 1, '"Forward"');
  await apply(page.replace(revision, end + 1, end + 1, ' '));
  assert.equal(shown, `<${completedWord}> `);
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, destination);
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), closed);
  assert.deepEqual(JSON.parse(page.project(revision, 0, end + 1)).links, []);
  await apply(page.redo(revision));
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, destination);
  const saved = page.draft_text();
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen:next', root);
  page = getSession();
  assert.equal(page.draft_text(), saved);
  assert.equal(JSON.parse(page.project(revision, 0, Buffer.byteLength(shown))).text, shown);
  assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, destination);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'next' });
  await stop();
}

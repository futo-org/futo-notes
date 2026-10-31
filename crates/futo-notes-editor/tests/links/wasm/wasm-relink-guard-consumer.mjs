// Canonical affected-URI relink through compiled WASM and the actual Store worker.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function relinkGuardConsumer({ start, stop, getSession, createRoot, parseSource }) {
  const oldSource = '<https\\://x.test/`[[plain]]`/path>';
  const newSource = '<https\\://x.test/`[[next]]`/path>';
  for (const [source, shown, end] of [
    [oldSource, '<https://x.test/[[plain]]/path>', 25],
    [newSource, '<https://x.test/[[next]]/path>', 24],
  ]) {
    const fresh = parseSource(source);
    try {
      const canonical = JSON.parse(fresh.project(0n, 0, Buffer.byteLength(shown)));
      assert.equal(canonical.text, shown);
      assert.deepEqual(canonical.links, []);
      assert.deepEqual(
        canonical.runs.filter((run) => run.formats.includes('Code')).map((run) => run.range),
        [{ start: 16, end }],
      );
    } finally {
      fresh.free();
    }
  }
  const root = createRoot('futo-editor-wasm-relink-guard-');
  let exchange = await start('', root);
  let page = getSession();
  let revision = 0n;
  let shown = '';
  const apply = async (request, reject = false) => {
    const before = JSON.parse(page.status());
    const displayed = shown;
    const draft = page.draft_text();
    assert.throws(() => page.project(revision, 0, Buffer.byteLength(shown)));
    if (reject) {
      // Transport rejection precedes Store acceptance; real Append/ShortWrite
      // and rejected Undo/Redo are separately proved at the Rust Store seam.
      const body = JSON.parse(request);
      const failed = JSON.stringify({
        token: body.token,
        sequence: body.sequence,
        accepted: before.accepted,
        durable: before.durable,
        paused: true,
        error: 'injected relink transport rejection',
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
    assert.equal(JSON.parse(page.project(revision, 0, Buffer.byteLength(shown))).text, shown);
  };
  await apply(page.replace(0n, 0, 0, '<https://x.test/[[plain]]/path'));
  await apply(page.replace(1n, 30, 30, '>'));
  page.select_with_affinity(2n, 16, 25, '"Backward"');
  await apply(page.toggle_format(2n, '"Code"'));
  assert.equal(page.draft_text(), oldSource);
  assert.deepEqual(JSON.parse(page.project(3n, 0, 31)).links, []);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  assert.deepEqual(await exchange(JSON.stringify({ rename: 'next' })), { id: 'next' });
  const offer = await exchange(page.flush());
  assert.ok(offer.relink);
  assert.equal(JSON.parse(page.acknowledge(JSON.stringify(offer))), null);
  const relink = page.apply_relink_offer();
  assert.equal(page.draft_text(), newSource);
  assert.equal(shown, '<https://x.test/[[plain]]/path>');
  await apply(relink, true);
  assert.equal(shown, '<https://x.test/[[next]]/path>');
  assert.equal(JSON.parse(page.acknowledge(JSON.stringify(offer))), null);
  const guarded = JSON.parse(page.project(4n, 0, 30));
  assert.deepEqual(guarded.links, []);
  assert.deepEqual(
    guarded.runs.filter((run) => run.formats.includes('Code')).map((run) => run.range),
    [{ start: 16, end: 24 }],
  );
  await apply(page.undo(revision));
  assert.equal(shown, '<https://x.test/[[next]]/path>');
  assert.deepEqual(JSON.parse(page.project(revision, 0, 30)).links, []);
  await apply(page.redo(revision));
  assert.equal(page.draft_text(), newSource);
  page.select_with_affinity(revision, 16, 24, '"Backward"');
  await apply(page.toggle_format(revision, '"Code"'));
  assert.deepEqual(JSON.parse(page.project(revision, 0, 30)).links, []);
  page.select_with_affinity(revision, 30, 30, '"Forward"');
  await apply(page.replace(revision, 30, 30, ' '));
  assert.equal(shown, '<https://x.test/[[next]]/path> ');
  assert.equal(
    JSON.parse(page.inspect_link(revision, 1, 2)).destination,
    'https://x.test/[[next]]/path',
  );
  const saved = page.draft_text();
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen:next', root);
  page = getSession();
  assert.equal(page.draft_text(), saved);
  assert.equal(JSON.parse(page.project(revision, 0, 31)).text, shown);
  assert.equal(
    JSON.parse(page.inspect_link(revision, 1, 2)).destination,
    'https://x.test/[[next]]/path',
  );
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'next' });
  await stop();
}

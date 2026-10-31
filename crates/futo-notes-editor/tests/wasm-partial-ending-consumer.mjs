// Partial canonical URL prefixes through compiled WASM and the actual Store worker.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function partialEndingConsumer({ start, stop, getSession, createRoot, parseSource }) {
  for (const [input, closed, candidate, destination, end] of [
    ['<https://x.test/a.', true, '<<https://x.test/a>.>', 'https://x.test/a', 17],
    ['<www.x.test/a.', true, '<[www.x.test/a](<http://www.x.test/a>).>', 'http://www.x.test/a', 13],
    ['<www.x.test/a.', false, '<[www.x.test/a](<http://www.x.test/a>).', 'http://www.x.test/a', 13],
  ]) {
    const word = `${input}${closed ? '>' : ''}`;
    const expected = { range: { start: 1, end }, destination, title: null };
    const canonical = parseSource(candidate);
    try {
      assert.equal(JSON.parse(canonical.project(0n, 0, Buffer.byteLength(word))).text, word);
      assert.deepEqual(JSON.parse(canonical.inspect_link(0n, 1, 2)), expected);
    } finally {
      canonical.free();
    }
    const root = createRoot('futo-editor-wasm-partial-ending-');
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
        // This rejects transport before real Store acceptance. Actual filesystem
        // Append/ShortWrite failures are covered by partial_ending.rs.
        const body = JSON.parse(request);
        const failed = JSON.stringify({
          token: body.token,
          sequence: body.sequence,
          accepted: before.accepted,
          durable: before.durable,
          paused: true,
          error: 'injected partial-ending transport rejection',
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
    await apply(page.replace(0n, 0, 0, input));
    assert.deepEqual(JSON.parse(page.project(revision, 0, Buffer.byteLength(input))).links, []);
    if (closed) {
      page.select_with_affinity(revision, 0, 0, '"Forward"');
      page.select_with_affinity(revision, input.length, input.length, '"Forward"');
      await apply(page.replace(revision, input.length, input.length, '>'), true);
      const fresh = parseSource(page.draft_text());
      try {
        assert.equal(JSON.parse(fresh.project(0n, 0, word.length)).text, word);
        assert.deepEqual(JSON.parse(fresh.inspect_link(0n, 1, 2)), expected);
      } finally {
        fresh.free();
      }
    }
    assert.equal(shown, word);
    const pending = page.draft_text();
    assert.deepEqual(JSON.parse(page.project(revision, 0, word.length)).links, []);
    page.select_with_affinity(revision, 0, 0, '"Forward"');
    page.select_with_affinity(revision, word.length, word.length, '"Forward"');
    await apply(page.replace(revision, word.length, word.length, ' '), true);
    assert.equal(shown, `${word} `);
    assert.deepEqual(JSON.parse(page.inspect_link(revision, 1, 2)), expected);
    const active = page.draft_text();
    const fresh = parseSource(active);
    try {
      assert.equal(JSON.parse(fresh.project(0n, 0, word.length + 1)).text, `${word} `);
      assert.deepEqual(JSON.parse(fresh.inspect_link(0n, 1, 2)), expected);
    } finally {
      fresh.free();
    }
    await apply(page.undo(revision), true);
    assert.equal(page.draft_text(), pending);
    assert.deepEqual(JSON.parse(page.project(revision, 0, word.length)).links, []);
    await apply(page.redo(revision), true);
    assert.equal(page.draft_text(), active);
    assert.deepEqual(JSON.parse(page.inspect_link(revision, 1, 2)), expected);
    await apply(page.undo(revision));
    assert.equal(page.draft_text(), pending);
    page.acknowledge(JSON.stringify(await exchange(page.flush())));
    await stop();
    exchange = await start('--reopen:plain', root);
    page = getSession();
    assert.equal(page.draft_text(), pending);
    assert.equal(JSON.parse(page.project(revision, 0, word.length)).text, word);
    assert.deepEqual(JSON.parse(page.inspect_link(revision, 1, 2)), closed ? expected : null);
    assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
  }
}

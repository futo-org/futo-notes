// Actual typed-origin transport, including host-ack gating and recovery.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function typedOriginConsumer({ start, stop, getSession, createRoot }) {
  for (const input of ['bulk', 'characters']) {
    for (const closed of [false, true]) {
      const root = createRoot(`futo-editor-wasm-www-${input}-${closed}-`);
      let exchange = await start('', root);
      let page = getSession();
      let shown = '';
      let revision = 0n;
      const apply = async (request, reject = false) => {
        const accepted = JSON.parse(page.status()).accepted;
        const before = shown;
        assert.equal(accepted, Number(revision));
        assert.throws(() => page.project(revision + 1n, 0, 0));
        if (reject) {
          const body = JSON.parse(request);
          const beforeStatus = JSON.parse(page.status());
          const draft = page.draft_text();
          const failed = JSON.stringify({
            token: body.token,
            sequence: body.sequence,
            accepted,
            durable: beforeStatus.durable,
            paused: true,
            error: 'injected transport rejection',
          });
          assert.equal(JSON.parse(page.acknowledge(failed)), null);
          assert.equal(JSON.parse(page.status()).accepted, accepted);
          assert.equal(JSON.parse(page.status()).displayed, beforeStatus.displayed);
          assert.equal(page.draft_text(), draft);
          assert.equal(shown, before);
          assert.equal(
            JSON.parse(page.acknowledge(JSON.stringify(await exchange(page.resume())))),
            null,
          );
          request = page.retry_pending();
          assert.equal(JSON.parse(page.acknowledge(failed)), null);
        }
        const ack = await exchange(request);
        assert.equal(JSON.parse(page.status()).accepted, accepted);
        assert.equal(shown, before);
        // A duplicated host request is accepted once and returns the same ack.
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
        return change;
      };
      const opening = '<www.x.test/path';
      if (input === 'bulk') {
        await apply(page.replace(revision, 0, 0, opening));
      } else {
        for (const ch of opening) {
          const at = Buffer.byteLength(shown);
          await apply(page.replace(revision, at, at, ch));
          assert.deepEqual(JSON.parse(page.project(revision, 0, at + 1)).links, []);
        }
      }
      assert.equal(shown, opening);
      assert.equal(page.draft_text(), opening);
      assert.deepEqual(JSON.parse(page.project(revision, 0, 16)).links, []);
      if (closed) {
        await apply(page.replace(revision, 16, 16, '>'), input === 'bulk');
        assert.equal(shown, '<www.x.test/path>');
        assert.equal(page.draft_text(), '<[www.x.test/path](<http://www.x.test/path>)>');
        assert.deepEqual(JSON.parse(page.project(revision, 0, 17)).links, []);
        // The same common owner survives partial Code and controlled Code-off;
        // WWW requires no extra scalar escape to carry that lifetime.
        page.select_with_affinity(revision, 11, 16, '"Forward"');
        await apply(page.toggle_format(revision, '"Code"'));
        const guarded = page.draft_text();
        const opaque = JSON.parse(page.project(revision, 0, 17));
        assert.deepEqual(opaque.links, []);
        assert.deepEqual(
          opaque.runs.filter((run) => run.formats.includes('Code')).map((run) => run.range),
          [{ start: 11, end: 16 }],
        );
        page.select_with_affinity(revision, 17, 17, '"Forward"');
        await apply(page.replace_utf16_action(revision, 17, 17, [32], '"Isolated"'));
        assert.deepEqual(JSON.parse(page.project(revision, 0, 18)).links, []);
        await apply(page.undo(revision));
        assert.equal(page.draft_text(), guarded);
        page.select_with_affinity(revision, 11, 16, '"Backward"');
        await apply(page.toggle_format(revision, '"Code"'));
        assert.deepEqual(JSON.parse(page.project(revision, 0, 17)).links, []);
      }
      const pending = page.draft_text();
      const end = Buffer.byteLength(shown);
      page.select_with_affinity(revision, 0, 0, '"Forward"');
      page.select_with_affinity(revision, end, end, '"Forward"');
      await apply(page.replace_utf16_action(revision, end, end, [32], '"Isolated"'), !closed);
      const active = JSON.parse(page.inspect_link(revision, 1, 2));
      assert.equal(active.destination, 'http://www.x.test/path');
      assert.deepEqual(active.range, { start: 1, end: 16 });
      assert.equal(shown, opening + (closed ? '> ' : ' '));
      const linked = page.draft_text();
      await apply(page.undo(revision));
      assert.equal(page.draft_text(), pending);
      assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)), null);
      await apply(page.redo(revision));
      assert.equal(page.draft_text(), linked);
      assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, active.destination);
      page.acknowledge(JSON.stringify(await exchange(page.flush())));
      await stop();
      exchange = await start('--reopen', root);
      page = getSession();
      assert.equal(page.draft_text(), linked);
      assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)).destination, active.destination);
      assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
      await stop();
    }
  }
  for (const closed of [false, true]) {
    const root = createRoot(`futo-editor-wasm-www-origin-recovery-${closed}-`);
    let exchange = await start('', root);
    let page = getSession();
    let revision = 0n;
    const apply = async (request) => {
      const change = JSON.parse(page.acknowledge(JSON.stringify(await exchange(request))));
      assert.ok(change);
      revision = BigInt(change.revision);
    };
    await apply(page.replace(revision, 0, 0, '<www.x.test/path'));
    if (closed) await apply(page.replace(revision, 16, 16, '>'));
    const source = page.draft_text();
    assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)), null);
    page.acknowledge(JSON.stringify(await exchange(page.flush())));
    await stop();
    exchange = await start('--reopen', root);
    page = getSession();
    assert.equal(page.draft_text(), source);
    if (closed) {
      assert.equal(
        JSON.parse(page.inspect_link(revision, 1, 2)).destination,
        'http://www.x.test/path',
      );
    } else {
      // The exact raw prefix is durable; its live typing origin is not.
      assert.equal(JSON.parse(page.inspect_link(revision, 1, 2)), null);
      await apply(page.replace(revision, 16, 16, '>'));
      await apply(page.replace_utf16_action(revision, 17, 17, [32], '"Isolated"'));
      const loaded = JSON.parse(page.project(revision, 0, 18));
      assert.equal(loaded.text, '<www.x.test/path> ');
      assert.deepEqual(loaded.links, []);
    }
    assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
    await stop();
  }
}

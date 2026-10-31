// Literal retirement through compiled session and the existing real Store worker.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function literalRetirementConsumer({
  start,
  stop,
  getSession,
  createRoot,
  parseSource,
}) {
  const candidate = parseSource('<>');
  try {
    const checked = JSON.parse(candidate.project(0n, 0, 2));
    assert.equal(checked.text, '<>');
    assert.deepEqual(checked.links, []);
    assert.ok(checked.runs.every((run) => run.formats.length === 0));
  } finally {
    candidate.free();
  }
  const root = createRoot('futo-editor-wasm-literal-retirement-');
  let exchange = await start('', root);
  let page = getSession();
  let revision = 0n;
  let shown = '';
  const apply = async (request, reject = false) => {
    const before = JSON.parse(page.status());
    const displayed = shown;
    const draft = page.draft_text();
    assert.equal(before.accepted, Number(revision));
    assert.throws(() => page.project(revision + 1n, 0, 0));
    if (reject) {
      // This is a transport refusal BEFORE real Store acceptance. Actual
      // Append/ShortWrite rejection is covered at the Rust Store public seam.
      const body = JSON.parse(request);
      const failed = JSON.stringify({
        token: body.token,
        sequence: body.sequence,
        accepted: before.accepted,
        durable: before.durable,
        paused: true,
        error: 'injected transport rejection',
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
    return change;
  };
  await apply(page.replace(revision, 0, 0, '<https://x.test/path'));
  await apply(page.replace(revision, 20, 20, '>'));
  page.select_with_affinity(revision, 1, 20, '"Backward"');
  await apply(page.toggle_format(revision, '"Code"'));
  const guarded = page.draft_text();
  assert.equal(shown, '<https://x.test/path>');
  assert.deepEqual(JSON.parse(page.project(revision, 0, 21)).links, []);
  const change = await apply(page.replace_utf16_action(revision, 1, 20, [], '"Isolated"'), true);
  assert.deepEqual(change.selection, { start: 1, end: 1 });
  assert.equal(shown, '<>');
  assert.equal(page.draft_text(), '<>');
  const literal = JSON.parse(page.project(revision, 0, 2));
  assert.deepEqual(literal.links, []);
  assert.ok(literal.runs.every((run) => run.formats.length === 0));
  await apply(page.undo(revision));
  assert.equal(page.draft_text(), guarded);
  assert.equal(shown, '<https://x.test/path>');
  assert.deepEqual(JSON.parse(page.project(revision, 0, 21)).links, []);
  await apply(page.redo(revision));
  assert.equal(page.draft_text(), '<>');
  assert.equal(shown, '<>');
  page.acknowledge(JSON.stringify(await exchange(page.flush())));
  await stop();
  exchange = await start('--reopen', root);
  page = getSession();
  assert.equal(page.draft_text(), '<>');
  await apply(page.replace_utf16_action(revision, 2, 2, [32], '"Typing"'));
  assert.equal(shown, '<> ');
  assert.deepEqual(JSON.parse(page.project(revision, 0, 3)).links, []);
  assert.deepEqual(await exchange(JSON.stringify({ checkpoint: true })), { id: 'plain' });
  await stop();
}
